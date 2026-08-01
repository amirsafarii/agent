import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RetryPolicy, getRetryPolicyForTool } from '../src/core/loop/retry-policy.js';

test('RetryPolicy: computes exponential backoff and jitter', () => {
  const policy = new RetryPolicy({
    maxAttempts: 3,
    initialDelayMs: 100,
    jitter: false,
  });

  assert.equal(policy.shouldRetry(1, 'EXECUTION_ERROR'), true);
  assert.equal(policy.shouldRetry(3, 'EXECUTION_ERROR'), false); // max 3 attempts total

  assert.equal(policy.getDelay(1), 100);
  assert.equal(policy.getDelay(2), 200);
});

test('RetryPolicy: respects maximum delay cap', () => {
  const policy = new RetryPolicy({
    maxAttempts: 5,
    initialDelayMs: 1000,
    maxDelayMs: 1500,
    jitter: false,
  });

  assert.equal(policy.getDelay(3), 1500); // capped at maxDelayMs
});

test('RetryPolicy: tool-specific policies are resolved correctly', () => {
  const custom = {
    web_search: new RetryPolicy({ maxAttempts: 5 }),
  };

  const webPolicy = getRetryPolicyForTool('web_search', custom);
  assert.equal(webPolicy.maxAttempts, 5);

  const deletePolicy = getRetryPolicyForTool('delete_file', custom);
  assert.equal(deletePolicy.maxAttempts, 1); // never retry delete_file from defaults

  const fallbackPolicy = getRetryPolicyForTool('other_tool', custom, { maxAttempts: 4 });
  assert.equal(fallbackPolicy.maxAttempts, 4);
});
