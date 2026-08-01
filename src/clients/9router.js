/**
 * clients/9router.js — real LLM client for createReasoner()
 * -----------------------------------------------
 * Implements the `client.chat({ systemPrompt, messages, tools })` contract
 * that src/reasoner.js expects, talking to an OpenAI-compatible
 * `/chat/completions` endpoint with native tool/function calling.
 *
 * ASSUMPTION (no vendor docs were provided for "9router" — flag/confirm if
 * wrong): it is an OpenAI-compatible chat-completions gateway/router — the
 * same shape used by OpenRouter, most local model servers (Ollama, LM
 * Studio, vLLM), and most "LLM router" products. If the real 9router API
 * differs (different auth header, different tool_call schema, different
 * base path), only this file needs to change — reasoner.js and the rest of
 * the loop are unaffected.
 *
 * Config via env (see .env.example):
 *   NINEROUTER_BASE_URL       e.g. https://api.9router.example/v1
 *   NINEROUTER_API_KEY        bearer token
 *   NINEROUTER_MODEL          model id, e.g. "gpt-4o-mini"
 *   NINEROUTER_RESPONSE_FORMAT  optional: "json_object" (forces
 *     response_format:{type:"json_object"} on every request). Only turn
 *     this on if your gateway supports OpenAI's structured-output param —
 *     it is off by default because we have no docs confirming it.
 *
 * `stream` is always explicitly forced to `false`. The original bug report
 * ("Unexpected non-whitespace character after JSON at position N") is the
 * classic symptom of a provider streaming NDJSON/SSE chunks back even
 * though nothing asked for streaming — res.json() then chokes on the 2nd+
 * JSON object concatenated after the 1st. Fixed by (a) never omitting
 * stream:false and (b) recovering defensively: a leaked SSE body is fully
 * accumulated (content concatenated, tool_call argument fragments merged
 * per index — the same accumulateSsePayload() path chatStream uses), and a
 * concatenated-NDJSON body falls back to a balanced-brace scan that pulls
 * out just the first complete JSON object.
 *
 * Pure JavaScript (ES modules), uses global fetch (Node >= 18).
 */

import { createLogger } from '../core/logger.js';

const log = createLogger('clients:9router');

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * @param {Object} [opts]
 * @param {string} [opts.baseUrl] default: process.env.NINEROUTER_BASE_URL
 * @param {string} [opts.apiKey] default: process.env.NINEROUTER_API_KEY
 * @param {string} [opts.model] default: process.env.NINEROUTER_MODEL
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.temperature]
 * @returns {{chat: Function}} a ReasonerClient for createReasoner({ client })
 */
export function createNineRouterClient(opts = {}) {
  const {
    baseUrl = process.env.NINEROUTER_BASE_URL,
    apiKey = process.env.NINEROUTER_API_KEY,
    model = process.env.NINEROUTER_MODEL,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    temperature = 0.2,
    responseFormat = process.env.NINEROUTER_RESPONSE_FORMAT || null,
  } = opts;

  if (!baseUrl) throw configError('NINEROUTER_BASE_URL is required (env or opts.baseUrl).');
  if (!apiKey) throw configError('NINEROUTER_API_KEY is required (env or opts.apiKey).');
  if (!model) throw configError('NINEROUTER_MODEL is required (env or opts.model).');

  const endpoint = new URL('chat/completions', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);

  return {
    async chat({ systemPrompt, messages, tools }) {
      const body = {
        model,
        temperature,
        stream: false, // never let the gateway default us into NDJSON/SSE chunking
        messages: toOpenAiMessages(systemPrompt, messages),
      };
      if (Array.isArray(tools) && tools.length > 0) {
        body.tools = tools.map(toOpenAiTool);
        body.tool_choice = 'auto';
      }
      // Only set response_format when tools are NOT in play — the two are
      // mutually exclusive on every OpenAI-compatible gateway we know of
      // (a JSON-object/json_schema constraint disables function calling).
      if (responseFormat && !body.tools) {
        body.response_format =
          typeof responseFormat === 'string' ? { type: responseFormat } : responseFormat;
      }

      const startedAt = Date.now();
      log.info('chat:request', {
        endpoint: endpoint.toString(),
        model,
        temperature,
        messageCount: body.messages.length,
        toolCount: body.tools ? body.tools.length : 0,
        responseFormat: body.response_format || null,
        apiKey: '[REDACTED]',
      });

      const res = await post(endpoint, body, { timeoutMs, startedAt, apiKey });
      const rawText = await safeText(res);
      const payload = parseJsonResponse(rawText);
      const response = fromOpenAiResponse(payload);
      log.info('chat:response', {
        status: res.status,
        durationMs: Date.now() - startedAt,
        responseType: response.type,
        tool: response.tool,
        finishReason: payload && payload.choices && payload.choices[0] && payload.choices[0].finish_reason,
        usage: payload && payload.usage,
      });
      return response;
    },

    /**
     * Streaming variant of chat(): same request body except `stream: true`,
     * same RawResponse return value (so createReasoner() normalizes it
     * identically), but content/tool-call deltas are emitted as they arrive
     * via `onDelta({ type: 'content'|'tool_call_args', text })` instead of
     * arriving all at once at the end. The SSE stream is accumulated
     * line-by-line; tool_call `arguments` fragments are merged per tool-call
     * index, and a defensive fallback handles gateways that answer a
     * stream:true request with one plain JSON object anyway (or that leak
     * NDJSON/SSE on stream:false — see parseJsonResponse).
     * @param {Object} opts
     * @param {string} [opts.systemPrompt]
     * @param {Array} [opts.messages]
     * @param {Array} [opts.tools]
     * @param {Function} [opts.onDelta] (delta: {type:'content'|'tool_call_args', text:string}) => void
     * @param {AbortSignal} [opts.signal]
     * @returns {Promise<RawResponse>} same shape as chat()
     */
    async chatStream({ systemPrompt, messages, tools, onDelta, signal }) {
      const body = {
        model,
        temperature,
        stream: true,
        messages: toOpenAiMessages(systemPrompt, messages),
      };
      if (Array.isArray(tools) && tools.length > 0) {
        body.tools = tools.map(toOpenAiTool);
        body.tool_choice = 'auto';
      }
      if (responseFormat && !body.tools) {
        body.response_format =
          typeof responseFormat === 'string' ? { type: responseFormat } : responseFormat;
      }

      const startedAt = Date.now();
      log.info('chat:request', {
        endpoint: endpoint.toString(),
        model,
        temperature,
        stream: true,
        messageCount: body.messages.length,
        toolCount: body.tools ? body.tools.length : 0,
        responseFormat: body.response_format || null,
        apiKey: '[REDACTED]',
      });

      const res = await post(endpoint, body, { timeoutMs, startedAt, signal, apiKey });
      const payload = await readSsePayload(res, { onDelta });
      const response = fromOpenAiResponse(payload);
      log.info('chat:response', {
        status: res.status,
        durationMs: Date.now() - startedAt,
        responseType: response.type,
        tool: response.tool,
        stream: true,
        finishReason: payload && payload.choices && payload.choices[0] && payload.choices[0].finish_reason,
      });
      return response;
    },
  };
}

/**
 * Shared POST for chat() and chatStream(). Throws on network failure or a
 * non-2xx status, exactly as chat() used to.
 */
async function post(endpoint, body, { timeoutMs, startedAt, signal, apiKey }) {
  const controller = new AbortController();
  const onOuterAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onOuterAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(endpoint.toString(), {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    log.error('chat:request_failed', { durationMs: Date.now() - startedAt, error: err.message });
    throw clientError(`9router request failed: ${err.message}`, 'REQUEST_FAILED');
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onOuterAbort);
  }

  if (!res.ok) {
    const text = await safeText(res);
    log.error('chat:http_error', {
      status: res.status,
      durationMs: Date.now() - startedAt,
      body: text.slice(0, 500),
    });
    throw clientError(`9router returned HTTP ${res.status}: ${text.slice(0, 500)}`, 'HTTP_ERROR');
  }
  return res;
}

/**
 * Read a chat-completions response body and reduce it to one OpenAI-shaped
 * `payload` object ({choices:[{message, finish_reason}]}). Handles:
 *   1. A real SSE stream (stream:true) — accumulates `delta.content` and
 *      merges `delta.tool_calls` argument fragments per index, emitting each
 *      content chunk through `onDelta` as it arrives.
 *   2. A plain JSON object body (a gateway that ignores stream:true) —
 *      parsed whole, returned as-is.
 *   3. NDJSON/SSE-leaked-on-stream:false bodies — recovered via
 *      parseJsonResponse()'s defensive fallbacks.
 */
async function readSsePayload(res, { onDelta } = {}) {
  const decoder = new TextDecoder();
  let buffer = '';
  let rawText = '';
  const objects = [];

  const reader = res.body && typeof res.body.getReader === 'function' ? res.body.getReader() : null;
  if (!reader) {
    // No streaming body at all (e.g. a mocked Response with only text()) —
    // parse whatever came back as one payload.
    const text = await safeText(res);
    return parseJsonResponse(text);
  }

  try {
    let done = false;
    while (!done) {
      const { done: streamDone, value } = await reader.read();
      if (streamDone) break;
      const text = decoder.decode(value, { stream: true });
      rawText += text;
      buffer += text;
      let newline;
      while (!done && (newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.startsWith('data:')) {
          const data = line.slice(5).trim();
          if (data === '[DONE]') {
            done = true; // stop consuming — anything after [DONE] is trailer
            break;
          }
          pushParsed(objects, data);
        }
      }
    }
    if (!done && buffer.trim()) {
      const line = buffer.trim();
      if (line.startsWith('data:')) pushParsed(objects, line.slice(5).trim());
    }
  } catch (err) {
    throw clientError(`9router stream read failed: ${err.message}`, 'STREAM_FAILED');
  }

  // No SSE objects at all (e.g. a gateway that ignores stream:true and
  // answers with one plain JSON object, or a non-SSE error page) — fall back
  // to the same defensive whole-body parsing chat() uses.
  if (objects.length === 0) return parseJsonResponse(rawText || buffer);

  return accumulateSsePayload(objects, { onDelta });
}

/** Parse one SSE `data:` payload into `objects`, ignoring [DONE]/keepalives/unparseable lines. */
function pushParsed(objects, data) {
  if (!data || data === '[DONE]') return;
  try {
    objects.push(JSON.parse(data));
  } catch (_err) {
    // keepalive comments, partial lines, etc. — ignore
  }
}

/**
 * Reduce a list of OpenAI-style stream chunks into one chat-completions
 * `payload` ({choices:[{message, finish_reason}]}): concatenates
 * `delta.content`, merges `delta.tool_calls` argument fragments per index,
 * and forwards each content/tool_call_args delta to `onDelta` as it is
 * folded in. This is the single accumulation path used BOTH by live SSE
 * streaming (chatStream) and by the defensive recovery of an SSE body that
 * leaked out of a stream:false request.
 */
function accumulateSsePayload(objects, { onDelta } = {}) {
  let content = '';
  /** @type {Map<number, {id: string|null, name: string, args: string}>} */
  const toolCalls = new Map();
  let finishReason = null;

  for (const chunk of objects) {
    const choice = chunk && chunk.choices && chunk.choices[0];
    const delta = (choice && choice.delta) || {};
    if (typeof delta.content === 'string' && delta.content.length > 0) {
      content += delta.content;
      emitDelta(onDelta, 'content', delta.content);
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        if (!tc || typeof tc.index !== 'number') continue;
        const entry = toolCalls.get(tc.index) || { id: null, name: '', args: '' };
        if (tc.id) entry.id = tc.id;
        if (tc.function && typeof tc.function.name === 'string') entry.name += tc.function.name;
        if (tc.function && typeof tc.function.arguments === 'string') {
          entry.args += tc.function.arguments;
          emitDelta(onDelta, 'tool_call_args', tc.function.arguments);
        }
        toolCalls.set(tc.index, entry);
      }
    }
    if (choice && choice.finish_reason) finishReason = choice.finish_reason;
  }

  if (toolCalls.size > 0) {
    const calls = [...toolCalls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, tc]) => ({
        id: tc.id || undefined,
        type: 'function',
        function: { name: tc.name, arguments: tc.args || '{}' },
      }));
    return { choices: [{ message: { role: 'assistant', content: content || null, tool_calls: calls }, finish_reason: finishReason }] };
  }
  return { choices: [{ message: { role: 'assistant', content }, finish_reason: finishReason }] };
}

function emitDelta(onDelta, type, text) {
  if (typeof onDelta !== 'function') return;
  try {
    onDelta({ type, text });
  } catch (_err) {
    // a broken observer must never kill the stream
  }
}

function toOpenAiMessages(systemPrompt, messages) {
  const out = [];
  if (systemPrompt) out.push({ role: 'system', content: systemPrompt });
  for (const m of messages || []) {
    // DeepSeek (and several other OpenAI-compatible gateways) reject
    // `content: null` outright with "invalid type: null, expected a string".
    // An assistant turn that only emits tool_calls legitimately has *no text*
    // content — the reasoner stores it as an empty string (''), but a naive
    // `content || null` collapses that to JSON null and the provider dies on
    // it. Coerce to a string everywhere so no message ever carries a
    // null/undefined content: '' is universally accepted and semantically
    // identical (no text) for an assistant turn with tool_calls.
    const content = typeof m.content === 'string' ? m.content : '';
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      out.push({
        role: 'assistant',
        content,
        tool_calls: m.tool_calls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.args || {}) },
        })),
      });
    } else if (m.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: m.tool_call_id, content });
    } else {
      out.push({ role: m.role, content });
    }
  }
  return out;
}

function toOpenAiTool(toolDef) {
  const properties = {};
  const required = [];
  for (const [key, spec] of Object.entries(toolDef.parameters || {})) {
    properties[key] = {
      type: spec.type === 'array' ? 'array' : spec.type === 'object' ? 'object' : spec.type || 'string',
    };
    if (spec.description) properties[key].description = spec.description;
    if (Array.isArray(spec.enum)) properties[key].enum = spec.enum;
    if (spec.required) required.push(key);
  }
  return {
    type: 'function',
    function: {
      name: toolDef.name,
      description: toolDef.description || '',
      parameters: { type: 'object', properties, required },
    },
  };
}

/** Map an OpenAI-shaped chat.completions response to reasoner.js's RawResponse. */
function fromOpenAiResponse(payload) {
  const choice = payload && payload.choices && payload.choices[0];
  const message = choice && choice.message;
  if (!message) {
    throw clientError('9router response missing choices[0].message.', 'BAD_RESPONSE');
  }

  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    const call = message.tool_calls[0];
    let args = {};
    try {
      args = call.function && call.function.arguments ? JSON.parse(call.function.arguments) : {};
    } catch (_err) {
      args = {};
    }
    return {
      type: 'tool_call',
      tool: call.function && call.function.name,
      args,
      id: call.id,
      reasoning: message.content || undefined,
    };
  }

  return { type: 'final', content: message.content || '' };
}

/**
 * Parse a chat-completions body defensively. Handles three shapes:
 *   1. Clean single JSON object (the happy path).
 *   2. SSE stream leaked through despite stream:false, e.g.
 *      "data: {...}\n\ndata: {...}\n\ndata: [DONE]\n\n" — ALL "data:"
 *      payloads are accumulated into one message (content concatenated,
 *      tool_call argument fragments merged per index), so both aggregated
 *      chunks and real OpenAI-style delta streams recover correctly.
 *   3. NDJSON / multiple JSON objects concatenated back to back (the exact
 *      bug reported: "Unexpected non-whitespace character after JSON at
 *      position N") — take the first complete, balanced JSON object.
 */
function parseJsonResponse(rawText) {
  const text = (rawText || '').trim();
  if (!text) throw clientError('9router returned an empty body.', 'BAD_JSON');

  try {
    return JSON.parse(text);
  } catch (_err) {
    // fall through to recovery strategies below
  }

  if (text.includes('data:')) {
    const objects = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('data:')) pushParsed(objects, trimmed.slice(5).trim());
    }
    if (objects.length > 0) return accumulateSsePayload(objects);
  }

  const firstObject = extractFirstJsonObject(text);
  if (firstObject) {
    try {
      return JSON.parse(firstObject);
    } catch (_err) {
      // give up below with a clear error
    }
  }

  throw clientError(
    `9router returned non-JSON body: could not recover a JSON object from a ` +
      `${text.length}-char response (checked for SSE "data:" framing and NDJSON ` +
      `concatenation). First 200 chars: ${text.slice(0, 200)}`,
    'BAD_JSON',
  );
}

/** Balanced-brace scan: returns the substring of the first complete {...} object, or null. */
function extractFirstJsonObject(text) {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

async function safeText(res) {
  try {
    return await res.text();
  } catch (_err) {
    return '';
  }
}

function clientError(message, code) {
  const err = new Error(message);
  err.code = code || 'NINEROUTER_ERROR';
  return err;
}

function configError(message) {
  return clientError(message, 'CONFIG_ERROR');
}

export default createNineRouterClient;
