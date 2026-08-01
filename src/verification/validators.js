/**
 * src/verification/validators.js — Core Validation Rules for Verification
 * --------------------------------------------------------------------------
 * Core validators for file state, command output, JSON structure, HTTP endpoints,
 * and background process checks.
 *
 * Pure JavaScript (ES modules).
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { execa } from 'execa';
import { createLogger } from '../logger.js';

const log = createLogger('verification:validators');

/**
 * Validate path resolution inside sandbox root.
 * @param {string} rootDir
 * @param {string} relPath
 * @returns {string} resolved path
 */
export function assertPathInSandbox(rootDir, relPath) {
  if (!relPath || typeof relPath !== 'string') {
    throw new Error('Path must be a non-empty string.');
  }

  const resolvedRoot = path.resolve(rootDir);

  // If relPath is already an absolute path inside resolvedRoot, normalize it
  let resolved;
  if (path.isAbsolute(relPath)) {
    resolved = path.resolve(relPath);
  } else {
    resolved = path.resolve(resolvedRoot, relPath);
  }

  if (!resolved.startsWith(resolvedRoot)) {
    const err = new Error(`Path escape detected: "${relPath}" is outside sandbox root "${resolvedRoot}".`);
    err.code = 'PATH_ESCAPE';
    throw err;
  }
  return resolved;
}

/**
 * File validator.
 * @param {Object} params
 * @param {string} params.rootDir
 * @param {string} params.path
 * @param {boolean} [params.mustExist=true]
 * @param {string} [params.contains]
 * @param {string} [params.regex]
 */
export async function validateFile({ rootDir = process.cwd(), path: filePath, mustExist = true, contains, regex }) {
  const fullPath = assertPathInSandbox(rootDir, filePath);
  try {
    const stat = await fs.stat(fullPath);
    if (!mustExist) {
      return { ok: false, rule: 'file_not_exists', path: filePath, error: `File "${filePath}" exists.` };
    }

    if (contains || regex) {
      const content = await fs.readFile(fullPath, 'utf8');
      if (contains && !content.includes(contains)) {
        return { ok: false, rule: 'file_contains', path: filePath, error: `Content missing substring: "${contains}".` };
      }
      if (regex && !new RegExp(regex, 'm').test(content)) {
        return { ok: false, rule: 'file_regex', path: filePath, error: `Content does not match regex: /${regex}/.` };
      }
    }

    return { ok: true, rule: 'file', path: filePath, size: stat.size };
  } catch (err) {
    if (err.code === 'ENOENT') {
      if (!mustExist) return { ok: true, rule: 'file_not_exists', path: filePath };
      return { ok: false, rule: 'file_exists', path: filePath, error: `File "${filePath}" does not exist.` };
    }
    throw err;
  }
}

/**
 * Command output validator.
 */
export async function validateCommand({
  rootDir = process.cwd(),
  command,
  expectedExitCode = 0,
  stdoutContains,
  stderrContains,
  timeoutMs = 30_000,
}) {
  if (!command || !command.trim()) return { ok: false, rule: 'command', error: 'Empty command.' };

  const start = Date.now();
  try {
    const proc = await execa(command, {
      shell: true,
      cwd: rootDir,
      timeout: timeoutMs,
      reject: false,
    });

    const durationMs = Date.now() - start;
    const actualExit = proc.exitCode ?? (proc.timedOut ? -1 : 0);

    if (actualExit !== expectedExitCode) {
      return {
        ok: false,
        rule: 'command_exit',
        command,
        exitCode: actualExit,
        expectedExitCode,
        stdoutSnippet: proc.stdout.slice(0, 1000),
        stderrSnippet: proc.stderr.slice(0, 1000),
        durationMs,
        error: `Command exited with code ${actualExit}, expected ${expectedExitCode}.`,
      };
    }

    if (stdoutContains && !proc.stdout.includes(stdoutContains)) {
      return {
        ok: false,
        rule: 'command_stdout',
        command,
        stdoutSnippet: proc.stdout.slice(0, 1000),
        durationMs,
        error: `Command stdout missing: "${stdoutContains}".`,
      };
    }

    if (stderrContains && !proc.stderr.includes(stderrContains)) {
      return {
        ok: false,
        rule: 'command_stderr',
        command,
        stderrSnippet: proc.stderr.slice(0, 1000),
        durationMs,
        error: `Command stderr missing: "${stderrContains}".`,
      };
    }

    return { ok: true, rule: 'command', command, exitCode: actualExit, durationMs };
  } catch (err) {
    return { ok: false, rule: 'command', command, error: err.message, durationMs: Date.now() - start };
  }
}

/**
 * JSON structure validator.
 */
export async function validateJson({ rootDir = process.cwd(), path: filePath, jsonString, requiredKeys = [] }) {
  let text = jsonString;
  if (filePath) {
    const fullPath = assertPathInSandbox(rootDir, filePath);
    try {
      text = await fs.readFile(fullPath, 'utf8');
    } catch (err) {
      return { ok: false, rule: 'json', path: filePath, error: `Could not read file: ${err.message}` };
    }
  }

  if (typeof text !== 'string' || !text.trim()) {
    return { ok: false, rule: 'json', error: 'Empty JSON content.' };
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { ok: false, rule: 'json_parse', error: `JSON parse error: ${err.message}` };
  }

  if (Array.isArray(requiredKeys) && requiredKeys.length > 0) {
    if (typeof parsed !== 'object' || parsed === null) {
      return { ok: false, rule: 'json_object', error: 'Parsed JSON is not an object.' };
    }
    const missing = requiredKeys.filter((k) => !(k in parsed));
    if (missing.length > 0) {
      return { ok: false, rule: 'json_keys', missingKeys: missing, error: `Missing keys: ${missing.join(', ')}.` };
    }
  }

  return { ok: true, rule: 'json', keys: typeof parsed === 'object' && parsed !== null ? Object.keys(parsed) : [] };
}
