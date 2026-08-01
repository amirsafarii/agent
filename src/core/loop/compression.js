/**
 * loop/compression.js — tool-result compression + small shared helpers
 * -----------------------------------------------
 * The default compressor that shrinks a full tool result before it is
 * written into the token-budgeted ContextWindow (step memory always keeps
 * the untouched original), plus the tiny dependency-free utilities the loop
 * modules share (sleep, safe stringify, stable arg normalization, error
 * serialization).
 *
 * Pure JavaScript (ES modules).
 */

export const DEFAULT_COMPRESS_MAX_CHARS = 1500;

/**
 * Default tool-result compression written into ContextWindow (the
 * token-budgeted chat trace). Step memory always keeps the untouched
 * original — this only shrinks what gets sent back to the model.
 */
export function defaultCompressToolResult(result, { maxChars = DEFAULT_COMPRESS_MAX_CHARS } = {}) {
  if (!result || typeof result !== 'object') return result;
  const clone = { ...result };
  if (clone.ok && clone.data !== undefined) {
    clone.data = compressValue(clone.data, maxChars);
  }
  if (!clone.ok && typeof clone.error === 'string' && clone.error.length > maxChars) {
    clone.error = `${clone.error.slice(0, maxChars)}...[truncated ${clone.error.length - maxChars} chars]`;
  }
  return clone;
}

function compressValue(value, maxChars) {
  const asString = typeof value === 'string' ? value : safeStringify(value);
  if (asString.length <= maxChars) return value;
  const truncated = `${asString.slice(0, maxChars)}...[truncated ${asString.length - maxChars} chars, ${typeof value} result]`;
  return truncated;
}

export function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch (_err) {
    return String(value);
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Stable JSON serialization of tool args: object keys sorted recursively. */
export function normalizeArgs(args) {
  if (args === null || args === undefined) return '{}';
  try {
    return JSON.stringify(sortKeys(args));
  } catch (_err) {
    return String(args);
  }
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
    return out;
  }
  return value;
}

export function serializeError(err) {
  if (!err) return null;
  return { message: err.message, code: err.code, stack: err.stack };
}
