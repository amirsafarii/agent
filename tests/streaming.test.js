/**
 * streaming.test.js — chatStream() + the streamed reasoner path
 * ------------------------------------------------------------
 * SSE delta accumulation (content), tool_call argument fragment merging,
 * [DONE]/trailing-garbage handling, plain-JSON fallback for gateways that
 * ignore stream:true, HTTP errors, reasoner-level fallback to chat() when
 * the client has no chatStream, and end-to-end AgentLoop + streaming
 * reasoner behavior (onToken receives final-answer chunks only).
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createNineRouterClient } from '../src/clients/9router.js';
import { createReasoner, createScriptedClient } from '../src/reasoner.js';
import { AgentLoop } from '../src/loop.js';
import { ToolRegistry } from '../src/tools.js';
import { ContextWindow } from '../src/context.js';

const BASE = { baseUrl: 'https://nine.example/v1', apiKey: 'sk-test', model: 'gpt-4o-mini' };

function sseResponse(chunks) {
  const stream = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

let lastBody = null;
const originalFetch = global.fetch;

beforeEach(() => {
  lastBody = null;
});

test.after(() => {
  global.fetch = originalFetch;
});

test('chatStream: sends stream:true and accumulates content deltas via onDelta', async () => {
  global.fetch = async (url, init) => {
    lastBody = JSON.parse(init.body);
    return sseResponse([
      'data: {"choices":[{"delta":{"role":"assistant","content":"Hello"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{"content":" world"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ]);
  };
  const client = createNineRouterClient(BASE);
  const deltas = [];
  const response = await client.chatStream({
    systemPrompt: 'sys',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    onDelta: (d) => deltas.push(d),
  });

  assert.equal(lastBody.stream, true, 'stream:true in the request body');
  assert.equal(response.type, 'final');
  assert.equal(response.content, 'Hello world');
  assert.deepEqual(deltas, [
    { type: 'content', text: 'Hello' },
    { type: 'content', text: ' world' },
  ]);
});

test('chatStream: merges tool_call argument fragments across chunks into one call', async () => {
  global.fetch = async () =>
    sseResponse([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"web_","arguments":""}}]},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"search","arguments":"{\\"q\\":"}}]},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"nodejs\\"}"}}]},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
    ]);
  const client = createNineRouterClient(BASE);
  const deltas = [];
  const response = await client.chatStream({
    messages: [{ role: 'user', content: 'search' }],
    tools: [{ name: 'web_search', description: '', parameters: {} }],
    onDelta: (d) => deltas.push(d),
  });

  assert.equal(response.type, 'tool_call');
  assert.equal(response.tool, 'web_search', 'name fragments concatenated');
  assert.deepEqual(response.args, { q: 'nodejs' }, 'argument fragments merged and parsed');
  assert.equal(response.id, 'call_1');
  assert.deepEqual(
    deltas.filter((d) => d.type === 'tool_call_args').map((d) => d.text),
    ['', '{"q":', '"nodejs"}']
  );
});

test('chatStream: a plain JSON body (gateway ignores stream:true) still parses', async () => {
  global.fetch = async () =>
    new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'plain ok' } }] }), { status: 200 });
  const client = createNineRouterClient(BASE);
  const response = await client.chatStream({ messages: [] });
  assert.equal(response.type, 'final');
  assert.equal(response.content, 'plain ok');
});

test('chatStream: trailing garbage after [DONE] is ignored', async () => {
  global.fetch = async () =>
    sseResponse([
      'data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
      'data: {"choices":[{"delta":{"content":"SHOULD NOT APPEAR"},"finish_reason":null}]}\n\n',
      'garbage line that is not data:\n\n',
    ]);
  const client = createNineRouterClient(BASE);
  const response = await client.chatStream({ messages: [] });
  assert.equal(response.content, 'done');
});

test('chatStream: HTTP errors throw HTTP_ERROR with status', async () => {
  global.fetch = async () => new Response('{"error":"over quota"}', { status: 402 });
  const client = createNineRouterClient(BASE);
  await assert.rejects(() => client.chatStream({ messages: [] }), (err) => {
    assert.equal(err.code, 'HTTP_ERROR');
    assert.match(err.message, /402/);
    return true;
  });
});

test('reasoner: uses chatStream when stream:true and falls back to chat otherwise', async () => {
  let chatCalls = 0;
  let streamCalls = 0;
  const client = {
    async chat() {
      chatCalls += 1;
      return { type: 'final', content: 'non-stream' };
    },
    async chatStream() {
      streamCalls += 1;
      return { type: 'final', content: 'streamed' };
    },
  };

  const plain = createReasoner({ client });
  assert.equal((await plain([], [])).content, 'non-stream');
  assert.equal(chatCalls, 1);
  assert.equal(streamCalls, 0);

  const streaming = createReasoner({ client, stream: true });
  assert.equal((await streaming([], [])).content, 'streamed');
  assert.equal(streamCalls, 1);
});

test('reasoner: onToken gets final-answer chunks, not tool_call fragments', async () => {
  const tokens = [];
  const client = {
    async chatStream({ onDelta }) {
      onDelta({ type: 'content', text: 'Part ' });
      onDelta({ type: 'content', text: 'two.' });
      onDelta({ type: 'tool_call_args', text: '{"x":' });
      return { type: 'final', content: 'Part two.' };
    },
  };
  const reasoner = createReasoner({ client, stream: true, onToken: (t) => tokens.push(t) });
  const action = await reasoner([], []);
  assert.equal(action.type, 'final');
  assert.deepEqual(tokens, ['Part ', 'two.']);
});

test('reasoner: streaming retries on a throwing chatStream like chat', async () => {
  let calls = 0;
  const client = {
    async chatStream() {
      calls += 1;
      if (calls < 2) throw new Error('stream hiccup');
      return { type: 'final', content: 'stream recovered' };
    },
  };
  const reasoner = createReasoner({ client, stream: true });
  const action = await reasoner([], []);
  assert.equal(action.content, 'stream recovered');
  assert.equal(calls, 2);
});

test('end-to-end: AgentLoop + streamed 9router reasoner keeps the loop contract intact', async () => {
  const tokens = [];
  // The REAL 9router client (parses the SSE itself); only fetch is stubbed:
  // call 1 streams a tool_call (add 1+2), call 2 streams the final answer.
  const toolCallChunks = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_s1","function":{"name":"add","arguments":"{\\"a\\":1,\\"b\\":2}"}}]},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
    'data: [DONE]\n\n',
  ];
  const finalChunks = [
    'data: {"choices":[{"delta":{"content":"the "},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"delta":{"content":"sum"},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ];
  let call = 0;
  global.fetch = async (url, init) => {
    lastBody = JSON.parse(init.body);
    assert.equal(lastBody.stream, true, 'the loop drives streaming requests');
    call += 1;
    return sseResponse(call === 1 ? toolCallChunks : finalChunks);
  };

  const reasoner = createReasoner({ client: createNineRouterClient(BASE), stream: true, onToken: (t) => tokens.push(t) });
  const tools = new ToolRegistry();
  tools.register({
    name: 'add',
    description: 'add',
    parameters: { a: { type: 'number', required: true }, b: { type: 'number', required: true } },
    handler: async ({ a, b }) => a + b,
  });
  const loop = new AgentLoop({ context: new ContextWindow({ maxTokens: 8000 }), tools, reasoner, toolRetry: { backoffMs: 1 } });

  const result = await loop.run('what is 1+2?');
  assert.equal(result.status, 'final');
  assert.equal(result.content, 'the sum');
  assert.deepEqual(tokens, ['the ', 'sum'], 'onToken received the streamed content chunks');
  assert.equal(result.steps, 2, 'tool call step + final step');
  const observe = result.stepMemory.find((r) => r.phase === 'observe');
  assert.equal(observe.result.data, 3);
});

test('createScriptedClient is streaming-compatible (same chat shape)', async () => {
  const scripted = createScriptedClient([
    { type: 'tool_call', tool: 'x', args: {} },
    { type: 'final', content: 'ok' },
  ]);
  const reasoner = createReasoner({ client: scripted, stream: true }); // no chatStream -> falls back to chat
  const a1 = await reasoner([], []);
  assert.equal(a1.type, 'tool_call');
  const a2 = await reasoner([], []);
  assert.equal(a2.content, 'ok');
});
