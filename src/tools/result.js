/**
 * tools/result.js — standard ToolResult values
 * ----------------------------------------------
 * ToolRunner always returns one of these shapes. `toLegacyResult()` is kept
 * only at the compatibility boundary for the old `registry.execute()` API;
 * new code should use `registry.run()` / `ToolRunner.run()` directly.
 *
 * Pure JavaScript (ES modules).
 */

import { ToolErrorCode } from './errors.js';

export class ToolResult {
  constructor(value = {}) {
    this.ok = value.ok === true;
    if (this.ok) {
      this.data = value.data;
    } else {
      this.error = normalizeError(value.error, value.code, value.message);
      if (value.denied) this.denied = value.denied;
      if (value.errors) this.errors = value.errors;
    }
    this.meta = value.meta && typeof value.meta === 'object' ? { ...value.meta } : {};
  }

  static success(data, meta = {}) {
    return { ok: true, data, meta: { ...meta } };
  }

  static failure(code, message, meta = {}, extra = {}) {
    const resolvedCode = code || ToolErrorCode.FAILED;
    return {
      ok: false,
      error: {
        code: resolvedCode,
        message: String(message || 'Tool failed.'),
        retryable: isRetryableCode(resolvedCode),
      },
      meta: { ...meta },
      ...extra,
    };
  }
}

/**
 * Normalize a tool return value. A plain return value becomes `data`; an
 * explicit `{ok, data}`/`{ok:false,error}` value is respected. This lets old
 * and new tools return naturally while preserving the same runner contract.
 */
export function normalizeToolResult(value, meta = {}) {
  const baseMeta = value && value.meta && typeof value.meta === 'object'
    ? { ...value.meta, ...meta }
    : { ...meta };

  const standardFailure = value && typeof value === 'object' && value.ok === false
    && (Object.prototype.hasOwnProperty.call(value, 'error')
      || Object.prototype.hasOwnProperty.call(value, 'code')
      || Object.prototype.hasOwnProperty.call(value, 'message'));
  if (standardFailure) {
    const error = normalizeError(value.error, value.code, value.message);
    const result = {
      ok: false,
      error,
      meta: baseMeta,
    };
    if (value.denied) result.denied = value.denied;
    if (value.errors) result.errors = value.errors;
    if (value.details) result.details = value.details;
    return result;
  }

  const standardSuccess = value && typeof value === 'object' && value.ok === true
    && Object.prototype.hasOwnProperty.call(value, 'data')
    && Object.keys(value).every((key) => key === 'ok' || key === 'data' || key === 'meta');
  if (standardSuccess) {
    return {
      ok: true,
      data: value.data,
      meta: baseMeta,
    };
  }

  return { ok: true, data: value, meta: baseMeta };
}

/**
 * Convert a standard result for pre-1.1 callers. The compatibility shape is
 * intentionally not used by ToolRunner itself, so the new API can expose the
 * requested `{ error: { code, message } }` contract without breaking existing
 * integrations that use `result.error` as a string.
 */
export function toLegacyResult(result) {
  if (!result || typeof result !== 'object') return result;
  if (result.ok === true) {
    return {
      ...result,
      durationMs: result.meta?.durationMs ?? result.durationMs ?? 0,
    };
  }

  // Already in the old shape (useful when an external/custom registry is
  // injected into AgentLoop).
  if (typeof result.error === 'string') return result;

  const error = normalizeError(result.error, result.code, result.message);
  const code = legacyCode(error.code);
  return {
    ...result,
    error: error.message,
    code,
    durationMs: result.meta?.durationMs ?? result.durationMs ?? 0,
    errorInfo: { ...error, code },
  };
}

/** A safe message helper for logs, loop notices, and UI adapters. */
export function resultErrorMessage(result) {
  if (!result) return 'Tool failed.';
  if (typeof result.error === 'string') return result.error;
  return result.error?.message || result.message || 'Tool failed.';
}

function normalizeError(error, code, message) {
  const resolvedCode = error && typeof error === 'object'
    ? (error.code || code || ToolErrorCode.FAILED)
    : (code || ToolErrorCode.FAILED);
  const resolvedMessage = error && typeof error === 'object'
    ? String(error.message || message || 'Tool failed.')
    : String(error || message || 'Tool failed.');
  return {
    code: resolvedCode,
    message: resolvedMessage,
    retryable: isRetryableCode(resolvedCode),
    ...(error && typeof error === 'object' ? copyErrorDetails(error) : {}),
  };
}

function copyErrorDetails(error) {
  const out = {};
  for (const [key, value] of Object.entries(error)) {
    if (key !== 'code' && key !== 'message') out[key] = value;
  }
  return out;
}

function legacyCode(code) {
  if (code === ToolErrorCode.NOT_FOUND) return 'UNKNOWN_TOOL';
  if (code === ToolErrorCode.INVALID_INPUT) return 'VALIDATION_ERROR';
  if (code === ToolErrorCode.PERMISSION_DENIED) return 'PERMISSION_DENIED';
  return code;
}

function isRetryableCode(code) {
  return code === 'TOOL_EXECUTION_ERROR' || code === 'EXECUTION_ERROR';
}

export default ToolResult;
