/**
 * loop-guards.test.js — adaptive step budget, tool-overuse guard, similar-call warning
 * ------------------------------------------------------------------------------------
 * The "agent logic" fixes: max_steps is no longer a hard ceiling when the
 * run is making progress (adaptiveMaxSteps), flailing on one tool is capped
 * (maxToolCallsPerTool -> tool_overuse), and near-duplicate calls produce a
 * visible [loop guard] warning so the reasoner can pivot.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentLoop, TerminationReason, LoopEvents } from '../src/core/loop/index.js';
import { ToolRegistry } from '../src/tools/index.js';
import { ContextWindow } from '../src/core/context.js';

function makeLoop({ script, loopOpts = {} } = {}) {
  const tools = new ToolRegistry();
  tools.register({
    name: 'add',
    description: 'add',
    parameters: { a: { type: 'number', required: true }, b: { type: 'number', required: true } },
    handler: async ({ a, b }) => a + b,
  });
  let i = 0;
  const reasoner = async () => script[Math.min(i++, script.length - 1)];
  return new AgentLoop({
    context: new ContextWindow({ maxTokens: 8000 }),
    tools,
    reasoner,
    toolRetry: { backoffMs: 1, factor: 1 },
    ...loopOpts,
  });
}

test('adaptive budget: a 20-step task finishes even with maxSteps=12 when progress is real', async () => {
  const script = [];
  for (let n = 1; n <= 20; n += 1) script.push({ type: 'tool_call', tool: 'add', args: { a: n, b: 1 } });
  script.push({ type: 'final', content: 'done at last' });

  const loop = makeLoop({ script, loopOpts: { maxSteps: 12, adaptiveMaxSteps: { max: 40, growthFactor: 2 }, maxToolCallsPerTool: 30 } });
  const events = [];
  loop.onEvent = (event, payload) => {
    if (event === LoopEvents.BUDGET_EXTENDED) events.push(payload);
  };

  const result = await loop.run('long task');
  assert.equal(result.status, 'final');
  assert.equal(result.reason, TerminationReason.FINAL_ANSWER);
  assert.equal(result.steps, 21, 'all 20 tool steps + final step ran');
  assert.equal(result.budget, 24, 'effective budget grew from 12 to 24 (12 -> 24 -> max reached)');
  assert.ok(events.length >= 1, 'budget_extended events emitted');
  assert.equal(events[0].from, 12);
  assert.equal(events[0].to, 24);
});

test('without adaptive mode the same 20-step task stops at the 12-step ceiling', async () => {
  const script = [];
  for (let n = 1; n <= 20; n += 1) script.push({ type: 'tool_call', tool: 'add', args: { a: n, b: 1 } });
  script.push({ type: 'final', content: 'never reached' });

  const loop = makeLoop({ script, loopOpts: { maxSteps: 12, maxToolCallsPerTool: 30 } });
  const result = await loop.run('long task');
  assert.equal(result.status, 'max_steps');
  assert.equal(result.reason, TerminationReason.MAX_STEPS);
  assert.equal(result.steps, 12);
  assert.equal(result.budget, 12);
});

test('runOpts.maxSteps overrides the constructor ceiling per call', async () => {
  const script = [
    { type: 'tool_call', tool: 'add', args: { a: 1, b: 1 } },
    { type: 'tool_call', tool: 'add', args: { a: 2, b: 1 } },
    { type: 'final', content: 'done' },
  ];
  const loop = makeLoop({ script, loopOpts: { maxSteps: 1 } });
  const result = await loop.run('go', { maxSteps: 3 });
  assert.equal(result.status, 'final');
  assert.equal(result.steps, 3);
});

test('tool overuse: a single tool called more than the per-tool cap stops the run', async () => {
  const script = Array.from({ length: 10 }, (_, i) => ({ type: 'tool_call', tool: 'add', args: { a: i + 1, b: i + 1 } }));
  script.push({ type: 'final', content: 'never' });

  const loop = makeLoop({ script, loopOpts: { maxSteps: 30, maxToolCallsPerTool: 4 } });
  const result = await loop.run('flail');
  assert.equal(result.status, 'error');
  assert.equal(result.reason, TerminationReason.TOOL_OVERUSE);
  assert.equal(result.steps, 5, '4th call passed, 5th call trips the cap (limit 4)');
  assert.match(result.error, /called 5 times/);
  assert.match(result.error, /limit 4/);
  const guardMsg = result.checkpoint.context.messages.find((m) => m.content.includes('[loop guard]') && m.content.includes('tool_overuse') === false);
  assert.ok(guardMsg, 'guard message appended to context');
});

test('tool overuse: legitimate distinct-query search usage under the cap is fine', async () => {
  const script = [
    { type: 'tool_call', tool: 'add', args: { a: 1, b: 1 } },
    { type: 'tool_call', tool: 'add', args: { a: 2, b: 2 } },
    { type: 'tool_call', tool: 'add', args: { a: 3, b: 3 } },
    { type: 'final', content: 'ok' },
  ];
  const loop = makeLoop({ script, loopOpts: { maxSteps: 10, maxToolCallsPerTool: 4 } });
  const result = await loop.run('fine');
  assert.equal(result.status, 'final');
  assert.equal(result.steps, 4);
});

test('similar-call warning: near-duplicate (non-consecutive) calls emit a guard warning, not a stop', async () => {
  const script = [
    { type: 'tool_call', tool: 'add', args: { a: 1, b: 2 } },
    { type: 'tool_call', tool: 'add', args: { a: 5, b: 5 } },
    { type: 'tool_call', tool: 'add', args: { b: 2, a: 1 } }, // same args, different key order
    { type: 'final', content: 'pivoted' },
  ];
  const loop = makeLoop({ script });
  const events = [];
  loop.onEvent = (event, payload) => {
    if (event === LoopEvents.SIMILAR_CALL) events.push(payload);
  };

  const result = await loop.run('compute');
  assert.equal(result.status, 'final', 'warning is not terminal');
  assert.equal(events.length, 1, 'one similar_call warning for the key-order-equivalent args');
  const guardMsg = result.checkpoint.context.messages.find((m) => m.content.includes('closely matches'));
  assert.ok(guardMsg, 'reasoner sees the [loop guard] similar-call notice');
});

test('similar-call window: repeated identical calls still hit the stuck-loop guard first', async () => {
  const script = [
    { type: 'tool_call', tool: 'add', args: { a: 1, b: 2 } },
    { type: 'tool_call', tool: 'add', args: { a: 1, b: 2 } },
    { type: 'tool_call', tool: 'add', args: { a: 1, b: 2 } },
  ];
  const loop = makeLoop({ script, loopOpts: { maxRepeatedToolCalls: 3 } });
  const result = await loop.run('repeat');
  assert.equal(result.status, 'error');
  assert.equal(result.reason, TerminationReason.STUCK_LOOP);
});

test('adaptive budget is preserved across resume via the checkpoint', async () => {
  const script = [];
  for (let n = 1; n <= 10; n += 1) script.push({ type: 'tool_call', tool: 'add', args: { a: n, b: 1 } });
  script.push({ type: 'final', content: 'resumed done' });

  const loop = makeLoop({ script, loopOpts: { maxSteps: 6, adaptiveMaxSteps: { max: 20, growthFactor: 2 }, maxToolCallsPerTool: 30 } });
  loop.onEvent = (event) => {
    if (event === 'observe' && loop._currentStep === 5) loop.pause();
  };
  const paused = await loop.run('long');
  assert.equal(paused.status, 'paused');
  assert.equal(paused.budget, 6, 'budget still at the base when paused at step 5 (extension only happens at the ceiling)');
  assert.equal(paused.checkpoint.budget, 6);

  const resumed = await loop.resume(paused.checkpoint);
  assert.equal(resumed.status, 'final');
  assert.equal(resumed.steps, 11, 'continued to the end without re-triping the old ceiling');
});
