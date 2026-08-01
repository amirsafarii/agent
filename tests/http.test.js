import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpTools } from '../src/tools/http.js';
import { ToolRegistry } from '../src/tools/index.js';

function stubFetch(handler) {
  const original = global.fetch;
  global.fetch = handler;
  return () => { global.fetch = original; };
}

test('http tools: register http_get/http_post/http_request', () => {
  const tools = createHttpTools({ allowedDomains: '*' });
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['http_get', 'http_post', 'http_request']);
  for (const t of tools) assert.equal(t.version, '1.0.0');
});

test('http_get: returns parsed JSON with meta (truncation flag)', async () => {
  const restore = stubFetch(async (url) => new Response(JSON.stringify({ hello: 'world' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }));
  try {
    const tools = createHttpTools({ allowedDomains: '*' });
    const reg = new ToolRegistry();
    for (const t of tools) reg.register(t);
    const r = await reg.execute('http_get', { url: 'https://example.com/data' });
    assert.equal(r.ok, true);
    assert.equal(r.data.status, 200);
    assert.deepEqual(r.data.data, { hello: 'world' });
    assert.equal(r.meta.source, 'http_get');
    assert.equal(typeof r.meta.durationMs, 'number');
  } finally {
    restore();
  }
});

test('http_request: POST sends body and returns non-2xx as typed failure', async () => {
  let captured;
  const restore = stubFetch(async (url, init) => {
    captured = { url, method: init.method, body: init.body, headers: init.headers };
    return new Response('not found', { status: 404, statusText: 'Not Found' });
  });
  try {
    const tools = createHttpTools({ allowedDomains: '*' });
    const reg = new ToolRegistry();
    for (const t of tools) reg.register(t);
    const r = await reg.execute('http_post', { url: 'https://example.com/thing', body: 'payload' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'HTTP_STATUS');
    assert.equal(r.errorInfo.code, 'HTTP_STATUS');
    assert.equal(r.errorInfo.retryable, false);
    assert.equal(captured.method, 'POST');
    assert.equal(captured.body, 'payload');
  } finally {
    restore();
  }
});

test('http tools: blocked domain is a typed, non-retryable failure', async () => {
  const restore = stubFetch(async () => new Response('', { status: 200 }));
  try {
    const tools = createHttpTools({ allowedDomains: ['trusted.example.com'] });
    const reg = new ToolRegistry();
    for (const t of tools) reg.register(t);
    const r = await reg.execute('http_get', { url: 'https://evil.example.com/x' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'DOMAIN_BLOCKED');
    assert.equal(r.errorInfo.retryable, false);
  } finally {
    restore();
  }
});

test('http tools: timeout yields a typed TIMEOUT failure', async () => {
  const restore = stubFetch(async (url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      reject(err);
    });
  }));
  try {
    const tools = createHttpTools({ timeoutMs: 20 });
    const reg = new ToolRegistry();
    for (const t of tools) reg.register(t);
    const r = await reg.execute('http_get', { url: 'https://slow.example.com/x' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'TIMEOUT');
  } finally {
    restore();
  }
});

test('http_get: redirect limit is bounded (manual redirect following)', async () => {
  let n = 0;
  const restore = stubFetch(async (url) => {
    n += 1;
    if (n <= 10) return new Response('', { status: 302, headers: { location: '/next' } });
    return new Response('final', { status: 200 });
  });
  try {
    const tools = createHttpTools({ allowedDomains: '*', redirectLimit: 3 });
    const reg = new ToolRegistry();
    for (const t of tools) reg.register(t);
    const r = await reg.execute('http_get', { url: 'https://example.com/a' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'TOO_MANY_REDIRECTS');
  } finally {
    restore();
  }
});
