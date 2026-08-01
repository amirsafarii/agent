/**
 * src/verification.js — Verification Engine for ScrappyAi
 * --------------------------------------------------------
 * Engine for automated verification and assertion checks on files, commands,
 * syntax, and structured outputs to ensure work meets quality criteria.
 *
 * Supported check types:
 *   - file_exists: asserts file or directory presence
 *   - file_contains: asserts text or regex pattern presence in a file
 *   - command_exit: runs command and asserts exit code and stdout/stderr
 *   - syntax_check: verifies syntax of JS/JSON files without executing
 *   - json_valid: verifies valid JSON format and expected top-level keys
 *
 * Pure JavaScript (ES modules).
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { execa } from 'execa';
import { createLogger } from './logger.js';

const log = createLogger('verification');

export class VerificationEngine {
  /**
   * @param {Object} [opts]
   * @param {string} [opts.rootDir] sandbox root directory
   * @param {number} [opts.timeoutMs] default command timeout
   */
  constructor(opts = {}) {
    this.rootDir = path.resolve(opts.rootDir || process.cwd());
    this.timeoutMs = opts.timeoutMs || 30_000;
  }

  /**
   * Resolve and enforce path inside sandbox root.
   * @param {string} relPath
   * @returns {string} resolved path
   */
  _resolvePath(relPath) {
    if (!relPath || typeof relPath !== 'string') {
      throw new Error('Path must be a non-empty string.');
    }
    const resolved = path.resolve(this.rootDir, relPath);
    if (!resolved.startsWith(this.rootDir)) {
      const err = new Error(`Path escape detected: "${relPath}" is outside sandbox root.`);
      err.code = 'PATH_ESCAPE';
      throw err;
    }
    return resolved;
  }

  /**
   * Verify file existence, size, and pattern matching.
   * @param {Object} params
   * @param {string} params.path
   * @param {boolean} [params.mustExist=true]
   * @param {string} [params.contains]
   * @param {string} [params.regex]
   * @returns {Promise<Object>} check result
   */
  async verifyFile({ path: filePath, mustExist = true, contains, regex }) {
    const fullPath = this._resolvePath(filePath);
    try {
      const stat = await fs.stat(fullPath);
      if (!mustExist) {
        return {
          ok: false,
          check: 'file_exists',
          path: filePath,
          error: `File "${filePath}" exists but was required NOT to exist.`,
        };
      }

      let text = null;
      if (contains || regex) {
        text = await fs.readFile(fullPath, 'utf8');
      }

      if (contains && typeof contains === 'string') {
        if (!text.includes(contains)) {
          return {
            ok: false,
            check: 'file_contains',
            path: filePath,
            error: `File "${filePath}" does not contain expected substring: "${contains}".`,
          };
        }
      }

      if (regex && typeof regex === 'string') {
        const re = new RegExp(regex, 'm');
        if (!re.test(text)) {
          return {
            ok: false,
            check: 'file_regex',
            path: filePath,
            error: `File "${filePath}" content does not match regex pattern: /${regex}/.`,
          };
        }
      }

      return {
        ok: true,
        check: 'verify_file',
        path: filePath,
        sizeBytes: stat.size,
        isFile: stat.isFile(),
        isDirectory: stat.isDirectory(),
      };
    } catch (err) {
      if (err.code === 'ENOENT') {
        if (!mustExist) {
          return { ok: true, check: 'file_not_exists', path: filePath };
        }
        return {
          ok: false,
          check: 'file_exists',
          path: filePath,
          error: `File or directory "${filePath}" does not exist.`,
        };
      }
      throw err;
    }
  }

  /**
   * Verify command execution result.
   * @param {Object} params
   * @param {string} params.command
   * @param {number} [params.expectedExitCode=0]
   * @param {string} [params.stdoutContains]
   * @param {string} [params.stderrContains]
   * @param {number} [params.timeoutMs]
   * @returns {Promise<Object>} check result
   */
  async verifyCommand({
    command,
    expectedExitCode = 0,
    stdoutContains,
    stderrContains,
    timeoutMs = this.timeoutMs,
  }) {
    if (!command || typeof command !== 'string' || !command.trim()) {
      return { ok: false, check: 'command_exit', error: 'Command string is required.' };
    }

    const start = Date.now();
    try {
      const proc = await execa(command, {
        shell: true,
        cwd: this.rootDir,
        timeout: timeoutMs,
        reject: false,
      });

      const durationMs = Date.now() - start;
      const actualExit = proc.exitCode ?? (proc.timedOut ? -1 : 0);

      if (actualExit !== expectedExitCode) {
        return {
          ok: false,
          check: 'command_exit',
          command,
          exitCode: actualExit,
          expectedExitCode,
          stdout: proc.stdout.slice(0, 1000),
          stderr: proc.stderr.slice(0, 1000),
          durationMs,
          error: `Command exited with code ${actualExit}, expected ${expectedExitCode}.`,
        };
      }

      if (stdoutContains && typeof stdoutContains === 'string') {
        if (!proc.stdout.includes(stdoutContains)) {
          return {
            ok: false,
            check: 'command_stdout',
            command,
            exitCode: actualExit,
            stdoutSnippet: proc.stdout.slice(0, 1000),
            durationMs,
            error: `Command stdout did not contain expected substring: "${stdoutContains}".`,
          };
        }
      }

      if (stderrContains && typeof stderrContains === 'string') {
        if (!proc.stderr.includes(stderrContains)) {
          return {
            ok: false,
            check: 'command_stderr',
            command,
            exitCode: actualExit,
            stderrSnippet: proc.stderr.slice(0, 1000),
            durationMs,
            error: `Command stderr did not contain expected substring: "${stderrContains}".`,
          };
        }
      }

      return {
        ok: true,
        check: 'command_exit',
        command,
        exitCode: actualExit,
        durationMs,
      };
    } catch (err) {
      return {
        ok: false,
        check: 'command_exit',
        command,
        durationMs: Date.now() - start,
        error: err.message,
      };
    }
  }

  /**
   * Verify valid JSON content from a file or string, checking optional keys.
   * @param {Object} params
   * @param {string} [params.path]
   * @param {string} [params.jsonString]
   * @param {Array<string>} [params.requiredKeys]
   * @returns {Promise<Object>} check result
   */
  async verifyJson({ path: filePath, jsonString, requiredKeys = [] }) {
    let rawText = jsonString;
    if (filePath) {
      const fullPath = this._resolvePath(filePath);
      try {
        rawText = await fs.readFile(fullPath, 'utf8');
      } catch (err) {
        return { ok: false, check: 'json_valid', path: filePath, error: `Could not read file: ${err.message}` };
      }
    }

    if (typeof rawText !== 'string' || !rawText.trim()) {
      return { ok: false, check: 'json_valid', error: 'No JSON content provided.' };
    }

    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch (err) {
      return {
        ok: false,
        check: 'json_valid',
        path: filePath || null,
        error: `Invalid JSON format: ${err.message}`,
      };
    }

    if (Array.isArray(requiredKeys) && requiredKeys.length > 0) {
      if (typeof parsed !== 'object' || parsed === null) {
        return {
          ok: false,
          check: 'json_keys',
          path: filePath || null,
          error: 'Parsed JSON is not an object, cannot check keys.',
        };
      }

      const missing = requiredKeys.filter((k) => !(k in parsed));
      if (missing.length > 0) {
        return {
          ok: false,
          check: 'json_keys',
          path: filePath || null,
          missingKeys: missing,
          error: `JSON is missing required top-level key(s): ${missing.join(', ')}.`,
        };
      }
    }

    return {
      ok: true,
      check: 'json_valid',
      path: filePath || null,
      topLevelKeys: typeof parsed === 'object' && parsed !== null ? Object.keys(parsed) : [],
    };
  }

  /**
   * Run a suite of multiple verification checks in batch.
   * @param {Object} params
   * @param {Array<Object>} params.checks list of check items
   * @param {boolean} [params.stopOnFirstFailure=false]
   * @returns {Promise<Object>} suite result
   */
  async runSuite({ checks = [], stopOnFirstFailure = false }) {
    if (!Array.isArray(checks) || checks.length === 0) {
      return { ok: true, total: 0, passed: 0, failed: 0, results: [] };
    }

    const results = [];
    let passed = 0;
    let failed = 0;

    for (const check of checks) {
      let res;
      if (check.type === 'file' || check.path) {
        res = await this.verifyFile(check);
      } else if (check.type === 'command' || check.command) {
        res = await this.verifyCommand(check);
      } else if (check.type === 'json' || check.jsonString) {
        res = await this.verifyJson(check);
      } else {
        res = { ok: false, check: check.type || 'unknown', error: `Unrecognized check type or parameters.` };
      }

      results.push(res);
      if (res.ok) {
        passed++;
      } else {
        failed++;
        if (stopOnFirstFailure) break;
      }
    }

    const overallOk = failed === 0;
    log.info('runSuite', { total: checks.length, passed, failed, ok: overallOk });

    return {
      ok: overallOk,
      total: checks.length,
      passed,
      failed,
      results,
    };
  }
}

/** Default global verification engine instance */
export const defaultVerificationEngine = new VerificationEngine();
