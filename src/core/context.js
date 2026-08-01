/**
 * context.js — Context Window Manager
 * -----------------------------------------------
 * Keeps the running conversation/tool-trace within a token budget. Tracks
 * every message (user/assistant/system/tool_call/tool_result), estimates
 * token cost, and auto-compacts when the budget is exceeded — either by
 * summarizing the oldest chunk (if you provide a `summarize` function) or by
 * dropping the oldest entries while keeping a full audit trail of what was
 * dropped (`dropped[]`), so nothing silently disappears without a trace.
 *
 * Pure JavaScript (ES modules). No TypeScript, no build step.
 */

import { createLogger } from './logger.js';

const log = createLogger('context');

export class ContextError extends Error {
  constructor(message, code = 'CONTEXT_ERROR') {
    super(message);
    this.name = 'ContextError';
    this.code = code;
  }
}

/**
 * @typedef {Object} ContextMessage
 * @property {string} role - 'system' | 'user' | 'assistant' | 'tool_call' | 'tool_result'
 * @property {string} content - rendered/serialized text
 * @property {object} [meta] - arbitrary extra data (tool name, args, reasoning, etc.)
 * @property {number} tokens - estimated token count
 * @property {number} ts - creation timestamp (ms epoch)
 */

const DEFAULT_MAX_TOKENS = 8000;
const DEFAULT_COMPACT_THRESHOLD = 0.85; // compact once usage crosses this fraction of maxTokens
const DEFAULT_KEEP_RECENT = 6; // never compact away the most recent N messages

export class ContextWindow {
  /**
   * @param {Object} [opts]
   * @param {number} [opts.maxTokens=8000] Token budget for the whole window.
   * @param {number} [opts.compactThreshold=0.85] Fraction of maxTokens that triggers auto-compact.
   * @param {number} [opts.keepRecent=6] Minimum number of most-recent messages always kept verbatim.
   * @param {Function} [opts.summarize] - async (messages) => string. If provided, compaction
   *        replaces the oldest eligible messages with one system message containing this summary.
   *        If omitted, compaction just drops the oldest eligible messages (recorded in dropped[]).
   * @param {Function} [opts.estimateTokens] - (text) => number. Defaults to a chars/4 heuristic.
   * @param {string} [opts.systemPrompt] - optional system prompt prepended to render().
   */
  constructor({
    maxTokens = DEFAULT_MAX_TOKENS,
    compactThreshold = DEFAULT_COMPACT_THRESHOLD,
    keepRecent = DEFAULT_KEEP_RECENT,
    summarize,
    estimateTokens,
    systemPrompt,
  } = {}) {
    this.maxTokens = maxTokens;
    this.compactThreshold = compactThreshold;
    this.keepRecent = keepRecent;
    this.summarize = summarize;
    this.estimateTokens = estimateTokens || defaultEstimateTokens;
    this.systemPrompt = systemPrompt || null;

    /** @type {ContextMessage[]} */
    this.messages = [];
    /** @type {Array<{message: ContextMessage, reason:string, ts:number}>} audit trail of compacted-away entries */
    this.dropped = [];
    /** Prevents futile repeated compaction attempts when keepRecent alone exceeds budget */
    this._lastCompactFailed = false;
  }

  /** Total estimated tokens currently held (messages only, not systemPrompt). */
  get usedTokens() {
    return this.messages.reduce((sum, m) => sum + m.tokens, 0);
  }

  get budgetFraction() {
    return this.maxTokens > 0 ? this.usedTokens / this.maxTokens : 0;
  }

  async append(msg) {
    if (!msg || typeof msg !== 'object') {
      throw new ContextError('append() requires a message object.');
    }
    if (typeof msg.role !== 'string' || !msg.role.trim()) {
      throw new ContextError('Message requires a non-empty string "role".');
    }
    const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content ?? '');
    const entry = {
      role: msg.role,
      content,
      meta: msg.meta || {},
      tokens: this.estimateTokens(content),
      ts: Date.now(),
    };
    this.messages.push(entry);
    log.debug('append', {
      role: entry.role,
      tokens: entry.tokens,
      usedTokens: this.usedTokens,
      maxTokens: this.maxTokens,
      budgetFraction: Number(this.budgetFraction.toFixed(3)),
    });

    // Only attempt compaction if we're over the threshold AND haven't just
    // tried to compact (prevents futile repeated compaction attempts when
    // keepRecent alone exceeds the budget).
    if (this.budgetFraction >= this.compactThreshold && !this._lastCompactFailed) {
      await this._compact();
    }
    return entry;
  }

  addUser(content, meta = {}) {
    return this.append({ role: 'user', content, meta });
  }

  addAssistant(content, meta = {}) {
    return this.append({ role: 'assistant', content, meta });
  }

  addToolCall(toolName, args, meta = {}) {
    return this.append({
      role: 'tool_call',
      content: `call ${toolName}(${JSON.stringify(args ?? {})})`,
      meta: { ...meta, tool: toolName, args },
    });
  }

  addToolResult(toolName, result, meta = {}) {
    const content = result && result.ok
      ? `result ${toolName} -> ${safeStringify(result.data)}`
      : `error ${toolName} -> ${result ? result.error : 'unknown error'}`;
    return this.append({
      role: 'tool_result',
      content,
      meta: { ...meta, tool: toolName, ok: !!(result && result.ok) },
    });
  }

  /**
   * Compact the window. Called automatically once the threshold is crossed,
   * but can be invoked manually too.
   */
  async _compact() {
    const beforeTokens = this.usedTokens;
    const protectedCount = Math.min(this.keepRecent, this.messages.length);
    const compactCandidates = this.messages.slice(0, this.messages.length - protectedCount);
    const recent = this.messages.slice(this.messages.length - protectedCount);

    log.info('compact:start', {
      totalMessages: this.messages.length,
      candidates: compactCandidates.length,
      protectedRecent: protectedCount,
      usedTokens: beforeTokens,
      maxTokens: this.maxTokens,
      strategy: typeof this.summarize === 'function' ? 'summarize' : 'drop',
    });

    if (compactCandidates.length === 0) {
      log.warn('compact:skip', { reason: 'nothing eligible, over budget but all protected', usedTokens: beforeTokens });
      this._lastCompactFailed = true;
      return; // nothing eligible to compact; over budget but protected
    }

    if (typeof this.summarize === 'function') {
      try {
        const summaryText = await this.summarize(compactCandidates);
        const summaryEntry = {
          role: 'system',
          content: `[context summary of ${compactCandidates.length} earlier message(s)] ${summaryText}`,
          meta: { compacted: true, count: compactCandidates.length },
          tokens: this.estimateTokens(summaryText),
          ts: Date.now(),
        };
        for (const m of compactCandidates) {
          this.dropped.push({ message: m, reason: 'summarized', ts: Date.now() });
        }
        this.messages = [summaryEntry, ...recent];
        this._lastCompactFailed = false;
        log.info('compact:done', {
          strategy: 'summarize',
          summarizedCount: compactCandidates.length,
          beforeTokens,
          afterTokens: this.usedTokens,
        });
        return;
      } catch (err) {
        log.warn('compact:summarize_failed', { error: err && err.message, fallback: 'drop' });
        // fall through to drop strategy if summarize fails
      }
    }

    // drop strategy: remove oldest eligible messages until back under budget,
    // keeping a full audit trail of what was dropped.
    let candidates = [...compactCandidates];
    while (candidates.length > 0 && this._tokensOf([...candidates, ...recent]) > this.maxTokens * this.compactThreshold) {
      const removed = candidates.shift();
      this.dropped.push({ message: removed, reason: 'dropped_for_budget', ts: Date.now() });
    }
    this.messages = [...candidates, ...recent];
    // If compaction didn't actually reduce usage below the threshold, mark
    // as failed so we don't keep retrying on every append.
    this._lastCompactFailed = this.budgetFraction >= this.compactThreshold;
    log.info('compact:done', {
      strategy: 'drop',
      droppedCount: this.dropped.length,
      beforeTokens,
      afterTokens: this.usedTokens,
      stillOverBudget: this._lastCompactFailed,
    });
  }

  _tokensOf(list) {
    return list.reduce((sum, m) => sum + m.tokens, 0);
  }

  /**
   * Render the current window into a plain {role, content} array suitable
   * for feeding a reasoner/LLM call. Provider-agnostic shape.
   */
  render() {
    const out = [];
    if (this.systemPrompt) out.push({ role: 'system', content: this.systemPrompt });
    for (const m of this.messages) out.push({ role: m.role, content: m.content });
    return out;
  }

  /** Full snapshot including meta, tokens, and dropped audit trail. Useful for debugging/persistence. */
  toJSON() {
    return {
      maxTokens: this.maxTokens,
      compactThreshold: this.compactThreshold,
      keepRecent: this.keepRecent,
      usedTokens: this.usedTokens,
      messages: this.messages,
      dropped: this.dropped,
    };
  }

  clear() {
    this.messages = [];
    this.dropped = [];
    this._lastCompactFailed = false;
  }

  /**
   * Restore a previously-serialized state (from toJSON()) into this instance
   * in place. Used by checkpoint/resume — messages are trusted as already
   * valid (no re-validation, no token re-estimation), so restoring is cheap
   * and exact.
   * @param {{messages?: ContextMessage[], dropped?: Array}} data
   */
  restore({ messages = [], dropped = [] } = {}) {
    this.messages = messages.map((m) => ({ ...m }));
    this.dropped = dropped.map((d) => ({ ...d }));
    return this;
  }

  /** Build a brand-new ContextWindow from a toJSON() snapshot (e.g. after a process restart). */
  static fromJSON(data = {}, opts = {}) {
    const ctx = new ContextWindow({
      maxTokens: data.maxTokens,
      compactThreshold: data.compactThreshold,
      keepRecent: data.keepRecent,
      ...opts,
    });
    ctx.restore(data);
    return ctx;
  }
}

function defaultEstimateTokens(text) {
  if (!text) return 0;
  // crude but dependency-free heuristic: ~4 chars per token
  return Math.max(1, Math.ceil(String(text).length / 4));
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch (_err) {
    return String(value);
  }
}

export default ContextWindow;
