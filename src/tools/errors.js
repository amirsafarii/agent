/**
 * tools/errors.js — stable tool error vocabulary
 * ------------------------------------------------
 * Tool implementations may throw normal Errors. The runner converts those
 * errors into this small, provider-independent error contract so callers do
 * not need to know which implementation produced the failure.
 *
 * Pure JavaScript (ES modules).
 */

/** Error codes understood by the ToolSystem itself. Tool-specific codes are also allowed. */
export const ToolErrorCode = Object.freeze({
  NOT_FOUND: 'TOOL_NOT_FOUND',
  DISABLED: 'TOOL_DISABLED',
  INVALID_INPUT: 'TOOL_INVALID_INPUT',
  PERMISSION_DENIED: 'TOOL_PERMISSION_DENIED',
  TIMEOUT: 'TOOL_TIMEOUT',
  FAILED: 'TOOL_FAILED',
  ABORTED: 'ABORTED',
});

// A plural alias is convenient for consumers that prefer constants named after
// the vocabulary in the public API.
export const ToolErrorCodes = ToolErrorCode;

/**
 * Structured error thrown by a Tool or by ToolRunner middleware.
 *
 * Tool authors can use either:
 *   throw new ToolError('not allowed', 'TOOL_PERMISSION_DENIED')
 * or the shorter `throw Object.assign(new Error(...), { code: ... })` form.
 */
export class ToolError extends Error {
  /**
   * @param {string} message
   * @param {string} [code=TOOL_FAILED]
   * @param {Object} [details]
   */
  constructor(message, code = ToolErrorCode.FAILED, details = {}) {
    super(String(message || 'Tool failed.'));
    this.name = 'ToolError';
    this.code = code;
    this.details = details && typeof details === 'object' ? { ...details } : {};
    if (Error.captureStackTrace) Error.captureStackTrace(this, ToolError);
  }
}

/** Return a ToolError without requiring callers to import the class. */
export function toolError(message, code = ToolErrorCode.FAILED, details = {}) {
  return new ToolError(message, code, details);
}

export default ToolError;
