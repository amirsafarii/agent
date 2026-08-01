/**
 * loop/stop-conditions.js — Stop Condition Engine
 * -----------------------------------------------
 * Every pre-think "should this run stop right now?" check (built-in and
 * custom) lives here as one named, prioritized, side-effect-free predicate
 * instead of scattered if-blocks. Lower priority number = checked first.
 * A condition returns:
 *   - falsy            -> no opinion, keep checking
 *   - true             -> stop, reason defaults to the condition's name
 *   - a string         -> stop, that string is the `reason`
 *   - {reason, status, message} -> stop with exact control over the result
 * See docs/LOOP.md → StopConditionEngine.
 *
 * Pure JavaScript (ES modules).
 */

import { createLogger } from '../logger.js';
import { LoopError } from './errors.js';

const log = createLogger('loop:stop-conditions');

export class StopConditionEngine {
  constructor() {
    this._conditions = []; // [{name, fn, priority}]
  }

  register(name, fn, { priority = 100 } = {}) {
    if (typeof name !== 'string' || !name.trim()) {
      throw new LoopError('StopConditionEngine.register() requires a non-empty string "name".', 'INVALID_STOP_CONDITION');
    }
    if (typeof fn !== 'function') {
      throw new LoopError(`Stop condition "${name}" must be a function.`, 'INVALID_STOP_CONDITION');
    }
    this._conditions = this._conditions.filter((c) => c.name !== name); // re-register replaces
    this._conditions.push({ name, fn, priority });
    this._conditions.sort((a, b) => a.priority - b.priority);
    return this;
  }

  unregister(name) {
    this._conditions = this._conditions.filter((c) => c.name !== name);
    return this;
  }

  list() {
    return this._conditions.map((c) => ({ name: c.name, priority: c.priority }));
  }

  /**
   * Evaluate every registered condition, in priority order, against `state`.
   * Stops at the first one that fires.
   * @returns {{name, reason, status, message}|null}
   */
  evaluate(state) {
    for (const { name, fn } of this._conditions) {
      let outcome;
      try {
        outcome = fn(state);
      } catch (err) {
        log.warn('stopCondition:threw', { name, error: err && err.message });
        outcome = null; // a broken custom condition must never crash the loop
      }
      if (!outcome) continue;
      if (outcome === true) {
        return { name, reason: name, status: 'stopped', message: `Stop condition "${name}" triggered.` };
      }
      if (typeof outcome === 'string') {
        return { name, reason: outcome, status: 'stopped', message: `Stop condition "${name}" triggered: ${outcome}` };
      }
      if (typeof outcome === 'object') {
        return {
          name,
          reason: outcome.reason || name,
          status: outcome.status || 'stopped',
          message: outcome.message || `Stop condition "${name}" triggered.`,
        };
      }
    }
    return null;
  }
}

/** Adapt a legacy `(state) => reason|null` stop condition to the Stop Condition Engine's richer contract. */
export function wrapLegacyStopCondition(fn) {
  return (state) => {
    let outcome;
    try {
      outcome = fn(state);
    } catch (err) {
      log.warn('stopCondition:legacy_failed', { error: err && err.message });
      return null;
    }
    return outcome || null;
  };
}

export default StopConditionEngine;
