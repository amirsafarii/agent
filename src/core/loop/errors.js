/**
 * loop/errors.js — LoopError
 * -----------------------------------------------
 * The single error type thrown by loop-internal validation (state machine,
 * stop-condition engine, action validation). Carries a stable machine-readable
 * `code` alongside the human message so callers can branch without string
 * matching.
 *
 * Pure JavaScript (ES modules).
 */

export class LoopError extends Error {
  constructor(message, code = 'LOOP_ERROR') {
    super(message);
    this.name = 'LoopError';
    this.code = code;
  }
}

export default LoopError;
