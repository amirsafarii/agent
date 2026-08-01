/**
 * budget/budget-manager.js — Budget / cost manager
 * ---------------------------------------------------------------------------
 * A single, independent budget ledger separate from the ContextWindow's token
 * accounting. Tracks every dimension of a run:
 *
 *   tokens          LLM input+output tokens consumed
 *   modelCalls      number of LLM (reasoner) calls
 *   toolCalls       number of tool executions
 *   networkCalls    number of network / HTTP requests
 *   subprocesses    number of spawned subprocesses
 *   runtimeMs       wall-clock execution time
 *   dollars         approximate USD cost (derived from tokens via a rate)
 *
 * Every Task can own its own budget: `budget.scope(taskId)` returns a child
 * manager that shares the same underlying counters (so totals aggregate) but
 * is bounded by the parent's *remaining* allowance — no child can overspend
 * what the parent has left. `exceeded()` returns which limit(s) were hit so a
 * loop can terminate with a precise reason instead of burning tokens blindly.
 *
 * Pure JavaScript (ES modules).
 */

/** Default per-1k-token USD rates (input/output), crude but useful for an
 * approximate `dollars` figure. Overridable per instance. */
const DEFAULT_RATES = Object.freeze({ in: 0.000002, out: 0.000008 });

export const BudgetUnits = Object.freeze({
  TOKENS: 'tokens',
  MODEL_CALLS: 'modelCalls',
  TOOL_CALLS: 'toolCalls',
  NETWORK_CALLS: 'networkCalls',
  SUBPROCESSES: 'subprocesses',
  RUNTIME_MS: 'runtimeMs',
  DOLLARS: 'dollars',
});

export class BudgetManager {
  /**
   * @param {Object} [opts]
   * @param {number} [opts.maxTokens]
   * @param {number} [opts.maxModelCalls]
   * @param {number} [opts.maxToolCalls]
   * @param {number} [opts.maxNetworkCalls]
   * @param {number} [opts.maxSubprocesses]
   * @param {number} [opts.maxRuntimeMs]
   * @param {number} [opts.maxDollars]
   * @param {Object} [opts.rates] {in, out} per-1k-token USD
   * @param {Object} [_usage] internal: shared counters for scoped children
   */
  constructor(opts = {}) {
    this.limits = {
      tokens: opts.maxTokens ?? Infinity,
      modelCalls: opts.maxModelCalls ?? Infinity,
      toolCalls: opts.maxToolCalls ?? Infinity,
      networkCalls: opts.maxNetworkCalls ?? Infinity,
      subprocesses: opts.maxSubprocesses ?? Infinity,
      runtimeMs: opts.maxRuntimeMs ?? Infinity,
      dollars: opts.maxDollars ?? Infinity,
    };
    this.rates = { ...DEFAULT_RATES, ...(opts.rates || {}) };
    // Shared counter object — scoped children get a reference so totals
    // aggregate across the whole run (and across tasks).
    this._usage = opts._usage || {
      tokens: 0,
      modelCalls: 0,
      toolCalls: 0,
      networkCalls: 0,
      subprocesses: 0,
      runtimeMs: 0,
      dollars: 0,
      startedAt: Date.now(),
    };
  }

  get usage() {
    return { ...this._usage };
  }

  get startedAt() {
    return this._usage.startedAt;
  }

  elapsedMs() {
    return Date.now() - this._usage.startedAt;
  }

  /**
   * Record usage. Any/all units can be supplied in one call.
   * @param {Object} deltas
   * @param {number} [deltas.tokens]
   * @param {number} [deltas.modelCalls]
   * @param {number} [deltas.toolCalls]
   * @param {number} [deltas.networkCalls]
   * @param {number} [deltas.subprocesses]
   * @param {number} [deltas.runtimeMs]
   * @param {number} [deltas.dollars]
   * @returns {this}
   */
  record({ tokens = 0, modelCalls = 0, toolCalls = 0, networkCalls = 0, subprocesses = 0, runtimeMs = 0, dollars = 0 } = {}) {
    const u = this._usage;
    u.tokens += Math.max(0, tokens);
    u.modelCalls += Math.max(0, modelCalls);
    u.toolCalls += Math.max(0, toolCalls);
    u.networkCalls += Math.max(0, networkCalls);
    u.subprocesses += Math.max(0, subprocesses);
    u.runtimeMs += Math.max(0, runtimeMs);
    // Derive dollars from token deltas when not explicitly supplied.
    const tokDollars = (Math.max(0, tokens) / 1000) * (this.rates.in + this.rates.out) / 2;
    u.dollars += Math.max(0, dollars || tokDollars);
    return this;
  }

  /** Convenience: record an LLM call with a token count (updates tokens + dollars). */
  recordModelCall(tokens = 0) {
    return this.record({ tokens, modelCalls: 1 });
  }

  recordToolCall() {
    return this.record({ toolCalls: 1 });
  }

  recordNetworkCall() {
    return this.record({ networkCalls: 1 });
  }

  recordSubprocess() {
    return this.record({ subprocesses: 1 });
  }

  /** Remaining allowance per unit (floor at 0). */
  get remaining() {
    const u = this._usage;
    return {
      tokens: Math.max(0, this.limits.tokens - u.tokens),
      modelCalls: Math.max(0, this.limits.modelCalls - u.modelCalls),
      toolCalls: Math.max(0, this.limits.toolCalls - u.toolCalls),
      networkCalls: Math.max(0, this.limits.networkCalls - u.networkCalls),
      subprocesses: Math.max(0, this.limits.subprocesses - u.subprocesses),
      runtimeMs: Math.max(0, this.limits.runtimeMs - u.runtimeMs),
      dollars: Math.max(0, this.limits.dollars - u.dollars),
    };
  }

  /** Live runtime cost in USD (derived from tokens consumed). */
  get dollars() {
    return this._usage.dollars;
  }

  /**
   * Which limits, if any, are exceeded right now.
   * @returns {{exceeded: boolean, units: string[], usage: Object, limits: Object}}
   */
  exceeded() {
    const u = this._usage;
    const units = [];
    const compare = [
      ['tokens', u.tokens, this.limits.tokens],
      ['modelCalls', u.modelCalls, this.limits.modelCalls],
      ['toolCalls', u.toolCalls, this.limits.toolCalls],
      ['networkCalls', u.networkCalls, this.limits.networkCalls],
      ['subprocesses', u.subprocesses, this.limits.subprocesses],
      ['runtimeMs', Date.now() - u.startedAt, this.limits.runtimeMs],
      ['dollars', u.dollars, this.limits.dollars],
    ];
    for (const [unit, used, max] of compare) {
      // Reaching the limit counts as exceeded: a stop-guard should fire BEFORE
      // the next over-limit step is taken, not after it.
      if (used >= max) units.push(unit);
    }
    return { exceeded: units.length > 0, units, usage: this.usage, limits: { ...this.limits } };
  }

  /** Human-readable summary of the tightest constraint. */
  reason() {
    const { units, usage, limits } = this.exceeded();
    if (units.length === 0) return null;
    return `budget exceeded: ${units.map((u) => `${u} (${usage[u]} >= ${limits[u]})`).join(', ')}`;
  }

  /**
   * Spawn a per-task / per-scope child budget. Shares the same underlying
   * counters (so totals aggregate across the run) but is capped by the
   * parent's remaining allowance — a child cannot overspend the parent.
   * @param {string} [taskId] optional label (informational only)
   * @returns {BudgetManager}
   */
  scope(taskId) {
    const remaining = this.remaining;
    const child = new BudgetManager({
      maxTokens: remaining.tokens,
      maxModelCalls: remaining.modelCalls,
      maxToolCalls: remaining.toolCalls,
      maxNetworkCalls: remaining.networkCalls,
      maxSubprocesses: remaining.subprocesses,
      maxRuntimeMs: remaining.runtimeMs,
      maxDollars: remaining.dollars,
      rates: this.rates,
      _usage: this._usage,
    });
    child.taskId = taskId || null;
    return child;
  }

  toJSON() {
    return {
      taskId: this.taskId || null,
      limits: this.limits,
      usage: this.usage,
      remaining: this.remaining,
      elapsedMs: this.elapsedMs(),
      dollars: this.dollars,
      exceeded: this.exceeded(),
    };
  }
}
