/**
 * tools/shell.js — shell command tools (exec / spawn / kill / which)
 * -----------------------------------------------
 * Four tools:
 *
 *   shell          run a command and wait for its exit (exec) — deliberately
 *                  conservative: no shell interpolation unless useShell:true,
 *                  hard timeout, output truncation, optional allowlist/denylist
 *   shell_spawn    start a background process (detached, stdio ignored),
 *                  returns its pid immediately for later shell_kill
 *   shell_kill     terminate a process by pid; by default only pids that
 *                  shell_spawn started (force:true lifts that) — gated by
 *                  the approval gate (requiresApproval:true)
 *   shell_which    resolve a binary to its absolute path via $PATH
 *
 * Pure JavaScript (ES modules).
 */

import { execa } from 'execa';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { access, constants as fsConstants } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { createLogger } from '../core/logger.js';

const log = createLogger('tools:shell');

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_OUTPUT = 8_000; // chars, per stream

/** pids started by shell_spawn in this process — { pid, command, startedAt } */
const spawnedRegistry = new Map();

/**
 * @param {Object} [opts]
 * @param {string} [opts.cwd] default working directory for every shell call
 * @param {string} [opts.sandboxRoot] if set, a `cwd` argument that escapes this root is rejected
 * @param {string[]} [opts.allow] if set, only these binaries may be run (first token of `command`)
 * @param {string[]} [opts.deny] binaries that are always rejected, checked before `allow`
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.maxOutputChars]
 * @returns {import('./registry.js').ToolDefinition}
 */
export function createShellTool(opts = {}) {
  const {
    cwd = process.cwd(),
    sandboxRoot = null,
    allow = null,
    deny = ['rm', 'shutdown', 'reboot', 'mkfs', 'dd'],
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxOutputChars = DEFAULT_MAX_OUTPUT,
  } = opts;

  return {
    name: 'shell',
    description:
      'Run a shell command and return its stdout/stderr/exit code. Command is split into ' +
      'binary + args (e.g. "ls -la /tmp") and executed directly, not through a shell, so ' +
      'metacharacters like && | > are treated as literal arguments unless you pass useShell:true.',
    parameters: {
      command: {
        type: 'string',
        required: true,
        description: 'Full command line, e.g. "git status" or "node script.js --flag".',
      },
      cwd: { type: 'string', description: 'Working directory override.' },
      timeoutMs: { type: 'number', description: 'Per-call timeout override.' },
      useShell: {
        type: 'boolean',
        description: 'Run through the system shell (enables pipes/redirection). Off by default.',
      },
    },
    timeoutMs: timeoutMs + 2_000, // registry-level guard slightly above execa's own timeout
    handler: async (args) => {
      const commandLine = String(args.command || '').trim();
      if (!commandLine) {
        throw shellError('Empty command.', 'EMPTY_COMMAND');
      }

      const [bin, ...rest] = splitCommand(commandLine);

      if (deny.includes(bin)) {
        throw shellError(`Binary "${bin}" is denied by shell tool policy.`, 'DENIED_BINARY');
      }
      if (Array.isArray(allow) && !allow.includes(bin)) {
        throw shellError(`Binary "${bin}" is not in the shell tool allowlist.`, 'NOT_ALLOWLISTED');
      }

      const runCwd = resolveRunCwd(args.cwd, cwd, sandboxRoot);
      const runTimeout = Number.isFinite(args.timeoutMs) ? args.timeoutMs : timeoutMs;
      const startedAt = Date.now();
      log.info('shell:start', { command: commandLine, cwd: runCwd, timeoutMs: runTimeout, useShell: !!args.useShell });

      try {
        const result = await execa(bin, rest, {
          cwd: runCwd,
          timeout: runTimeout,
          shell: !!args.useShell,
          reject: false, // never throw on non-zero exit — report it instead
          // Same spawn hygiene as the code/package tools: a nested
          // `node --test` silently no-ops if it inherits NODE_TEST_CONTEXT.
          env: cleanSpawnEnv(),
          extendEnv: false,
        });

        const output = {
          command: commandLine,
          exitCode: result.exitCode ?? null,
          timedOut: !!result.timedOut,
          stdout: truncate(result.stdout, maxOutputChars),
          stderr: truncate(result.stderr, maxOutputChars),
        };
        log.info('shell:done', {
          command: commandLine,
          durationMs: Date.now() - startedAt,
          exitCode: output.exitCode,
          timedOut: output.timedOut,
        });
        return output;
      } catch (err) {
        // execa still throws for spawn-level failures (e.g. ENOENT binary not found)
        log.error('shell:failed', {
          command: commandLine,
          durationMs: Date.now() - startedAt,
          error: err && err.message,
        });
        throw shellError(
          `Failed to run "${commandLine}": ${err && err.message ? err.message : err}`,
          err && err.code
        );
      }
    },
  };
}

/**
 * Start a long-running process in the background. Detached + stdio ignored,
 * so the tool returns instantly with a pid and the agent keeps going; the
 * process is tracked so shell_kill can target it later.
 * @param {Object} [opts] same policy knobs as createShellTool
 * @returns {import('./registry.js').ToolDefinition}
 */
export function createShellSpawnTool(opts = {}) {
  const {
    cwd = process.cwd(),
    sandboxRoot = null,
    allow = null,
    deny = ['rm', 'shutdown', 'reboot', 'mkfs', 'dd'],
  } = opts;

  return {
    name: 'shell_spawn',
    description:
      'Start a background process (detached, output not captured) and return its pid immediately. ' +
      'Use shell_kill to stop it later. Prefer the "shell" tool for short commands whose output you need.',
    parameters: {
      command: { type: 'string', required: true, description: 'Full command line, e.g. "node server.js --port 4000".' },
      cwd: { type: 'string', description: 'Working directory override.' },
    },
    handler: async (args) => {
      const commandLine = String(args.command || '').trim();
      if (!commandLine) throw shellError('Empty command.', 'EMPTY_COMMAND');
      const [bin, ...rest] = splitCommand(commandLine);
      if (deny.includes(bin)) throw shellError(`Binary "${bin}" is denied by shell tool policy.`, 'DENIED_BINARY');
      if (Array.isArray(allow) && !allow.includes(bin)) {
        throw shellError(`Binary "${bin}" is not in the shell tool allowlist.`, 'NOT_ALLOWLISTED');
      }
      const runCwd = resolveRunCwd(args.cwd, cwd, sandboxRoot);

      log.info('shell_spawn:start', { command: commandLine, cwd: runCwd });
      const child = spawn(bin, rest, { cwd: runCwd, detached: true, stdio: 'ignore', env: cleanSpawnEnv() });
      child.unref(); // let the agent process exit without waiting for the child
      spawnedRegistry.set(child.pid, { pid: child.pid, command: commandLine, startedAt: Date.now() });
      const output = { pid: child.pid, command: commandLine, cwd: runCwd, note: 'background process started; use shell_kill to stop it' };
      log.info('shell_spawn:done', { pid: child.pid, command: commandLine });
      return output;
    },
  };
}

/**
 * Kill a process by pid. By default only pids that shell_spawn started in
 * this process are accepted (tracked) — killing arbitrary pids needs
 * force:true and is gated by the approval gate regardless.
 * @returns {import('./registry.js').ToolDefinition}
 */
export function createShellKillTool() {
  return {
    name: 'shell_kill',
    description:
      'Terminate a process by pid (default signal SIGTERM). Only processes started by shell_spawn in ' +
      'this session are accepted unless force:true — pass force to kill any pid. Gated by tool approval.',
    parameters: {
      pid: { type: 'number', required: true, description: 'Process id to terminate.' },
      signal: { type: 'string', description: 'Signal name, e.g. SIGTERM (default), SIGKILL, SIGINT.' },
      force: { type: 'boolean', description: 'Allow killing a pid that shell_spawn did not start. Default false.' },
    },
    requiresApproval: true,
    handler: async (args) => {
      const pid = args.pid;
      const signal = args.signal || 'SIGTERM';
      if (!Number.isInteger(pid) || pid <= 0) throw shellError('A positive integer "pid" is required.', 'INVALID_PID');
      const tracked = spawnedRegistry.get(pid);
      if (!tracked && !args.force) {
        throw shellError(
          `pid ${pid} is not a process started by shell_spawn in this session (pass force:true to kill any pid).`,
          'NOT_TRACKED'
        );
      }
      try {
        process.kill(pid, signal);
        spawnedRegistry.delete(pid);
      } catch (err) {
        if (err.code === 'ESRCH') {
          spawnedRegistry.delete(pid);
          throw shellError(`No such process (pid ${pid}) — it already exited.`, 'PROCESS_NOT_FOUND');
        }
        throw shellError(`Failed to kill pid ${pid}: ${err.message}`, err.code || 'KILL_ERROR');
      }
      const output = { pid, signal, killed: true, command: tracked ? tracked.command : null };
      log.info('shell_kill:done', { pid, signal, command: tracked ? tracked.command : null });
      return output;
    },
  };
}

/**
 * Resolve a binary name to its absolute path via $PATH (no subprocess).
 * @returns {import('./registry.js').ToolDefinition}
 */
export function createShellWhichTool() {
  return {
    name: 'shell_which',
    description:
      'Resolve a command/binary name to its absolute path by scanning $PATH (like `which`). ' +
      'Returns found:false when the binary is not on PATH.',
    parameters: {
      command: { type: 'string', required: true, description: 'Binary name, e.g. "node", "python3", "git".' },
    },
    handler: async (args) => {
      const bin = String(args.command || '').trim();
      if (!bin) throw shellError('Empty command name.', 'EMPTY_COMMAND');
      if (bin.includes('/') || bin.includes('\\')) {
        // Absolute or relative path given: check it directly (within reason).
        const abs = path.resolve(bin);
        try {
          await access(abs, fsConstants.X_OK);
          return { command: bin, path: abs, found: true };
        } catch (_err) {
          return { command: bin, path: null, found: false };
        }
      }
      const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
      for (const dir of dirs) {
        const candidate = path.join(dir, bin);
        try {
          await access(candidate, fsConstants.X_OK);
          return { command: bin, path: candidate, found: true };
        } catch (_err) {
          // keep scanning
        }
      }
      return { command: bin, path: null, found: false };
    },
  };
}

/** Resolve working directory relative to sandbox root or default cwd, and enforce sandbox bounds. */
function resolveRunCwd(argsCwd, defaultCwd, sandboxRoot) {
  const base = sandboxRoot ? path.resolve(sandboxRoot) : path.resolve(defaultCwd);
  const resolved = argsCwd ? path.resolve(base, argsCwd) : base;

  if (sandboxRoot) {
    const root = path.resolve(sandboxRoot);
    const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
    if (resolved !== root && !resolved.startsWith(rootWithSep)) {
      throw shellError(`cwd "${argsCwd}" escapes sandbox root "${root}".`, 'CWD_ESCAPE');
    }
  }

  try {
    mkdirSync(resolved, { recursive: true });
  } catch (_err) {}

  return resolved;
}

export function splitCommand(commandLine) {
  // Minimal, dependency-free tokenizer: supports "quoted strings" and 'single quotes'.
  const tokens = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = re.exec(commandLine)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3]);
  }
  return tokens;
}

/**
 * Spawn-safe environment: Node's test runner sets NODE_TEST_CONTEXT in child
 * processes, and a nested `node --test` then refuses to actually run files
 * ("run() is being called recursively within a test file. skipping..."). The
 * agent may legitimately run inside such a process (tests, CI hooks), so the
 * spawned child must not inherit that marker.
 */
export function cleanSpawnEnv() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

export function truncate(str, max) {
  const s = str == null ? '' : String(str);
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n...[truncated ${s.length - max} chars]`;
}

function shellError(message, code) {
  const err = new Error(message);
  err.code = code || 'SHELL_ERROR';
  return err;
}

export default createShellTool;
