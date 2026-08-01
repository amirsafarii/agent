/**
 * 9router.test.js — the OpenAI-compatible client adapter
 * ------------------------------------------------------
 * Covers: request shape (stream:false always, tools, response_format
 * dropped when tools are attached), clean-JSON parsing, NDJSON recovery,
 * SSE-leak recovery, unrecoverable-body errors, HTTP errors, missing
 * config errors, and tool_call mapping. All fetch calls are stubbed — no
 * network dependency in the suite.
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createNineRouterClient } from '../src/clients/9router.js';

const BASE = { baseUrl: 'https://nine.example/v1', apiKey: 'sk-test', model: 'gpt-4o-mini' };

let lastRequest = null; // { url, body }
const originalFetch = global.fetch;

beforeEach(() => {
  lastRequest = null;
  global.fetch = async (url, init) => {
    lastRequest = { url, body: JSON.parse(init.body) };
    return new Response(
      JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  };
});

test.after(() => {
  global.fetch = originalFetch;
});

test('request shape: stream:false, bearer auth, endpoint, tools array', async () => {
  const client = createNineRouterClient(BASE);
  const response = await client.chat({
    systemPrompt: 'be terse',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ name: 'search', description: 'web search', parameters: { q: { type: 'string', required: true } } }],
  });

  assert.equal(response.type, 'final');
  assert.equal(response.content, 'ok');
  assert.ok(lastRequest.url.includes('/v1/chat/completions'));
  assert.equal(lastRequest.body.stream, false, 'stream:false is always explicit');
  assert.equal(lastRequest.body.model, 'gpt-4o-mini');
  assert.equal(lastRequest.body.messages[0].role, 'system');
  assert.equal(lastRequest.body.tools.length, 1);
  assert.equal(lastRequest.body.tools[0].function.name, 'search');
  assert.equal(lastRequest.body.tools[0].function.parameters.required[0], 'q');
  assert.equal(lastRequest.body.tool_choice, 'auto');
});

test('response_format is applied without tools and dropped when tools are attached', async () => {
  const plain = createNineRouterClient({ ...BASE, responseFormat: 'json_object' });
  await plain.chat({ messages: [{ role: 'user', content: 'hi' }], tools: [] });
  assert.deepEqual(lastRequest.body.response_format, { type: 'json_object' });

  const withTools = createNineRouterClient({ ...BASE, responseFormat: 'json_object' });
  await withTools.chat({ messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 't', description: '', parameters: {} }] });
  assert.equal(lastRequest.body.response_format, undefined, 'response_format and tools are mutually exclusive');
});

test('maps an OpenAI tool_call response into a RawResponse with parsed args', async () => {
  global.fetch = async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'let me check',
              tool_calls: [
                { id: 'call_x', type: 'function', function: { name: 'web_search', arguments: '{"q":"nodejs"}' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }),
      { status: 200 }
    );
  const client = createNineRouterClient(BASE);
  const response = await client.chat({ messages: [{ role: 'user', content: 'search' }], tools: [] });
  assert.equal(response.type, 'tool_call');
  assert.equal(response.tool, 'web_search');
  assert.deepEqual(response.args, { q: 'nodejs' });
  assert.equal(response.id, 'call_x');
  assert.equal(response.reasoning, 'let me check');
});

test('recovers from NDJSON (concatenated JSON objects) — the original production bug', async () => {
  const body =
    '{"choices":[{"message":{"role":"assistant","content":"first"},"finish_reason":"stop"}]}' +
    '{"choices":[{"message":{"role":"assistant","content":"second"},"finish_reason":"stop"}]}';
  global.fetch = async () => new Response(body, { status: 200 });
  const client = createNineRouterClient(BASE);
  const response = await client.chat({ messages: [] });
  assert.equal(response.content, 'first', 'takes the first complete JSON object');
});

test('recovers from an SSE stream leaked on stream:false (accumulates all deltas)', async () => {
  const body = [
    'data: {"choices":[{"delta":{"content":"Hel"},"finish_reason":null}]}',
    '',
    'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":null}]}',
    '',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
    '',
    'data: [DONE]',
    '',
  ].join('\n');
  global.fetch = async () => new Response(body, { status: 200 });
  const client = createNineRouterClient(BASE);
  const response = await client.chat({ messages: [] });
  assert.equal(response.content, 'Hello', 'all delta content is concatenated into one message');
});

test('throws BAD_JSON with the first 200 chars when the body is unrecoverable', async () => {
  global.fetch = async () => new Response('<html>gateway error page</html>', { status: 200 });
  const client = createNineRouterClient(BASE);
  await assert.rejects(() => client.chat({ messages: [] }), (err) => {
    assert.equal(err.code, 'BAD_JSON');
    assert.match(err.message, /<html>gateway error page<\/html>/);
    return true;
  });
});

test('throws HTTP_ERROR with status and body snippet on non-2xx', async () => {
  global.fetch = async () => new Response('{"error":"rate limited"}', { status: 429 });
  const client = createNineRouterClient(BASE);
  await assert.rejects(() => client.chat({ messages: [] }), (err) => {
    assert.equal(err.code, 'HTTP_ERROR');
    assert.match(err.message, /429/);
    return true;
  });
});

test('throws REQUEST_FAILED when fetch itself rejects', async () => {
  global.fetch = async () => {
    throw new Error('ECONNREFUSED');
  };
  const client = createNineRouterClient(BASE);
  await assert.rejects(() => client.chat({ messages: [] }), (err) => {
    assert.equal(err.code, 'REQUEST_FAILED');
    assert.match(err.message, /ECONNREFUSED/);
    return true;
  });
});

test('requires NINEROUTER_BASE_URL / API_KEY / MODEL', () => {
  assert.throws(() => createNineRouterClient({ apiKey: 'k', model: 'm' }), (err) => err.code === 'CONFIG_ERROR');
  assert.throws(() => createNineRouterClient({ baseUrl: 'http://x', model: 'm' }), (err) => err.code === 'CONFIG_ERROR');
  assert.throws(() => createNineRouterClient({ baseUrl: 'http://x', apiKey: 'k' }), (err) => err.code === 'CONFIG_ERROR');
});

test('serializes the native tool-call history into OpenAI tool messages', async () => {
  const client = createNineRouterClient(BASE);
  await client.chat({
    messages: [
      { role: 'user', content: 'compute' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', name: 'add', args: { a: 1, b: 2 } }] },
      { role: 'tool', tool_call_id: 'c1', content: '3' },
    ],
  });
  const msgs = lastRequest.body.messages;
  assert.equal(msgs.length, 3);
  assert.equal(msgs[1].role, 'assistant');
  assert.equal(msgs[1].tool_calls[0].id, 'c1');
  assert.equal(msgs[1].tool_calls[0].type, 'function');
  assert.equal(msgs[1].tool_calls[0].function.arguments, '{"a":1,"b":2}');
  assert.equal(msgs[2].role, 'tool');
  assert.equal(msgs[2].tool_call_id, 'c1');
});
