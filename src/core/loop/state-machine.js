/**
 * loop/state-machine.js — State Management Engine
 * -----------------------------------------------
 * A small, explicit state machine for AgentLoop. Every legal move is
 * declared in STATE_TRANSITIONS; an illegal move throws
 * LoopError('INVALID_STATE_TRANSITION') rather than leaving `.current` in an
 * ambiguous place. Full history of every transition is kept for
 * debugging/audit (see docs/docs/LOOP.md → LoopStateMachine).
 *
 * Pure JavaScript (ES modules).
 */

import { LoopError } from './errors.js';

/**
 * Fixed set of states the State Management Engine can be in. A run only ever
 * moves along the edges declared in STATE_TRANSITIONS below — anything else
 * throws instead of silently corrupting loop state. See docs/LOOP.md → LoopState.
 *
 * The macro lifecycle a caller cares about is exactly:
 *   CREATED -> RUNNING -> AWAITING_TOOL_APPROVAL -> PAUSED -> RESUMED -> COMPLETED / FAILED
 * THINKING/ACTING/OBSERVING are the finer-grained execution phases *inside*
 * RUNNING (kept because step-by-step observability — logs, events, the
 * think->act->observe history assertions — depends on them), but every one
 * of the macro states above is a real, reachable, distinct state.
 */
export const LoopState = Object.freeze({
  CREATED: 'created',
  RUNNING: 'running',
  THINKING: 'thinking',
  ACTING: 'acting',
  AWAITING_TOOL_APPROVAL: 'awaiting_tool_approval',
  OBSERVING: 'observing',
  PAUSED: 'paused',
  RESUMED: 'resumed',
  COMPLETED: 'completed',
  FAILED: 'failed',
});

const STATE_TRANSITIONS = Object.freeze({
  created: ['running'],
  // 'acting' from 'running' is legal because a resumeWithApproval(checkpoint,
  // true) run enters ACT directly with its action already decided (no THINK),
  // and a fresh run() never takes this edge — it always goes running->thinking
  // first. Without it, the state machine would silently refuse to log the
  // acting/observing phases of an approved resume.
  running: ['thinking', 'acting', 'completed', 'failed', 'paused'],
  thinking: ['acting', 'awaiting_tool_approval', 'completed', 'failed', 'paused'],
  awaiting_tool_approval: ['acting', 'thinking', 'paused', 'failed', 'resumed'],
  acting: ['observing', 'failed'],
  observing: ['thinking', 'completed', 'failed', 'paused'],
  paused: ['resumed', 'created'],
  resumed: ['running'],
  completed: ['created', 'running'],
  failed: ['created', 'running'],
});

export class LoopStateMachine {
  constructor(initial = LoopState.CREATED) {
    this._current = initial;
    this._history = [{ from: null, to: initial, at: Date.now(), meta: {} }];
  }

  get current() {
    return this._current;
  }

  /** Full chronological transition log: [{from, to, at, meta}]. */
  getHistory() {
    return this._history.slice();
  }

  canTransition(to) {
    return (STATE_TRANSITIONS[this._current] || []).includes(to);
  }

  transition(to, meta = {}) {
    if (!Object.values(LoopState).includes(to)) {
      throw new LoopError(`Unknown loop state "${to}".`, 'INVALID_STATE');
    }
    if (!this.canTransition(to)) {
      throw new LoopError(`Invalid state transition: "${this._current}" -> "${to}".`, 'INVALID_STATE_TRANSITION');
    }
    const from = this._current;
    this._current = to;
    this._history.push({ from, to, at: Date.now(), meta });
    return this;
  }

  /** Hard reset (used by checkpoint/resume) — bypasses transition validation on purpose. */
  reset(to = LoopState.CREATED) {
    this._current = to;
    this._history = [{ from: null, to, at: Date.now(), meta: { reset: true } }];
    return this;
  }
}

/** Map a terminal run status to the macro loop state the machine should land in. */
export function statusToLoopState(status) {
  if (status === 'error' || status === 'aborted') return LoopState.FAILED;
  if (status === 'paused') return LoopState.PAUSED;
  if (status === 'awaiting_tool_approval') return LoopState.AWAITING_TOOL_APPROVAL;
  return LoopState.COMPLETED; // final, need_clarification, stopped, max_steps
}

export default LoopStateMachine;
