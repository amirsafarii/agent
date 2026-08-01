/**
 * tools/shell.js — run a shell command via execa
 * -----------------------------------------------
 * Registers a "shell" tool on a ToolRegistry. Deliberately conservative
 * defaults: no shell interpolation (execa runs the binary directly, not
 * through /bin/sh, unless the caller passes shell:true explicitly), a hard
 * timeout, output truncation so one runaway command can't blow the context
 * window, and an optional allowlist/denylist for the binary itself.
 *
 * Pure JavaScript (ES modules).
 */

import { execa } from 'execa';
import { createLogger } from '../logger.js';

const log = createLogger('tools:shell');

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_OUTPUT = 8_000; // chars, per stream

/**
 * @param {Object} [opts]
 * @param {string} [opts.cwd] default working directory for every shell call
 * @param {string[]} [opts.allow] if set, only these binaries may be run (first token of `command`)
 * @param {string[]} [opts.deny] binaries that are always rejected, checked before `allow`
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.maxOutputChars]
 * @returns {import('../tools.js').ToolDefinition}
 */
export function createShellTool(opts = {}) {
  const {
    cwd = process.cwd(),
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

      const runCwd = args.cwd || cwd;
      const runTimeout = Number.isFinite(args.timeoutMs) ? args.timeoutMs : timeoutMs;
      const startedAt = Date.now();
      log.info('shell:start', { command: commandLine, cwd: runCwd, timeoutMs: runTimeout, useShell: !!args.useShell });

      try {
        const result = await execa(bin, rest, {
          cwd: runCwd,
          timeout: runTimeout,
          shell: !!args.useShell,
          reject: false, // never throw on non-zero exit — report it instead
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

function splitCommand(commandLine) {
  // Minimal, dependency-free tokenizer: supports "quoted strings" and 'single quotes'.
  const tokens = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = re.exec(commandLine)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3]);
  }
  return tokens;
}

function truncate(str, max) {
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
