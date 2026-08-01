/**
 * reasoner.js — pluggable LLM reasoning adapter
 * -----------------------------------------------
 * AgentLoop only needs `reasoner(renderedContext, toolSchema) => Action`. This
 * file is the recommended way to build that function: it wraps a
 * provider-agnostic `client.chat()` adapter (OpenAI/Anthropic/local model —
 * you write that adapter, not this file) and keeps the *native* message
 * history the provider actually expects — separate from ContextWindow, which
 * is just the generic audit trail.
 *
 * Why a separate history? Tool-calling APIs (OpenAI-style) require the
 * assistant's tool_call id to be echoed back on the matching tool-result
 * message. ContextWindow doesn't track that id. So the returned reasoner
 * function exposes two extra hooks that AgentLoop calls automatically,
 * *in addition to* its own ContextWindow bookkeeping, whenever they exist:
 *
 *   reasoner.addUser(text)                     — mirror the user turn
 *   reasoner.addToolResult(toolCallId, result)  — mirror a tool result, keyed
 *                                                  by the id issued for that
 *                                                  specific tool_call
 *
 * Streaming: pass `stream: true` (plus optionally `onToken(text)`) and the
 * reasoner will use `client.chatStream()` when the client exposes one
 * (9router does — see clients/9router.js), falling back to `client.chat()`
 * otherwise. The return value is normalized to the exact same Action shape
 * either way, so AgentLoop is streaming-agnostic; `onToken` receives final-
 * answer content chunks as they arrive (for live UIs/REPLs) — tool-call
 * argument fragments are never forwarded through it.
 *
 * Pure JavaScript (ES modules). No TypeScript, no build step.
 */

import { createLogger } from './logger.js';

const log = createLogger('reasoner');

export class ReasonerError extends Error {
  constructor(message, code = 'REASONER_ERROR') {
    super(message);
    this.name = 'ReasonerError';
    this.code = code;
  }
}

const DEFAULT_MAX_RETRIES = 2;

/**
 * @typedef {Object} RawResponse
 * One of:
 *   { type: 'tool_call', tool: string, args: object, id?: string, reasoning?: string }
 *   { type: 'final', content: string, reasoning?: string }
 *   { type: 'need_clarification', question: string, reasoning?: string }
 *
 * @typedef {Object} ReasonerClient
 * @property {Function} chat - async ({ systemPrompt, messages, tools }) => RawResponse
 *           `messages` is the native history this module maintains:
 *           { role: 'user'|'assistant'|'tool', content, tool_calls?, tool_call_id? }[]
 */

/**
 * Build a reasoner function for AgentLoop.
 *
 * @param {Object} opts
 * @param {ReasonerClient} opts.client - required. The only provider-specific piece;
 *        keep OpenAI/Anthropic/local-model code inside this adapter, nowhere else.
 * @param {string} [opts.systemPrompt]
 * @param {number} [opts.maxRetries=2] retries on transient client.chat() failures
 * @param {boolean} [opts.stream=false] use client.chatStream() (if available) instead of
 *        client.chat() — same Action output, deltas delivered live via `onToken`.
 * @param {Function} [opts.onToken] (text: string) => void — called with final-answer
 *        content chunks as they stream in. Tool-call argument fragments are NOT
 *        forwarded here (they are not user-facing text).
 * @param {Function} [opts.onEvent] (event, payload) => void, for retry/error visibility
 * @returns {Function & {addUser:Function, addToolResult:Function, getHistory:Function, reset:Function}}
 */
export function createReasoner({ client, systemPrompt, maxRetries = DEFAULT_MAX_RETRIES, stream = false, onToken, onEvent } = {}) {
  if (!client || (typeof client.chat !== 'function' && typeof client.chatStream !== 'function')) {
    throw new ReasonerError(
      'createReasoner requires a "client" with a chat({ systemPrompt, messages, tools }) method ' +
        '(or a chatStream({ systemPrompt, messages, tools, onDelta }) method when stream: true).'
    );
  }

  const emit = (event, payload) => {
    try {
      if (typeof onEvent === 'function') onEvent(event, payload);
    } catch (_err) {
      // observability must never break reasoning
    }
  };

  // Streaming token sink — deliberately mutable via reasoner.setTokenSink()
  // so a REPL/UI can attach (or swap) its live-token consumer after the
  // reasoner was built, instead of having to re-create the whole agent.
  let tokenSink = typeof onToken === 'function' ? onToken : null;

  // Native, provider-facing message history. Distinct from ContextWindow:
  // this is what actually gets sent to the model, including tool_call_id
  // correlation most tool-calling APIs require.
  let history = [];
  let callCounter = 0;

  function nextCallId() {
    callCounter += 1;
    return `call_${Date.now()}_${callCounter}`;
  }

  async function reasoner(renderedContext, toolSchema) {
    // Seed native history from ContextWindow's render() on the very first
    // call (or if the reasoner was attached mid-run), so we never talk to
    // the model with a blank slate just because addUser() wasn't called yet.
    if (history.length === 0 && Array.isArray(renderedContext) && renderedContext.length > 0) {
      history = renderedContext
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({ role: m.role, content: m.content }));
    }

    const useStream = stream && typeof client.chatStream === 'function';

    let lastErr;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const startedAt = Date.now();
      log.debug('chat:start', { attempt, stream: useStream, historyLength: history.length, toolCount: (toolSchema || []).length });
      try {
        const raw = useStream
          ? await client.chatStream({
              systemPrompt,
              messages: history,
              tools: toolSchema,
              onDelta: (delta) => {
                if (delta && delta.type === 'content' && tokenSink) {
                  try {
                    tokenSink(delta.text);
                  } catch (_err) {
                    // a broken token consumer must never fail the turn
                  }
                }
              },
            })
          : await client.chat({ systemPrompt, messages: history, tools: toolSchema });
        const action = normalize(raw);
        log.info('chat:done', {
          attempt,
          durationMs: Date.now() - startedAt,
          responseType: raw.type,
          tool: action.tool,
        });
        return action;
      } catch (err) {
        lastErr = err;
        log.warn('chat:retry', { attempt, durationMs: Date.now() - startedAt, error: err && err.message });
        emit('retry', { attempt, error: err && err.message });
      }
    }
    log.error('chat:failed', { attempts: maxRetries + 1, error: lastErr && lastErr.message });
    throw new ReasonerError(
      `reasoner client failed after ${maxRetries + 1} attempt(s): ${lastErr && lastErr.message}`,
      'CLIENT_ERROR'
    );
  }

  function normalize(raw) {
    if (!raw || typeof raw !== 'object') {
      throw new ReasonerError('client.chat() returned a non-object response.');
    }
    switch (raw.type) {
      case 'tool_call': {
        const id = raw.id || nextCallId();
        history.push({
          role: 'assistant',
          content: raw.reasoning || '',
          tool_calls: [{ id, name: raw.tool, args: raw.args || {} }],
        });
        return {
          type: 'tool_call',
          tool: raw.tool,
          args: raw.args || {},
          reasoning: raw.reasoning,
          _toolCallId: id, // AgentLoop echoes this back via reasoner.addToolResult()
        };
      }
      case 'final':
        history.push({ role: 'assistant', content: raw.content });
        return { type: 'final', content: raw.content, reasoning: raw.reasoning };
      case 'need_clarification':
        history.push({ role: 'assistant', content: raw.question });
        return { type: 'need_clarification', question: raw.question, reasoning: raw.reasoning };
      default:
        throw new ReasonerError(`Unknown response type "${raw.type}" from client.chat().`);
    }
  }

  reasoner.addUser = (text) => {
    history.push({ role: 'user', content: text });
  };

  reasoner.addToolResult = (toolCallId, result) => {
    history.push({
      role: 'tool',
      tool_call_id: toolCallId || null,
      content: safeStringify(result),
    });
  };

  /** Snapshot of the native message history actually sent to the model. */
  reasoner.getHistory = () => history.slice();

  /** Clear native history (e.g. when starting a fresh conversation/session). */
  reasoner.reset = () => {
    history = [];
    callCounter = 0;
  };

  /**
   * Attach (or detach, with null) the live token consumer for streamed
   * final-answer content. Called by REPLs/UIs that are built after the
   * reasoner — the sink can be swapped at any time between turns.
   * @param {Function|null} fn
   */
  reasoner.setTokenSink = (fn) => {
    tokenSink = typeof fn === 'function' ? fn : null;
  };

  return reasoner;
}

/**
 * Scripted test/dev client: returns pre-baked RawResponses in sequence,
 * cycling to the last one if the script runs out. No network, no vendor SDK.
 * Handy for exercising createReasoner()/AgentLoop wiring before a real LLM
 * client adapter exists.
 *
 * @param {RawResponse[]} script
 * @returns {ReasonerClient}
 */
export function createScriptedClient(script = []) {
  let i = 0;
  return {
    async chat() {
      const step = script[Math.min(i, script.length - 1)];
      i += 1;
      if (!step) {
        throw new ReasonerError('createScriptedClient: empty script.', 'EMPTY_SCRIPT');
      }
      return step;
    },
  };
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch (_err) {
    return String(value);
  }
}

export default createReasoner;
