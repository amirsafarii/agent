/**
 * logger.test.js — sanitize(): redaction + clipping
 * -------------------------------------------------
 * The one safety property every log line depends on: credential-shaped
 * keys are redacted recursively (but legitimate token-count fields are
 * NOT), long strings are clipped, arrays are capped, and the sanitizer
 * never throws on cyclic/exotic input.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitize } from '../src/core/logger.js';

test('redacts credential-shaped keys recursively', () => {
  const out = sanitize({
    apiKey: 'sk-secret',
    api_key: 'a',
    API_KEY: 'b',
    password: 'hunter2',
    authorization: 'Bearer xxx',
    accessToken: 'tok',
    refresh_token: 'rt',
    secret: 's',
    nested: { deep: { authToken: 'nested-secret' } },
  });
  assert.equal(out.apiKey, '[REDACTED]');
  assert.equal(out.api_key, '[REDACTED]');
  assert.equal(out.API_KEY, '[REDACTED]');
  assert.equal(out.password, '[REDACTED]');
  assert.equal(out.authorization, '[REDACTED]');
  assert.equal(out.accessToken, '[REDACTED]');
  assert.equal(out.refresh_token, '[REDACTED]');
  assert.equal(out.secret, '[REDACTED]');
  assert.equal(out.nested.deep.authToken, '[REDACTED]');
});

test('does NOT redact legitimate token-count or id fields', () => {
  const out = sanitize({
    usedTokens: 1234,
    maxTokens: 8000,
    totalTokens: 9000,
    toolCallId: 'call_1',
    attempt: 2,
    tool: 'search',
  });
  assert.equal(out.usedTokens, 1234);
  assert.equal(out.maxTokens, 8000);
  assert.equal(out.totalTokens, 9000);
  assert.equal(out.toolCallId, 'call_1');
  assert.equal(out.attempt, 2);
  assert.equal(out.tool, 'search');
});

test('redacts a bare "token" key and items inside arrays', () => {
  const out = sanitize({ token: 'abc', list: [{ token: 'x', name: 'ok' }] });
  assert.equal(out.token, '[REDACTED]');
  assert.equal(out.list[0].token, '[REDACTED]');
  assert.equal(out.list[0].name, 'ok');
});

test('clips long strings with a truncation marker', () => {
  const big = 'x'.repeat(5000);
  const out = sanitize({ output: big, small: 'tiny' });
  assert.equal(out.small, 'tiny');
  assert.equal(out.output.length, 800 + '...[truncated 4200 chars]'.length);
  assert.match(out.output, /\.\.\.\[truncated 4200 chars\]$/);
});

test('caps arrays at 20 entries with a remainder marker', () => {
  const out = sanitize({ list: Array.from({ length: 50 }, (_, i) => i) });
  assert.equal(out.list.length, 21);
  assert.equal(out.list[20], '...[+30 more]');
});

test('handles errors, nulls, and depth limits without throwing', () => {
  const err = new Error('boom');
  err.code = 'E1';
  const out = sanitize({ err });
  assert.equal(out.err.message, 'boom');
  assert.equal(out.err.code, 'E1');

  assert.equal(sanitize(null), null);
  assert.equal(sanitize(undefined), undefined);

  const deep = { a: { b: { c: { d: { e: { f: { g: 'too deep' } } } } } } };
  const deepOut = sanitize(deep);
  assert.equal(deepOut.a.b.c.d.e.f, '[max depth]');
});
