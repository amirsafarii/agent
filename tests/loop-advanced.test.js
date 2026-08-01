/**
 * loop-advanced.test.js — AgentLoop advanced behaviors
 * ------------------------------------------------------
 * 9 tests: retry, exhaustion, fail-fast, task timeout, max tokens,
 * compression, custom stop condition, invalid action, step memory.
 * See LOOP.md → section 19 for the exact contract each test proves.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentLoop, TerminationReason, LoopEvents } from '../src/core/loop/index.js';
import { ToolRegistry } from '../src/tools/index.js';
import { ContextWindow } from '../src/core/context.js';

/** Build a loop whose reasoner replays a script of actions, then returns `final`. */
function scriptedLoop({ script, loopOpts = {}, toolOpts = {} } = {}) {
  const tools = new ToolRegistry();
  const tool = {
    name: 'add',
    description: 'add two numbers',
    parameters: { a: { type: 'number', required: true }, b: { type: 'number', required: true } },
    handler: async ({ a, b }) => a + b,
    ...toolOpts,
  };
  tools.register(tool);

  let i = 0;
  const reasoner = async () => {
    const action = script[Math.min(i, script.length - 1)];
    i += 1;
    return action;
  };

  const loop = new AgentLoop({
    context: new ContextWindow({ maxTokens: 8000 }),
    tools,
    reasoner,
    toolRetry: { backoffMs: 1, factor: 1 },
    ...loopOpts,
  });
  return { loop, tools, tool };
}

test('1. tool retry: transient failures retry with backoff until success', async () => {
  let calls = 0;
  const { loop } = scriptedLoop({
    toolOpts: {
      handler: async () => {
        calls += 1;
        if (calls < 3) {
          const err = new Error('flaky');
          err.code = 'TOOL_EXECUTION_ERROR'; // retryable
          throw err;
        }
        return 42;
      },
    },
    script: [
      { type: 'tool_call', tool: 'add', args: { a: 1, b: 2 } },
      { type: 'final', content: 'done' },
    ],
  });

  const retries = [];
  loop.onEvent = (event, payload) => {
    if (event === LoopEvents.TOOL_RETRY) retries.push(payload);
  };

  const result = await loop.run('compute');
  assert.equal(result.status, 'final');
  assert.equal(calls, 3, 'handler ran 3 times: 2 failures + 1 success');
  const observe = result.stepMemory.find((r) => r.phase === 'observe');
  assert.equal(observe.attempts, 3);
  assert.equal(observe.result.data, 42);
  assert.equal(retries.length, 2, 'two TOOL_RETRY events emitted');
  assert.ok(retries.every((r) => r.backoffMs >= 1));
});

test('2. tool failure exhaustion: consecutive exhausted retries stop the run', async () => {
  const { loop } = scriptedLoop({
    toolOpts: {
      handler: async () => {
        const err = new Error('always broken');
        err.code = 'TOOL_EXECUTION_ERROR';
        throw err;
      },
    },
    script: [
      { type: 'tool_call', tool: 'add', args: { a: 1, b: 2 } },
      { type: 'tool_call', tool: 'add', args: { a: 1, b: 2 } },
    ],
    loopOpts: { toolRetry: { retries: 1, backoffMs: 1, factor: 1 }, maxConsecutiveToolExhaustion: 2 },
  });

  const result = await loop.run('compute');
  assert.equal(result.status, 'error');
  assert.equal(result.reason, TerminationReason.TOOL_FAILURE_EXHAUSTED);
  // 2 tool_calls × (1 retry + 1 initial attempt) = 4 handler invocations
  assert.equal(result.stepMemory.filter((r) => r.phase === 'observe').length, 2);
  assert.match(result.error, /exhausted retries/);
});

test('3. fail-fast: non-retryable error codes are not retried', async () => {
  const calls = [];
  const { loop } = scriptedLoop({
    toolOpts: {
      handler: async ({ a }) => {
        calls.push(a);
        return a * 2;
      },
    },
    script: [
      { type: 'tool_call', tool: 'add', args: {} }, // missing required a/b -> VALIDATION_ERROR
      { type: 'final', content: 'recovered' },
    ],
  });

  const result = await loop.run('compute');
  assert.equal(result.status, 'final');
  assert.equal(result.reason, TerminationReason.FINAL_ANSWER);
  const observe = result.stepMemory.find((r) => r.phase === 'observe');
  assert.equal(observe.attempts, 1, 'VALIDATION_ERROR never retried');
  assert.equal(observe.result.code, 'VALIDATION_ERROR');
  assert.equal(calls.length, 0, 'handler was never invoked for an invalid call');
});

test('4. task timeout: run ends with task_timeout when wall clock is exceeded', async () => {
  const { loop } = scriptedLoop({
    script: [{ type: 'final', content: 'never reached' }],
    loopOpts: { maxTaskTimeoutMs: 0 }, // any elapsed time >= 0 trips the guard
  });

  const result = await loop.run('compute');
  assert.equal(result.status, 'error');
  assert.equal(result.reason, TerminationReason.TASK_TIMEOUT);
});

test('5. max tokens: run stops when context is over budget after compaction', async () => {
  // keepRecent alone exceeds maxTokens, so compaction cannot fix it and the
  // guard must stop the run cleanly instead of sending an oversized payload.
  const context = new ContextWindow({ maxTokens: 40, keepRecent: 2 });
  const tools = new ToolRegistry();
  tools.register({
    name: 'noop',
    description: 'does nothing',
    handler: async () => 'ok',
  });
  const loop = new AgentLoop({
    context,
    tools,
    reasoner: async () => ({ type: 'final', content: 'nope' }),
  });

  const result = await loop.run('x'.repeat(500)); // user message alone blows the budget
  assert.equal(result.status, 'error');
  assert.equal(result.reason, TerminationReason.MAX_TOKENS);
});

test('6. compression: context gets the truncated result, step memory keeps the full one', async () => {
  const big = 'A'.repeat(5000);
  const { loop } = scriptedLoop({
    toolOpts: { handler: async () => big },
    script: [
      { type: 'tool_call', tool: 'add', args: { a: 1, b: 2 } },
      { type: 'final', content: 'done' },
    ],
    loopOpts: { compressMaxChars: 100 },
  });

  const result = await loop.run('compute');
  assert.equal(result.status, 'final');

  const observe = result.stepMemory.find((r) => r.phase === 'observe');
  assert.equal(observe.result.data, big, 'step memory keeps the untouched full result');

  const ctxResult = result.checkpoint.context.messages.find((m) => m.role === 'tool_result');
  assert.match(ctxResult.content, /\.\.\.\[truncated \d+ chars/);
  assert.ok(ctxResult.content.length < 300, 'context copy is clipped to budget');
});

test('7. custom stop condition: named stop conditions stop the run with their reason', async () => {
  const { loop } = scriptedLoop({
    script: [{ type: 'final', content: 'never reached' }],
    loopOpts: {
      namedStopConditions: {
        budget_cap: ({ step }) => (step >= 1 ? 'budget_cap_hit' : null),
      },
    },
  });

  const result = await loop.run('compute');
  assert.equal(result.status, 'stopped');
  assert.equal(result.reason, 'budget_cap_hit');
  assert.equal(result.stopCondition, 'budget_cap');
  assert.ok(result.message.includes('budget_cap'));
});

test('8. invalid action: a malformed action ends the run with invalid_action', async () => {
  const tools = new ToolRegistry();
  tools.register({ name: 'noop', description: 'x', handler: async () => 'ok' });
  const loop = new AgentLoop({
    context: new ContextWindow(),
    tools,
    reasoner: async () => ({ type: 'tool_call', tool: 'does_not_exist', args: {} }),
  });

  const result = await loop.run('compute');
  assert.equal(result.status, 'error');
  assert.equal(result.reason, TerminationReason.INVALID_ACTION);
  assert.match(result.error, /unknown tool/i);
});

test('9. step memory: every phase is recorded with its full payload', async () => {
  const { loop } = scriptedLoop({
    script: [
      { type: 'tool_call', tool: 'add', args: { a: 2, b: 3 } },
      { type: 'final', content: 'five' },
    ],
  });

  const result = await loop.run('compute');
  assert.equal(result.status, 'final');
  assert.deepEqual(
    result.stepMemory.map((r) => r.phase),
    ['observe', 'final']
  );
  const observe = result.stepMemory[0];
  assert.equal(observe.step, 1);
  assert.equal(observe.action.tool, 'add');
  assert.equal(observe.result.data, 5);
  assert.equal(observe.attempts, 1);
  assert.equal(typeof observe.durationMs, 'number');
  const final = result.stepMemory[1];
  assert.equal(final.action.content, 'five');
  assert.equal(result.steps, 2);
});
