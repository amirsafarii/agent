/**
 * loop/agent-loop.js — Agent Loop (think → act → observe)
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
 * The fixed vocabularies and engines this class is built from live in their
 * own modules: ./events.js (LoopEvents/TerminationReason/ActionType),
 * ./errors.js (LoopError), ./state-machine.js (LoopStateMachine),
 * ./stop-conditions.js (StopConditionEngine), ./compression.js (default
 * tool-result compression + helpers). All of them are re-exported from
 * ./index.js, the public entry for the loop module.
 *
 * Full input/output schema for every function in this file: see docs/LOOP.md.
 *
 * Pure JavaScript (ES modules). No TypeScript, no build step.
 */

import { createLogger } from '../logger.js';
import { CheckpointManager } from '../checkpoint-manager.js';
import { LoopEvents, TerminationReason, ActionType } from './events.js';
import { LoopError } from './errors.js';
import { LoopState, LoopStateMachine, statusToLoopState } from './state-machine.js';
import { StopConditionEngine, wrapLegacyStopCondition } from './stop-conditions.js';
import { DEFAULT_COMPRESS_MAX_CHARS, defaultCompressToolResult, normalizeArgs, sleep, serializeError } from './compression.js';

const log = createLogger('loop');

// Deliberately narrow: only generic execution errors are retried. Timeouts
// (TOOL_TIMEOUT) and network-shaped failures (REQUEST_FAILED / HTTP_ERROR /
// BAD_JSON / ENOTFOUND / ECONNREFUSED / ETIMEDOUT / STREAM_FAILED / DNS
// codes) fail fast so the reasoner can pivot immediately instead of burning
// latency on a dead endpoint — see the "Fallback Rule" in the system prompt.
const DEFAULT_TOOL_RETRY = Object.freeze({
  retries: 2,
  backoffMs: 250,
  factor: 2,
  retryableCodes: ['TOOL_EXECUTION_ERROR', 'EXECUTION_ERROR'],
});

const DEFAULT_MAX_TASK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes wall clock per run()
const DEFAULT_MAX_CONSECUTIVE_TOOL_EXHAUSTION = 2;
const DEFAULT_MAX_TOOL_CALLS_PER_TOOL = 8; // hard per-run cap per tool name
const DEFAULT_SIMILAR_WINDOW = 8; // how many recent tool calls to compare for similarity warnings

export class AgentLoop {
  /**
   * @param {Object} opts
   * @param {import('../context.js').ContextWindow} opts.context
   * @param {import('../../tools/registry.js').ToolRegistry} opts.tools
   * @param {Function} opts.reasoner - async (renderedContext, toolSchema) => Action. See ActionType/docs/LOOP.md.
   * @param {number} [opts.maxSteps=12] Hard ceiling on think/act/observe cycles per run.
   * @param {number} [opts.maxRepeatedToolCalls=3] Abort if the same tool+args repeats this many times in a row.
   * @param {number} [opts.maxTaskTimeoutMs=300000] Wall-clock ceiling for one run() call, independent of maxSteps.
   * @param {Object} [opts.toolRetry] Default retry policy for tool_call actions; per-action override via action.retry.
   * @param {number} [opts.toolRetry.retries=2]
   * @param {number} [opts.toolRetry.backoffMs=250] base backoff, doubled (`factor`) per attempt.
   * @param {number} [opts.toolRetry.factor=2]
   * @param {string[]} [opts.toolRetry.retryableCodes] tool error codes worth retrying; anything else fails fast.
   * @param {number} [opts.maxConsecutiveToolExhaustion=2] Stop the run if this many tool_calls in a row exhaust all retries.
   * @param {number} [opts.maxToolCallsPerTool=8] Stop the run when a single tool has been called this many
   *        times in one run (anti "tool misuse" / token-burn guard, independent of args — different queries
   *        to the same tool count, so it caps flailing, not legitimate multi-step work).
   * @param {Object|false} [opts.adaptiveMaxSteps=false] Grow the step budget while the run is still making
   *        progress instead of stopping at the fixed `maxSteps` ceiling. Shape:
   *        `{ max?: number, growthFactor?: number = 2 }` — the budget starts at `maxSteps` and doubles up to
   *        `max` as completed steps keep producing (non-terminal) actions. Off unless you opt in.
   *        A per-call override also exists: `runOpts.maxSteps`.
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
   *        definition's own `requiresApproval: true` (see tools/registry.js) also gates it, OR'd with this list.
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
    maxToolCallsPerTool = DEFAULT_MAX_TOOL_CALLS_PER_TOOL,
    adaptiveMaxSteps = false,
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
    this.maxToolCallsPerTool = maxToolCallsPerTool;
    this.adaptiveMaxSteps = adaptiveMaxSteps && typeof adaptiveMaxSteps === 'object'
      ? {
          max: Number.isFinite(adaptiveMaxSteps.max) && adaptiveMaxSteps.max > 0 ? adaptiveMaxSteps.max : this.maxSteps * 4,
          growthFactor: Number.isFinite(adaptiveMaxSteps.growthFactor) && adaptiveMaxSteps.growthFactor > 1 ? adaptiveMaxSteps.growthFactor : 2,
        }
      : false;
    this.compressMaxChars = compressMaxChars;
    this.compressToolResult = compressToolResult || defaultCompressToolResult;
    this.requireApprovalFor = requireApprovalFor;
    this.onToolApproval = typeof onToolApproval === 'function' ? onToolApproval : null;
    this.lifecycleHooks = lifecycleHooks || {};
    this.onEvent = onEvent || (() => {});

    this._toolCallHistory = []; // recent tool_call fingerprints, for stuck-loop detection
    this._toolCallCounts = {}; // per-tool call counter for the tool-overuse guard
    this._similarCallHistory = []; // normalized fingerprints of recent calls, for similarity warnings
    this._stepMemory = []; // structured, non-chat record of every step — see docs/LOOP.md StepRecord
    this._consecutiveToolExhaustion = 0;
    this._pauseRequested = false;
    this._currentStep = 0;
    this._lastStartedAt = Date.now();
    this._lastBudget = null; // effective step budget of the most recent run/resume

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
   * definition (`requiresApproval: true`, see tools/registry.js) does.
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
   * budget have already been spent. See docs/LOOP.md → Checkpoint.
   */
  checkpoint(meta = {}) {
    const step = meta.step ?? this._currentStep ?? 0;
    const elapsedMs = meta.elapsedMs ?? Math.max(0, Date.now() - this._lastStartedAt);
    const snapshot = {
      version: 1,
      createdAt: Date.now(),
      step,
      elapsedMs,
      budget: this._lastBudget ?? null, // effective adaptive budget, so resume keeps it
      toolCallHistory: this._toolCallHistory.slice(),
      toolCallCounts: { ...this._toolCallCounts },
      similarCallHistory: this._similarCallHistory.slice(),
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
   * @param {Object} checkpointObj - see docs/LOOP.md → Checkpoint.
   * @param {{additionalInput?: string, signal?: AbortSignal}} [runOpts]
   * @returns {Promise<LoopResult>}
   */
  async resume(checkpointObj, runOpts = {}) {
    if (!checkpointObj || typeof checkpointObj !== 'object' || !checkpointObj.context) {
      throw new LoopError('resume() requires a valid checkpoint object (see checkpoint()/docs/LOOP.md).', 'INVALID_CHECKPOINT');
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
      resumeFrom: {
        step: checkpointObj.step || 0,
        elapsedMs: checkpointObj.elapsedMs || 0,
        budget: checkpointObj.budget ?? null,
      },
    });
  }

  /**
   * Resolve a pending human-in-the-loop tool approval captured by a
   * status:'awaiting_tool_approval' result (checkpoint.pendingApproval) and
   * continue the run. If `approved` is false, the gated tool_call is
   * recorded as rejected and the run continues to the next THINK instead of
   * executing it. See docs/LOOP.md → Tool Approval.
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
        budget: checkpointObj.budget ?? null,
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
    this._toolCallCounts = checkpointObj.toolCallCounts && typeof checkpointObj.toolCallCounts === 'object' ? { ...checkpointObj.toolCallCounts } : {};
    this._similarCallHistory = Array.isArray(checkpointObj.similarCallHistory) ? checkpointObj.similarCallHistory.slice() : [];
    this._consecutiveToolExhaustion = checkpointObj.consecutiveToolExhaustion || 0;
    this._lastBudget = checkpointObj.budget ?? null;
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

  /**
   * Detect near-duplicate calls: same tool with args that normalize to the
   * same JSON (object key order ignored), appearing anywhere in the recent
   * window — but NOT the immediately-previous call (that exact consecutive
   * repeat is the stuck-loop guard's job). Returns true when a warning is
   * worth emitting; the loop records the call regardless.
   */
  _isSimilarCall(action) {
    const norm = `${action.tool}:${normalizeArgs(action.args)}`;
    const prev = this._similarCallHistory[this._similarCallHistory.length - 1];
    if (prev === norm) return false; // consecutive exact repeat -> stuck guard territory
    const seenEarlier = this._similarCallHistory.slice(0, -1).includes(norm);
    this._similarCallHistory.push(norm);
    if (this._similarCallHistory.length > DEFAULT_SIMILAR_WINDOW) this._similarCallHistory.shift();
    return seenEarlier;
  }

  /** Structured, non-chat record of every step this run has executed so far. See docs/LOOP.md StepRecord. */
  getStepMemory() {
    return this._stepMemory.slice();
  }

  /**
   * Run the loop to completion for one user turn.
   * @param {string} userInput
   * @param {{signal?: AbortSignal, maxSteps?: number}} [runOpts]
   * @returns {Promise<LoopResult>} see docs/LOOP.md for the exact LoopResult schema.
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
    // Step budget: per-call override > resumed adaptive budget > constructor.
    // With adaptiveMaxSteps the budget GROWS while the run makes progress
    // (see the extension block at the end of the loop body), so a 40-step
    // task is not cut off by a 12-step default ceiling.
    const requestedBudget = Number.isFinite(runOpts.maxSteps) && runOpts.maxSteps > 0 ? runOpts.maxSteps : this.maxSteps;
    let budget = isResume && Number.isFinite(resumeFrom.budget) && resumeFrom.budget > 0 ? resumeFrom.budget : requestedBudget;
    this._lastBudget = budget;
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
      this._toolCallCounts = {};
      this._similarCallHistory = [];
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
      budget,
      adaptiveMaxSteps: this.adaptiveMaxSteps ? this.adaptiveMaxSteps.max : false,
      maxTaskTimeoutMs: this.maxTaskTimeoutMs,
      usedTokens: this.context.usedTokens,
      maxTokens: this.context.maxTokens,
    });

    for (let step = startStep; step <= budget; step += 1) {
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

        // --- LOOP SAFETY: tool-overuse guard (anti "tool misuse") ----------
        // Counts every call per tool NAME for the whole run — different args
        // count, so flailing on one tool (endless search variants) is capped
        // while a legitimate multi-step build is not.
        this._toolCallCounts[action.tool] = (this._toolCallCounts[action.tool] || 0) + 1;
        if (this._toolCallCounts[action.tool] > this.maxToolCallsPerTool) {
          const msg = `Tool "${action.tool}" has been called ${this._toolCallCounts[action.tool]} times this run (limit ${this.maxToolCallsPerTool}) - stopping instead of burning tokens on repeated use of one tool.`;
          await this.context.append({ role: 'system', content: `[loop guard] ${msg}` });
          this._recordStep({ step, phase: 'tool_overuse', action, error: msg, durationMs: 0 });
          this._emit(LoopEvents.TOOL_OVERUSE, { step, tool: action.tool, calls: this._toolCallCounts[action.tool], error: msg });
          log.error('step:tool_overuse', { step, tool: action.tool, calls: this._toolCallCounts[action.tool], error: msg });
          this._safeTransition(LoopState.FAILED, { reason: 'tool_overuse' });
          return this._terminate({ status: 'error', reason: TerminationReason.TOOL_OVERUSE, step, startedAt, extra: { error: msg } });
        }

        // --- LOOP SAFETY: similar-call warning (repetitive pattern) --------
        // Not terminal — a warning the reasoner sees so it can pivot instead
        // of re-issuing near-identical calls (same tool, args identical after
        // key normalization, not the exact consecutive repeat stuck-guard
        // already handles).
        if (this._isSimilarCall(action)) {
          const msg = `This tool call (${action.tool} ${JSON.stringify(action.args ?? {})}) closely matches an earlier call this run - check whether you already have this data before calling again.`;
          await this.context.append({ role: 'system', content: `[loop guard] ${msg}` });
          this._emit(LoopEvents.SIMILAR_CALL, { step, tool: action.tool, args: action.args, error: msg });
          log.warn('step:similar_call', { step, tool: action.tool, args: action.args });
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

      // --- ADAPTIVE BUDGET: a step just completed without terminating ---
      // If the run is still producing actions and the budget is exhausted,
      // grow it (up to the adaptive cap) instead of cutting the run short.
      // Stuck/timed-out/failed runs never reach this point, so the growth
      // only rewards actual progress.
      if (step >= budget && this.adaptiveMaxSteps && budget < this.adaptiveMaxSteps.max) {
        const nextBudget = Math.min(this.adaptiveMaxSteps.max, Math.round(budget * this.adaptiveMaxSteps.growthFactor));
        this._emit(LoopEvents.BUDGET_EXTENDED, { from: budget, to: nextBudget, step });
        log.info('run:budget_extended', { from: budget, to: nextBudget, step });
        budget = nextBudget;
        this._lastBudget = budget;
      }
    }

    this._emit(LoopEvents.MAX_STEPS, { steps: budget });
    log.warn('run:max_steps', { steps: budget, maxSteps: this.maxSteps });
    await this.context.append({ role: 'system', content: `[loop guard] Reached max steps (${budget}) without a final answer.` });
    this._safeTransition(LoopState.COMPLETED, { reason: 'max_steps' });
    return this._terminate({ status: 'max_steps', reason: TerminationReason.MAX_STEPS, step: budget, startedAt, extra: { budget } });
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
   * fresh checkpoint (see docs/LOOP.md → Checkpoint) so ANY terminal result —
   * not just an explicit pause() — can be handed to resume() later.
   */
  _terminate({ status, reason, step, startedAt, extra = {} }) {
    const elapsedMs = Date.now() - startedAt;
    return {
      status,
      reason,
      steps: step,
      elapsedMs,
      budget: this._lastBudget ?? this.maxSteps, // effective step budget used (adaptive aware)
      stepMemory: this.getStepMemory(),
      state: this.state.current,
      checkpoint: this.checkpoint({ step, elapsedMs, pendingApproval: extra.pendingApproval || null, reason: status }),
      ...extra,
    };
  }

  /**
   * Validate a reasoner's Action against the fixed schema. Throws LoopError
   * (code INVALID_ACTION) rather than letting a malformed action silently
   * corrupt loop state. See docs/LOOP.md → Action schema.
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

export default AgentLoop;
