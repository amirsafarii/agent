/**
 * tools/verification.js — verification tools for ScrappyAi
 * ---------------------------------------------------------------------------
 * Automated verification tools for validating code, file state, command output,
 * and JSON schemas before task completion:
 *
 *   verify_file    assert file/dir existence, size, and contained text/regex
 *   verify_command assert command exit codes and stdout/stderr contents
 *   verify_json    assert valid JSON structure and top-level key presence
 *   verify_suite   run a batch suite of multiple file/command/json checks
 *
 * Pure JavaScript (ES modules).
 */

import { VerificationEngine, defaultVerificationEngine } from '../verification.js';
import { createLogger } from '../logger.js';

const log = createLogger('tools:verification');

/**
 * @param {Object} [opts]
 * @param {VerificationEngine} [opts.engine]
 * @param {string} [opts.rootDir]
 * @returns {Array<import('../tools.js').ToolDefinition>}
 */
export function createVerificationTools(opts = {}) {
  const engine = opts.engine || (opts.rootDir ? new VerificationEngine({ rootDir: opts.rootDir }) : defaultVerificationEngine);

  return [
    {
      name: 'verify_file',
      description: 'Verify file/directory existence, non-emptiness, or presence of required content/regex pattern.',
      parameters: {
        path: { type: 'string', description: 'Relative file or directory path in sandbox root', required: true },
        mustExist: { type: 'boolean', description: 'Whether the path must exist (default: true)', default: true },
        contains: { type: 'string', description: 'Substring that must exist in the file content' },
        regex: { type: 'string', description: 'Regex pattern that must match the file content' },
      },
      handler: async ({ path, mustExist, contains, regex }) => {
        log.info('verify_file', { path, mustExist, contains, regex });
        return await engine.verifyFile({ path, mustExist, contains, regex });
      },
    },
    {
      name: 'verify_command',
      description: 'Run a shell command and verify its exit code and stdout/stderr output against expected values.',
      parameters: {
        command: { type: 'string', description: 'Shell command to execute and verify', required: true },
        expectedExitCode: { type: 'number', description: 'Expected exit code (default: 0)', default: 0 },
        stdoutContains: { type: 'string', description: 'Expected substring in stdout' },
        stderrContains: { type: 'string', description: 'Expected substring in stderr' },
        timeoutMs: { type: 'number', description: 'Execution timeout in milliseconds' },
      },
      handler: async ({ command, expectedExitCode, stdoutContains, stderrContains, timeoutMs }) => {
        log.info('verify_command', { command, expectedExitCode });
        return await engine.verifyCommand({
          command,
          expectedExitCode,
          stdoutContains,
          stderrContains,
          timeoutMs,
        });
      },
    },
    {
      name: 'verify_json',
      description: 'Verify that a file or string is valid JSON and contains required top-level keys.',
      parameters: {
        path: { type: 'string', description: 'File path containing JSON to check' },
        jsonString: { type: 'string', description: 'Raw JSON string to check' },
        requiredKeys: { type: 'array', description: 'Array of top-level keys that must exist in the JSON object' },
      },
      handler: async ({ path, jsonString, requiredKeys }) => {
        log.info('verify_json', { path, requiredKeys });
        return await engine.verifyJson({ path, jsonString, requiredKeys });
      },
    },
    {
      name: 'verify_suite',
      description: 'Run a batch suite of multiple verification checks (file, command, json) in sequence.',
      parameters: {
        checks: {
          type: 'array',
          description: 'Array of check definition objects (with type: "file"|"command"|"json")',
          required: true,
        },
        stopOnFirstFailure: { type: 'boolean', description: 'Stop running remaining checks on first failure', default: false },
      },
      handler: async ({ checks, stopOnFirstFailure }) => {
        log.info('verify_suite', { count: Array.isArray(checks) ? checks.length : 0 });
        return await engine.runSuite({ checks, stopOnFirstFailure });
      },
    },
  ];
}
