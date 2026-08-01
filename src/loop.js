/**
 * loop.js — Agent Loop (think → act → observe)
 * -----------------------------------------------
 * The heart of ScrappyAi. Orchestrates ContextWindow + ToolRegistry around a
 * pluggable `reasoner` (the actual LLM call lives outside this file — inject
 * it, don't hardcode a provider). Each cycle is:
 *
 *   think    — reasoner(renderedContext, toolSchema) -> Action
 *   act      — if Action is a tool_call, execute it through the ToolRegistry,
 *              with bounded automatic retry on transient failures
 *   observe  — append a *compressed* tool result back into ContextWindow
 *              (token budget) and a *full* record into step memory (debugging/replay)
 *
 * Design goals: no vendor lock-in, deterministic step + time + token budget,
 * every step observable via events, structured step memory independent of
 * the chat-shaped ContextWindow, and a loop that fails loud with an explicit
 * termination reason rather than spinning silently forever.
 *
 * Full input/output schema for every function in this file: see LOOP.md.
 *
 * Pure JavaScript (ES modules). No TypeScript, no build step.
 */

import { createLogger } from './logger.js';
import { CheckpointManager } from './checkpoint-manager.js';

const log = createLogger('loop');

/** Every event AgentLoop can emit via the `onEvent(event, payload)` hook. */
export const LoopEvents = Object.freeze({
  STEP_START: 'step_start',
  THINK: 'think',
  ACT: 'act',
  TOOL_RETRY: 'tool_retry',
  OBSERVE: 'observe',
  FINAL: 'final',
  NEED_CLARIFICATION: 'need_clarification',
  ERROR: 'error',
  MAX_STEPS: 'max_steps_reached',
  TASK_TIMEOUT: 'task_timeout',
  MAX_TOKENS: 'max_tokens_exceeded',
  STUCK_LOOP: 'stuck_loop_detected',
  TOOL_FAILURE_EXHAUSTED: 'tool_failure_exhausted',
  PAUSED: 'paused',
  RESUMED: 'resumed',
  CHECKPOINT_CREATED: 'checkpoint_created',
  STATE_CHANGE: 'state_change',
  TOOL_APPROVAL_REQUESTED: 'tool_approval_requested',
  TOOL_APPROVAL_GRANTED: 'tool_approval_granted',
  TOOL_APPROVAL_REJECTED: 'tool_approval_rejected',
  LIFECYCLE_CREATED: 'lifecycle_created',
  LIFECYCLE_FAILED: 'lifecycle_failed',
});

/**
 * Fixed set of states the State Management Engine can be in. A run only ever
 * moves along the edges declared in STATE_TRANSITIONS below — anything else
 * throws instead of silently corrupting loop state. See LOOP.md → LoopState.
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

/**
 * State Management Engine — a small, explicit state machine for AgentLoop.
 * Every legal move is declared in STATE_TRANSITIONS; an illegal move throws
 * LoopError('INVALID_STATE_TRANSITION') rather than leaving `.current` in an
 * ambiguous place. Full history of every transition is kept for
 * debugging/audit (see LOOP.md → LoopStateMachine).
 */
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

function statusToLoopState(status) {
  if (status === 'error' || status === 'aborted') return LoopState.FAILED;
  if (status === 'paused') return LoopState.PAUSED;
  if (status === 'awaiting_tool_approval') return LoopState.AWAITING_TOOL_APPROVAL;
  return LoopState.COMPLETED; // final, need_clarification, stopped, max_steps
}

/**
 * Stop Condition Engine — every pre-think "should this run stop right now?"
 * check (built-in and custom) lives here as one named, prioritized,
 * side-effect-free predicate instead of scattered if-blocks. Lower priority
 * number = checked first. A condition returns:
 *   - falsy            -> no opinion, keep checking
 *   - true             -> stop, reason defaults to the condition's name
 *   - a string         -> stop, that string is the `reason`
 *   - {reason, status, message} -> stop with exact control over the result
 * See LOOP.md → StopConditionEngine.
 */
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

/**
 * Fixed, exhaustive set of reasons a run() can end. Every terminal return
 * carries exactly one of these in `reason` — never a free-text guess.
 */
export const TerminationReason = Object.freeze({
  FINAL_ANSWER: 'final_answer',
  NEED_CLARIFICATION: 'need_clarification',
  MAX_STEPS: 'max_steps_reached',
  TASK_TIMEOUT: 'task_timeout',
  MAX_TOKENS: 'max_tokens_exceeded',
  STUCK_LOOP: 'stuck_loop_detected',
  TOOL_FAILURE_EXHAUSTED: 'tool_failure_exhausted',
  ABORTED: 'aborted_by_signal',
  THINK_ERROR: 'think_phase_error',
  INVALID_ACTION: 'invalid_action',
  PAUSED: 'paused_by_request',
  AWAITING_TOOL_APPROVAL: 'awaiting_tool_approval',
});

/** Fixed set of Action `type` values a reasoner is allowed to return. */
export const ActionType = Object.freeze({
  TOOL_CALL: 'tool_call',
  FINAL: 'final',
  NEED_CLARIFICATION: 'need_clarification',
});

const DEFAULT_TOOL_RETRY = Object.freeze({
  retries: 2,
  backoffMs: 250,
  factor: 2,
  retryableCodes: ['TOOL_TIMEOUT', 'TOOL_EXECUTION_ERROR', 'EXECUTION_ERROR', 'TIMEOUT'],
});

const DEFAULT_MAX_TASK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes wall clock per run()
const DEFAULT_COMPRESS_MAX_CHARS = 1500;
const DEFAULT_MAX_CONSECUTIVE_TOOL_EXHAUSTION = 2;

export class LoopError extends Error {
  constructor(message, code = 'LOOP_ERROR') {
    super(message);
    this.name = 'LoopError';
    this.code = code;
  }
}

export class AgentLoop {
  /**
   * @param {Object} opts
   * @param {import('./context.js').ContextWindow} opts.context
   * @param {import('./tools.js').ToolRegistry} opts.tools
   * @param {Function} opts.reasoner - async (renderedContext, toolSchema) => Action. See ActionType/LOOP.md.
   * @param {number} [opts.maxSteps=12] Hard ceiling on think/act/observe cycles per run.
   * @param {number} [opts.maxRepeatedToolCalls=3] Abort if the same tool+args repeats this many times in a row.
   * @param {number} [opts.maxTaskTimeoutMs=300000] Wall-clock ceiling for one run() call, independent of maxSteps.
   * @param {Object} [opts.toolRetry] Default retry policy for tool_call actions; per-action override via action.retry.
   * @param {number} [opts.toolRetry.retries=2]
   * @param {number} [opts.toolRetry.backoffMs=250] base backoff, doubled (`factor`) per attempt.
   * @param {number} [opts.toolRetry.factor=2]
   * @param {string[]} [opts.toolRetry.retryableCodes] tool error codes worth retrying; anything else fails fast.
   * @param {number} [opts.maxConsecutiveToolExhaustion=2] Stop the run if this many tool_calls in a row exhaust all retries.
   * @param {number} [opts.compressMaxChars=1500] Tool result char budget written into ContextWindow (full result kept in step memory).
   * @param {Function} [opts.compressToolResult] Override compression: (result, {maxChars}) => compressedResult.
   * @param {Array<Function>} [opts.stopConditions] Legacy custom checks: (state) => reason string | null, run each
   *        step before think, wrapped into the Stop Condition Engine as `custom_stop_0`, `custom_stop_1`, ... .
   *        `state` is `{ step, elapsedMs, context, stepMemory, signal }`. Returning a string ends the run with
   *        that string as `reason` (status becomes `'stopped'`).
   * @param {Object<string, Function>} [opts.namedStopConditions] Same shape as a single stopConditions entry, but
   *        registered under the given name (so you can .unregister()/inspect it later via `loop.stopEngine`).
   * @param {string[]|'*'} [opts.requireApprovalFor=[]] Tool names that must go through the
   *        AWAITING_TOOL_APPROVAL gate before executing; `'*'` gates every tool_call. A tool
   *        definition's own `requiresApproval: true` (see tools.js) also gates it, OR'd with this list.
   * @param {Function} [opts.onToolApproval] Optional async (request) => boolean | {approved, reason}
   *        hook, where request = {tool, args, reasoning, step}. When provided, a gated tool_call is
   *        decided automatically (no pause). When omitted, a gated tool_call PAUSES the run with
   *        status 'awaiting_tool_approval' and a `checkpoint.pendingApproval` — resume the decision
   *        later via `loop.resumeWithApproval(checkpoint, approved, opts)`.
   * @param {Object} [opts.lifecycleHooks] Optional callbacks fired exactly once per macro-lifecycle
   *        entry: onCreated, onRunning, onAwaitingToolApproval, onPaused, onResumed, onCompleted,
   *        onFailed — each `(payload) => void`, called synchronously right after the state machine
   *        moves into that state. A throwing hook is logged and swallowed, never breaks the loop.
   * @param {CheckpointManager} [opts.checkpointManager] Reuse an existing manager (e.g. shared across
   *        several AgentLoop instances) instead of the private one created automatically.
   * @param {string} [opts.checkpointDir] Convenience: persist this loop's checkpoints to disk under
   *        this directory (passed straight to `new CheckpointManager({ dir })`) when no
   *        `checkpointManager` override is given.
   * @param {Function} [opts.onEvent] - (event, payload) => void observability hook.
   */
  constructor({
    context,
    tools,
    reasoner,
    maxSteps = 12,
    maxRepeatedToolCalls = 3,
    maxTaskTimeoutMs = DEFAULT_MAX_TASK_TIMEOUT_MS,
    toolRetry = {},
    maxConsecutiveToolExhaustion = DEFAULT_MAX_CONSECUTIVE_TOOL_EXHAUSTION,
    compressMaxChars = DEFAULT_COMPRESS_MAX_CHARS,
    compressToolResult,
    stopConditions = [],
    namedStopConditions = {},
    requireApprovalFor = [],
    onToolApproval,
    lifecycleHooks = {},
    checkpointManager,
    checkpointDir,
    onEvent,
  } = {}) {
    if (!context) throw new LoopError('AgentLoop requires a ContextWindow instance ("context").');
    if (!tools) throw new LoopError('AgentLoop requires a ToolRegistry instance ("tools").');
    if (typeof reasoner !== 'function') throw new LoopError('AgentLoop requires a "reasoner" function.');

    this.context = context;
    this.tools = tools;
    this.reasoner = reasoner;
    this.maxSteps = maxSteps;
    this.maxRepeatedToolCalls = maxRepeatedToolCalls;
    this.maxTaskTimeoutMs = maxTaskTimeoutMs;
    this.toolRetry = { ...DEFAULT_TOOL_RETRY, ...toolRetry };
    this.maxConsecutiveToolExhaustion = maxConsecutiveToolExhaustion;
    this.compressMaxChars = compressMaxChars;
    this.compressToolResult = compressToolResult || defaultCompressToolResult;
    this.requireApprovalFor = requireApprovalFor;
    this.onToolApproval = typeof onToolApproval === 'function' ? onToolApproval : null;
    this.lifecycleHooks = lifecycleHooks || {};
    this.onEvent = onEvent || (() => {});

    this._toolCallHistory = []; // recent tool_call fingerprints, for stuck-loop detection
    this._stepMemory = []; // structured, non-chat record of every step — see LOOP.md StepRecord
    this._consecutiveToolExhaustion = 0;
    this._pauseRequested = false;
    this._currentStep = 0;
    this._lastStartedAt = Date.now();

    // --- Checkpoint Manager ------------------------------------------------
    // Every checkpoint() call is also handed to this manager so a caller can
    // list/retrieve ANY past checkpoint by id, not just the latest one.
    this.checkpoints = checkpointManager || new CheckpointManager({ dir: checkpointDir });

    // --- State Management Engine -----------------------------------------
    this.state = new LoopStateMachine();
    this._fireLifecycleHook('onCreated', { state: this.state.current });

    // --- Stop Condition Engine --------------------------------------------
    // Built-ins run first (priority < 100); legacy `stopConditions` array and
    // `namedStopConditions` map run after, in the order given.
    this.stopEngine = new StopConditionEngine();
    this.stopEngine.register(
      'pause_requested',
      () => {
        if (!this._pauseRequested) return null;
        this._pauseRequested = false;
        return { reason: TerminationReason.PAUSED, status: 'paused', message: 'Run paused by request (loop.pause()).' };
      },
      { priority: -10 }
    );
    this.stopEngine.register(
      'abort_signal',
      ({ signal }) => {
        if (signal && signal.aborted) {
          return { reason: TerminationReason.ABORTED, status: 'aborted', message: 'Run aborted via AbortSignal.' };
        }
        return null;
      },
      { priority: 0 }
    );
    this.stopEngine.register(
      'task_timeout',
      ({ elapsedMs }) => {
        if (elapsedMs >= this.maxTaskTimeoutMs) {
          return {
            reason: TerminationReason.TASK_TIMEOUT,
            status: 'error',
            message: `Task exceeded maxTaskTimeoutMs (${this.maxTaskTimeoutMs}ms) after ${elapsedMs}ms.`,
          };
        }
        return null;
      },
      { priority: 10 }
    );
    this.stopEngine.register(
      'max_tokens',
      () => {
        // ContextWindow self-compacts on append(), but if it's *still* over budget
        // afterwards (e.g. keepRecent alone exceeds maxTokens), compaction can't
        // fix it — stop cleanly instead of sending an oversized/rejected payload.
        if (this.context.maxTokens > 0 && this.context.usedTokens > this.context.maxTokens) {
          return {
            reason: TerminationReason.MAX_TOKENS,
            status: 'error',
            message: `Context window still over budget after compaction (${this.context.usedTokens}/${this.context.maxTokens} tokens).`,
          };
        }
        return null;
      },
      { priority: 20 }
    );
    (Array.isArray(stopConditions) ? stopConditions : []).forEach((fn, i) => {
      this.stopEngine.register(fn.name || `custom_stop_${i}`, wrapLegacyStopCondition(fn), { priority: 100 + i });
    });
    Object.entries(namedStopConditions || {}).forEach(([name, fn]) => {
      this.stopEngine.register(name, wrapLegacyStopCondition(fn), { priority: 100 });
    });
  }

  _emit(event, payload) {
    try {
      this.onEvent(event, payload);
    } catch (_err) {
      // observability must never break the loop
    }
  }

  /** Fixed map from a macro LoopState to the lifecycleHooks key fired on entry. */
  static get LIFECYCLE_HOOK_NAMES() {
    return {
      [LoopState.CREATED]: 'onCreated',
      [LoopState.RUNNING]: 'onRunning',
      [LoopState.AWAITING_TOOL_APPROVAL]: 'onAwaitingToolApproval',
      [LoopState.PAUSED]: 'onPaused',
      [LoopState.RESUMED]: 'onResumed',
      [LoopState.COMPLETED]: 'onCompleted',
      [LoopState.FAILED]: 'onFailed',
    };
  }

  /** Invoke a named lifecycle hook if the caller registered one. Never throws into the loop. */
  _fireLifecycleHook(name, payload) {
    const hook = this.lifecycleHooks && this.lifecycleHooks[name];
    if (typeof hook !== 'function') return;
    try {
      hook(payload);
    } catch (err) {
      log.warn('lifecycle:hook_failed', { hook: name, error: err && err.message });
    }
  }

  /** Move the state machine forward; a bad transition is logged, never thrown into the loop. */
  _safeTransition(to, meta = {}) {
    try {
      this.state.transition(to, meta);
      this._emit(LoopEvents.STATE_CHANGE, { to, meta, history: this.state.getHistory().slice(-1)[0] });
      const hookName = AgentLoop.LIFECYCLE_HOOK_NAMES[to];
      if (hookName) this._fireLifecycleHook(hookName, { state: to, meta, step: this._currentStep });
    } catch (err) {
      log.warn('state:invalid_transition', { to, current: this.state.current, error: err.message });
    }
  }

  /**
   * Whether a tool_call to `toolName` must go through the AWAITING_TOOL_APPROVAL
   * gate: either this loop's `requireApprovalFor` says so, or the tool's own
   * definition (`requiresApproval: true`, see tools.js) does.
   */
  _requiresApproval(toolName) {
    if (this.requireApprovalFor === '*') return true;
    if (Array.isArray(this.requireApprovalFor) && this.requireApprovalFor.includes(toolName)) return true;
    const def = typeof this.tools.get === 'function' ? this.tools.get(toolName) : null;
    return !!(def && def.requiresApproval);
  }

  /** Current state (see LoopState). */
  getState() {
    return this.state.current;
  }

  /** Full chronological state transition log. */
  getStateHistory() {
    return this.state.getHistory();
  }

  /**
   * Request a cooperative pause. Checked at the next step boundary (between
   * observe and the next think) — never mid-tool-call. The run then returns
   * with status 'paused' and a `checkpoint` you can hand to resume() later.
   */
  pause() {
    this._pauseRequested = true;
    return this;
  }

  /**
   * Snapshot everything needed to continue this run later: full ContextWindow
   * state, step memory, tool-call history (for stuck-loop detection), the
   * consecutive-tool-exhaustion counter, and how many ms of the task timeout
   * budget have already been spent. See LOOP.md → Checkpoint.
   */
  checkpoint(meta = {}) {
    const step = meta.step ?? this._currentStep ?? 0;
    const elapsedMs = meta.elapsedMs ?? Math.max(0, Date.now() - this._lastStartedAt);
    const snapshot = {
      version: 1,
      createdAt: Date.now(),
      step,
      elapsedMs,
      toolCallHistory: this._toolCallHistory.slice(),
      stepMemory: this.getStepMemory(),
      consecutiveToolExhaustion: this._consecutiveToolExhaustion,
      context: this.context.toJSON(),
      state: this.state.current,
      pendingApproval: meta.pendingApproval || null,
    };
    // Fire-and-forget: the CheckpointManager index is best-effort convenience
    // (list/get-by-id later); a slow/broken disk write must never block or
    // fail the loop, so we don't await this here.
    this.checkpoints.save(snapshot, { reason: meta.reason }).catch(() => {});
    this._emit(LoopEvents.CHECKPOINT_CREATED, { step, elapsedMs, pendingApproval: !!snapshot.pendingApproval });
    return snapshot;
  }

  /**
   * Resume a run from a checkpoint on THIS instance (context/tools/reasoner
   * stay whatever they already are — restore only overwrites their content).
   * Step numbering and the task-timeout clock both continue from where the
   * checkpoint left off; maxSteps/maxTaskTimeoutMs are NOT reset.
   * @param {Object} checkpointObj - see LOOP.md → Checkpoint.
   * @param {{additionalInput?: string, signal?: AbortSignal}} [runOpts]
   * @returns {Promise<LoopResult>}
   */
  async resume(checkpointObj, runOpts = {}) {
    if (!checkpointObj || typeof checkpointObj !== 'object' || !checkpointObj.context) {
      throw new LoopError('resume() requires a valid checkpoint object (see checkpoint()/LOOP.md).', 'INVALID_CHECKPOINT');
    }
    if (checkpointObj.pendingApproval) {
      throw new LoopError(
        'This checkpoint has a pendingApproval (status was "awaiting_tool_approval") — use resumeWithApproval(checkpoint, approved) instead of resume().',
        'PENDING_APPROVAL'
      );
    }
    this._restoreFromCheckpoint(checkpointObj);
    this.state.reset(LoopState.PAUSED);
    this._emit(LoopEvents.RESUMED, { fromStep: checkpointObj.step, elapsedMs: checkpointObj.elapsedMs });
    log.info('run:resume', { fromStep: checkpointObj.step, elapsedMs: checkpointObj.elapsedMs });
    return this._execute({
      userInput: runOpts.additionalInput ?? null,
      runOpts,
      resumeFrom: { step: checkpointObj.step || 0, elapsedMs: checkpointObj.elapsedMs || 0 },
    });
  }

  /**
   * Resolve a pending human-in-the-loop tool approval captured by a
   * status:'awaiting_tool_approval' result (checkpoint.pendingApproval) and
   * continue the run. If `approved` is false, the gated tool_call is
   * recorded as rejected and the run continues to the next THINK instead of
   * executing it. See LOOP.md → Tool Approval.
   * @param {Object} checkpointObj - a checkpoint whose `pendingApproval` is set.
   * @param {boolean} approved
   * @param {{additionalInput?: string, reason?: string, signal?: AbortSignal}} [runOpts]
   * @returns {Promise<LoopResult>}
   */
  async resumeWithApproval(checkpointObj, approved, runOpts = {}) {
    if (!checkpointObj || typeof checkpointObj !== 'object' || !checkpointObj.pendingApproval) {
      throw new LoopError(
        'resumeWithApproval() requires a checkpoint with a pendingApproval (from an "awaiting_tool_approval" result).',
        'INVALID_CHECKPOINT'
      );
    }
    this._restoreFromCheckpoint(checkpointObj);
    this.state.reset(LoopState.AWAITING_TOOL_APPROVAL);
    this._emit(LoopEvents.RESUMED, { fromStep: checkpointObj.step, elapsedMs: checkpointObj.elapsedMs, approved: !!approved });
    log.info('run:resume_with_approval', { fromStep: checkpointObj.step, tool: checkpointObj.pendingApproval.tool, approved: !!approved });
    return this._execute({
      userInput: runOpts.additionalInput ?? null,
      runOpts,
      resumeFrom: {
        step: checkpointObj.step || 0,
        elapsedMs: checkpointObj.elapsedMs || 0,
        pendingApproval: checkpointObj.pendingApproval,
        approved: !!approved,
        rejectReason: runOpts.reason,
      },
    });
  }

  /** Shared restore-from-checkpoint plumbing used by resume()/resumeWithApproval(). */
  _restoreFromCheckpoint(checkpointObj) {
    this.context.restore(checkpointObj.context);
    this._stepMemory = Array.isArray(checkpointObj.stepMemory) ? checkpointObj.stepMemory.slice() : [];
    this._toolCallHistory = Array.isArray(checkpointObj.toolCallHistory) ? checkpointObj.toolCallHistory.slice() : [];
    this._consecutiveToolExhaustion = checkpointObj.consecutiveToolExhaustion || 0;
    this._pauseRequested = false;
  }

  /**
   * Build a brand-new AgentLoop already restored from a checkpoint — for the
   * "process restarted, I only have the JSON" case. `opts` is the normal
   * AgentLoop constructor options (a fresh context/tools/reasoner); its
   * context content is overwritten by the checkpoint's context snapshot.
   */
  static fromCheckpoint(checkpointObj, opts) {
    const loop = new AgentLoop(opts);
    if (checkpointObj && checkpointObj.context) {
      loop._restoreFromCheckpoint(checkpointObj);
    }
    loop.state.reset(checkpointObj && checkpointObj.pendingApproval ? LoopState.AWAITING_TOOL_APPROVAL : LoopState.PAUSED);
    return loop;
  }

  _fingerprint(action) {
    return `${action.tool}:${JSON.stringify(action.args ?? {})}`;
  }

  _isStuck(action) {
    const fp = this._fingerprint(action);
    this._toolCallHistory.push(fp);
    if (this._toolCallHistory.length > this.maxRepeatedToolCalls) this._toolCallHistory.shift();
    return (
      this._toolCallHistory.length === this.maxRepeatedToolCalls &&
      this._toolCallHistory.every((h) => h === fp)
    );
  }

  /** Structured, non-chat record of every step this run has executed so far. See LOOP.md StepRecord. */
  getStepMemory() {
    return this._stepMemory.slice();
  }

  /**
   * Run the loop to completion for one user turn.
   * @param {string} userInput
   * @param {{signal?: AbortSignal}} [runOpts]
   * @returns {Promise<LoopResult>} see LOOP.md for the exact LoopResult schema.
   */
  async run(userInput, runOpts = {}) {
    return this._execute({ userInput, runOpts, resumeFrom: null });
  }

  /**
   * Shared engine behind run() and resume(). `resumeFrom` is either null
   * (fresh run — resets step/tool-call/step-memory state) or
   * `{step, elapsedMs}` from a checkpoint (continues step numbering and the
   * task-timeout clock instead of restarting them).
   */
  async _execute({ userInput, runOpts = {}, resumeFrom = null }) {
    const { signal } = runOpts;
    const isResume = !!resumeFrom;
    const startedAt = Date.now() - (isResume ? resumeFrom.elapsedMs : 0);
    // A pendingApproval checkpoint pauses BEFORE its action ran, so that
    // action's step number is still "owed" — resume there, not step+1.
    const startStep = isResume ? (resumeFrom.pendingApproval ? resumeFrom.pendingApproval.step : resumeFrom.step + 1) : 1;
    // The first loop iteration of a resumeWithApproval() call has its Action
    // already decided (approved/rejected) rather than produced by THINK.
    let pendingAction = isResume && resumeFrom.pendingApproval
      ? {
          type: ActionType.TOOL_CALL,
          tool: resumeFrom.pendingApproval.tool,
          args: resumeFrom.pendingApproval.args,
          reasoning: resumeFrom.pendingApproval.reasoning,
          _approvalDecision: resumeFrom.approved,
          _approvalRejectReason: resumeFrom.rejectReason,
        }
      : null;

    if (!isResume) {
      this._toolCallHistory = [];
      this._stepMemory = [];
      this._consecutiveToolExhaustion = 0;
    }
    this._pauseRequested = false;
    this._lastStartedAt = startedAt;
    if (isResume) this._safeTransition(LoopState.RESUMED, { fromStep: resumeFrom.step });
    this._safeTransition(LoopState.RUNNING, { resumed: isResume });

    if (userInput != null) {
      if (typeof this.reasoner.addUser === 'function') {
        this.reasoner.addUser(userInput);
      }
      await this.context.addUser(userInput);
    }
    log.info(isResume ? 'run:continue' : 'run:start', {
      userInput,
      startStep,
      maxSteps: this.maxSteps,
      maxTaskTimeoutMs: this.maxTaskTimeoutMs,
      usedTokens: this.context.usedTokens,
      maxTokens: this.context.maxTokens,
    });

    for (let step = startStep; step <= this.maxSteps; step += 1) {
      this._currentStep = step;
      const elapsedMs = Date.now() - startedAt;

      // --- STOP CONDITION ENGINE: pause / abort / task timeout / max tokens / custom ---
      const stopOutcome = this.stopEngine.evaluate({
        step,
        elapsedMs,
        context: this.context,
        stepMemory: this.getStepMemory(),
        signal,
      });
      if (stopOutcome) {
        this._safeTransition(statusToLoopState(stopOutcome.status), { reason: stopOutcome.reason, via: stopOutcome.name });
        if (stopOutcome.status === 'paused') {
          this._emit(LoopEvents.PAUSED, { step: step - 1, elapsedMs, name: stopOutcome.name });
        }
        return this._terminate({
          status: stopOutcome.status,
          reason: stopOutcome.reason,
          step: step - 1,
          startedAt,
          extra: { message: stopOutcome.message, stopCondition: stopOutcome.name },
        });
      }

      this._emit(LoopEvents.STEP_START, { step, elapsedMs });
      log.debug('step:start', { step, maxSteps: this.maxSteps, elapsedMs });

      let action;
      if (pendingAction) {
        // This iteration resolves a decision made outside the loop (resumeWithApproval);
        // it did NOT come from a fresh THINK call.
        action = pendingAction;
        pendingAction = null;
      } else {
        // --- THINK -------------------------------------------------------
        this._safeTransition(LoopState.THINKING);
        try {
          const rendered = this.context.render();
          const toolSchema = this.tools.toSchema();
          action = await this.reasoner(rendered, toolSchema);
          this._validateAction(action);
        } catch (err) {
          this._emit(LoopEvents.ERROR, { step, phase: 'think', error: serializeError(err) });
          log.error('step:think_failed', { step, error: serializeError(err) });
          await this.context.append({ role: 'system', content: `[loop error during think] ${err.message}` });
          this._recordStep({ step, phase: 'think_error', action: null, error: err.message, durationMs: 0 });
          this._safeTransition(LoopState.FAILED, { reason: 'think_error' });
          return this._terminate({
            status: 'error',
            reason: err.code === 'INVALID_ACTION' ? TerminationReason.INVALID_ACTION : TerminationReason.THINK_ERROR,
            step,
            startedAt,
            extra: { error: err.message },
          });
        }
        this._emit(LoopEvents.THINK, { step, action });
        log.info('step:think', { step, actionType: action.type, tool: action.tool, args: action.args });

        // --- terminal actions --------------------------------------------
        if (action.type === ActionType.FINAL) {
          await this.context.addAssistant(action.content, { reasoning: action.reasoning });
          this._recordStep({ step, phase: 'final', action, durationMs: 0 });
          this._emit(LoopEvents.FINAL, { step, content: action.content });
          log.info('run:final', { step, content: action.content });
          this._safeTransition(LoopState.COMPLETED, { reason: 'final' });
          return this._terminate({
            status: 'final',
            reason: TerminationReason.FINAL_ANSWER,
            step,
            startedAt,
            extra: { content: action.content },
          });
        }

        if (action.type === ActionType.NEED_CLARIFICATION) {
          await this.context.addAssistant(action.question, { reasoning: action.reasoning, needsClarification: true });
          this._recordStep({ step, phase: 'need_clarification', action, durationMs: 0 });
          this._emit(LoopEvents.NEED_CLARIFICATION, { step, question: action.question });
          log.info('run:need_clarification', { step, question: action.question });
          this._safeTransition(LoopState.COMPLETED, { reason: 'need_clarification' });
          return this._terminate({
            status: 'need_clarification',
            reason: TerminationReason.NEED_CLARIFICATION,
            step,
            startedAt,
            extra: { question: action.question },
          });
        }

        // --- LOOP SAFETY: stuck-loop detection -----------------------------
        if (this._isStuck(action)) {
          const msg = `Detected repeated identical tool call (${this._fingerprint(action)}) ${this.maxRepeatedToolCalls}x in a row - aborting to avoid an infinite loop.`;
          await this.context.append({ role: 'system', content: `[loop guard] ${msg}` });
          this._recordStep({ step, phase: 'stuck_loop', action, error: msg, durationMs: 0 });
          this._emit(LoopEvents.STUCK_LOOP, { step, action, error: msg });
          log.error('step:stuck_loop', { step, tool: action.tool, args: action.args, error: msg });
          this._safeTransition(LoopState.FAILED, { reason: 'stuck_loop' });
          return this._terminate({ status: 'error', reason: TerminationReason.STUCK_LOOP, step, startedAt, extra: { error: msg } });
        }

        // --- LIFECYCLE: tool approval gate ---------------------------------
        if (this._requiresApproval(action.tool)) {
          this._safeTransition(LoopState.AWAITING_TOOL_APPROVAL);
          const request = { tool: action.tool, args: action.args, reasoning: action.reasoning, step };
          this._recordStep({ step, phase: 'awaiting_approval', action, durationMs: 0 });
          this._emit(LoopEvents.TOOL_APPROVAL_REQUESTED, request);
          log.info('step:tool_approval_requested', request);

          if (this.onToolApproval) {
            let verdict;
            try {
              verdict = await this.onToolApproval(request);
            } catch (err) {
              log.warn('step:tool_approval_hook_failed', { error: err && err.message });
              verdict = false;
            }
            const approved = verdict === true || (verdict && typeof verdict === 'object' && verdict.approved === true);
            const rejectReason = verdict && typeof verdict === 'object' ? verdict.reason : undefined;
            if (!approved) {
              await this._recordApprovalRejection({ step, action, reason: rejectReason });
              continue; // next iteration re-enters THINK; this step is spent, not consumed
            }
            this._emit(LoopEvents.TOOL_APPROVAL_GRANTED, { step, tool: action.tool });
            log.info('step:tool_approval_granted', { step, tool: action.tool });
            // fall through to ACT below
          } else {
            // No automated decision-maker: pause here for an external human/
            // supervisor to call resumeWithApproval(checkpoint, true|false) later.
            return this._terminate({
              status: 'awaiting_tool_approval',
              reason: TerminationReason.AWAITING_TOOL_APPROVAL,
              step: step - 1,
              startedAt,
              extra: {
                message: `Tool "${action.tool}" requires approval before it can run.`,
                pendingApproval: request,
              },
            });
          }
        }
      }

      // --- ACT (tool_call), with bounded automatic retry --------------------
      if (action._approvalDecision !== undefined) {
        if (!action._approvalDecision) {
          await this._recordApprovalRejection({ step, action, reason: action._approvalRejectReason });
          continue; // resumed-and-rejected: skip ACT/OBSERVE, go straight to the next THINK
        }
        this._emit(LoopEvents.TOOL_APPROVAL_GRANTED, { step, tool: action.tool });
        log.info('step:tool_approval_granted', { step, tool: action.tool, viaResume: true });
      }
      this._safeTransition(LoopState.ACTING);
      await this.context.addToolCall(action.tool, action.args, { reasoning: action.reasoning });
      this._emit(LoopEvents.ACT, { step, tool: action.tool, args: action.args });
      log.info('step:act', { step, tool: action.tool, args: action.args });

      const retryPolicy = { ...this.toolRetry, ...(action.retry || {}) };
      const actStartedAt = Date.now();
      const { result, attempts } = await this._executeWithRetry(action, retryPolicy, { step, signal });
      const actDurationMs = Date.now() - actStartedAt;

      if (!result.ok && attempts > retryPolicy.retries) {
        this._consecutiveToolExhaustion += 1;
      } else {
        this._consecutiveToolExhaustion = 0;
      }

      // --- OBSERVE -----------------------------------------------------
      this._safeTransition(LoopState.OBSERVING);
      const compressed = this.compressToolResult(result, { maxChars: this.compressMaxChars });
      await this.context.addToolResult(action.tool, compressed, { attempts });
      if (typeof this.reasoner.addToolResult === 'function') {
        this.reasoner.addToolResult(action._toolCallId, compressed);
      }
      this._recordStep({
        step,
        phase: 'observe',
        action,
        result, // full, uncompressed result — step memory is for debugging/replay, not token-constrained
        attempts,
        durationMs: actDurationMs,
      });
      this._emit(LoopEvents.OBSERVE, { step, tool: action.tool, result, attempts, durationMs: actDurationMs });
      log.info('step:observe', {
        step,
        tool: action.tool,
        ok: result.ok,
        attempts,
        output: result.ok ? result.data : result.error,
        durationMs: actDurationMs,
      });

      // --- ERROR RECOVERY: give up only after repeated, consecutive exhaustion ---
      if (this._consecutiveToolExhaustion >= this.maxConsecutiveToolExhaustion) {
        const msg = `Tool "${action.tool}" exhausted retries ${this._consecutiveToolExhaustion} time(s) in a row - stopping instead of spinning on a broken tool.`;
        await this.context.append({ role: 'system', content: `[loop guard] ${msg}` });
        this._emit(LoopEvents.TOOL_FAILURE_EXHAUSTED, { step, tool: action.tool, error: msg });
        log.error('step:tool_failure_exhausted', { step, tool: action.tool, error: msg });
        this._safeTransition(LoopState.FAILED, { reason: 'tool_failure_exhausted' });
        return this._terminate({
          status: 'error',
          reason: TerminationReason.TOOL_FAILURE_EXHAUSTED,
          step,
          startedAt,
          extra: { error: msg },
        });
      }
    }

    this._emit(LoopEvents.MAX_STEPS, { steps: this.maxSteps });
    log.warn('run:max_steps', { steps: this.maxSteps });
    await this.context.append({ role: 'system', content: `[loop guard] Reached max steps (${this.maxSteps}) without a final answer.` });
    this._safeTransition(LoopState.COMPLETED, { reason: 'max_steps' });
    return this._terminate({ status: 'max_steps', reason: TerminationReason.MAX_STEPS, step: this.maxSteps, startedAt });
  }

  /**
   * Execute one tool_call action with bounded retry + exponential backoff.
   * Only codes listed in `policy.retryableCodes` are retried; anything else
   * (e.g. VALIDATION_ERROR, UNKNOWN_TOOL) fails fast on attempt 1 since a
   * retry can't fix a malformed call.
   * @returns {Promise<{result: ToolResult, attempts: number}>} attempts = number of tries actually made (>=1)
   */
  async _executeWithRetry(action, policy, { step, signal }) {
    let attempt = 0;
    let lastResult;
    while (true) {
      attempt += 1;
      lastResult = await this.tools.execute(action.tool, action.args, { signal });
      if (lastResult.ok) return { result: lastResult, attempts: attempt };

      const isRetryable = (policy.retryableCodes || []).includes(lastResult.code);
      const attemptsLeft = attempt <= policy.retries && isRetryable;
      if (!attemptsLeft) return { result: lastResult, attempts: attempt };

      const backoffMs = policy.backoffMs * Math.pow(policy.factor, attempt - 1);
      this._emit(LoopEvents.TOOL_RETRY, { step, tool: action.tool, attempt, backoffMs, error: lastResult.error, code: lastResult.code });
      log.warn('step:tool_retry', { step, tool: action.tool, attempt, backoffMs, code: lastResult.code, error: lastResult.error });
      if (backoffMs > 0) await sleep(backoffMs);
    }
  }

  _recordStep(record) {
    this._stepMemory.push({ ts: Date.now(), ...record });
  }

  /**
   * A gated tool_call was denied (by the onToolApproval hook or by an
   * external resumeWithApproval(checkpoint, false)). Record it and tell the
   * reasoner why, via a system message, so it can try something else on the
   * next THINK instead of silently retrying the same call.
   */
  async _recordApprovalRejection({ step, action, reason }) {
    const msg = `Tool call "${action.tool}" was NOT approved${reason ? `: ${reason}` : '.'} Choose a different approach.`;
    await this.context.append({ role: 'system', content: `[tool approval] ${msg}` });
    this._recordStep({ step, phase: 'tool_rejected', action, error: msg, durationMs: 0 });
    this._emit(LoopEvents.TOOL_APPROVAL_REJECTED, { step, tool: action.tool, reason });
    log.info('step:tool_approval_rejected', { step, tool: action.tool, reason });
  }

  /**
   * Build the final LoopResult. Always attaches the current state and a
   * fresh checkpoint (see LOOP.md → Checkpoint) so ANY terminal result —
   * not just an explicit pause() — can be handed to resume() later.
   */
  _terminate({ status, reason, step, startedAt, extra = {} }) {
    const elapsedMs = Date.now() - startedAt;
    return {
      status,
      reason,
      steps: step,
      elapsedMs,
      stepMemory: this.getStepMemory(),
      state: this.state.current,
      checkpoint: this.checkpoint({ step, elapsedMs, pendingApproval: extra.pendingApproval || null, reason: status }),
      ...extra,
    };
  }

  /**
   * Validate a reasoner's Action against the fixed schema. Throws LoopError
   * (code INVALID_ACTION) rather than letting a malformed action silently
   * corrupt loop state. See LOOP.md → Action schema.
   */
  _validateAction(action) {
    if (!action || typeof action !== 'object') {
      throw new LoopError('Reasoner returned a non-object action.', 'INVALID_ACTION');
    }
    switch (action.type) {
      case ActionType.FINAL:
        if (typeof action.content !== 'string' || !action.content.trim()) {
          throw new LoopError('"final" action requires non-empty string "content".', 'INVALID_ACTION');
        }
        return;
      case ActionType.NEED_CLARIFICATION:
        if (typeof action.question !== 'string' || !action.question.trim()) {
          throw new LoopError('"need_clarification" action requires non-empty string "question".', 'INVALID_ACTION');
        }
        return;
      case ActionType.TOOL_CALL:
        if (typeof action.tool !== 'string' || !action.tool.trim()) {
          throw new LoopError('"tool_call" action requires non-empty string "tool".', 'INVALID_ACTION');
        }
        if (!this.tools.has(action.tool)) {
          throw new LoopError(`"tool_call" references unknown tool "${action.tool}".`, 'INVALID_ACTION');
        }
        if (action.args !== undefined && (typeof action.args !== 'object' || action.args === null || Array.isArray(action.args))) {
          throw new LoopError('"tool_call" args must be a plain object when provided.', 'INVALID_ACTION');
        }
        return;
      default:
        throw new LoopError(
          `Unknown action type "${action && action.type}". Expected one of: ${Object.values(ActionType).join(', ')}.`,
          'INVALID_ACTION'
        );
    }
  }
}

/**
 * Default tool-result compression written into ContextWindow (the
 * token-budgeted chat trace). Step memory always keeps the untouched
 * original — this only shrinks what gets sent back to the model.
 */
function defaultCompressToolResult(result, { maxChars = DEFAULT_COMPRESS_MAX_CHARS } = {}) {
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

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch (_err) {
    return String(value);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Adapt a legacy `(state) => reason|null` stop condition to the Stop Condition Engine's richer contract. */
function wrapLegacyStopCondition(fn) {
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

function serializeError(err) {
  if (!err) return null;
  return { message: err.message, code: err.code, stack: err.stack };
}

export default AgentLoop;
