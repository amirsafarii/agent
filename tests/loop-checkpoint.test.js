/**
 * loop-checkpoint.test.js — pause / resume / checkpoint / state machine / stop engine
 * ------------------------------------------------------------------------------------
 * 8 tests, exactly as listed in LOOP.md → section 19:
 *   1. pause() stops exactly at the next step boundary with a valid checkpoint
 *   2. resume() continues the same run to final, with continuing step numbering
 *   3. AgentLoop.fromCheckpoint() works on a brand-new instance (process restart)
 *   4. state machine history for a successful run is
 *      created→running→thinking→acting→observing→thinking→completed
 *   5. LoopStateMachine throws on an illegal transition and leaves state untouched
 *   6. stopEngine list/register/unregister manage the 4 built-ins + a custom one
 *   7. namedStopConditions register an identifiable condition and report it
 *   8. checkpoint() mid-run (without pause) also produces a valid, resumable snapshot
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentLoop, LoopStateMachine, LoopState, LoopError, TerminationReason } from '../src/core/loop/index.js';
import { ToolRegistry } from '../src/tools/index.js';
import { ContextWindow } from '../src/core/context.js';

function makeLoop({ script, loopOpts = {}, toolOpts = {} } = {}) {
  const tools = new ToolRegistry();
  tools.register({
    name: 'add',
    description: 'add two numbers',
    parameters: { a: { type: 'number', required: true }, b: { type: 'number', required: true } },
    handler: async ({ a, b }) => a + b,
    ...toolOpts,
  });
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
  return loop;
}

test('1. pause() stops at the next step boundary with a valid checkpoint', async () => {
  const loop = makeLoop({
    script: [
      { type: 'tool_call', tool: 'add', args: { a: 1, b: 2 } },
      { type: 'tool_call', tool: 'add', args: { a: 3, b: 4 } },
      { type: 'final', content: 'done' },
    ],
  });
  // Request the pause right after the first observe; it is honored at the
  // next step boundary (before step 2's think).
  loop.onEvent = (event) => {
    if (event === 'observe') loop.pause();
  };

  const result = await loop.run('compute');
  assert.equal(result.status, 'paused');
  assert.equal(result.reason, TerminationReason.PAUSED);
  assert.equal(result.steps, 1, 'paused after exactly one completed step');
  assert.equal(result.state, LoopState.PAUSED);
  assert.ok(result.checkpoint, 'a valid checkpoint is attached');
  assert.equal(result.checkpoint.version, 1);
  assert.equal(result.checkpoint.step, 1);
  assert.equal(result.checkpoint.stepMemory.length, 1);
  assert.ok(Array.isArray(result.checkpoint.context.messages) && result.checkpoint.context.messages.length > 0);
});

test('2. resume() continues the same run to final with continuing step numbers', async () => {
  const loop = makeLoop({
    script: [
      { type: 'tool_call', tool: 'add', args: { a: 1, b: 2 } },
      { type: 'tool_call', tool: 'add', args: { a: 3, b: 4 } },
      { type: 'final', content: 'done' },
    ],
  });
  loop.onEvent = (event) => {
    if (event === 'observe' && loop._currentStep === 1) loop.pause();
  };

  const paused = await loop.run('compute');
  assert.equal(paused.status, 'paused');

  const resumed = await loop.resume(paused.checkpoint, { additionalInput: 'continue' });
  assert.equal(resumed.status, 'final');
  assert.equal(resumed.reason, TerminationReason.FINAL_ANSWER);
  assert.equal(resumed.content, 'done');
  assert.equal(resumed.steps, 3, 'step numbering continues from the checkpoint (2 more steps)');
  assert.ok(resumed.stepMemory.length >= 3, 'step memory accumulates across resume');
  assert.equal(resumed.checkpoint.step, 3);
});

test('3. AgentLoop.fromCheckpoint() rebuilds a fresh instance (process restart)', async () => {
  const paused = await (async () => {
    const loop = makeLoop({
      script: [
        { type: 'tool_call', tool: 'add', args: { a: 1, b: 2 } },
        { type: 'final', content: 'done' },
      ],
    });
    loop.onEvent = (event) => {
      if (event === 'observe') loop.pause();
    };
    return loop.run('compute');
  })();
  assert.equal(paused.status, 'paused');

  // Brand-new instance — as if the process restarted with only the JSON.
  const fresh = AgentLoop.fromCheckpoint(paused.checkpoint, {
    context: new ContextWindow({ maxTokens: 8000 }),
    tools: (() => {
      const t = new ToolRegistry();
      t.register({
        name: 'add',
        description: 'add two numbers',
        parameters: { a: { type: 'number', required: true }, b: { type: 'number', required: true } },
        handler: async ({ a, b }) => a + b,
      });
      return t;
    })(),
    reasoner: async () => ({ type: 'final', content: 'done' }),
  });

  const result = await fresh.resume(paused.checkpoint);
  assert.equal(result.status, 'final');
  assert.equal(result.content, 'done');
  assert.equal(result.steps, paused.steps + 1, 'continues where the old process left off');
});

test('4. state machine history of a successful run is exactly created→running→thinking→acting→observing→thinking→completed', async () => {
  const loop = makeLoop({
    script: [
      { type: 'tool_call', tool: 'add', args: { a: 1, b: 2 } },
      { type: 'final', content: 'done' },
    ],
  });

  const result = await loop.run('compute');
  assert.equal(result.status, 'final');
  const history = loop.getStateHistory().map((h) => h.to);
  assert.deepEqual(history, [
    'created',
    'running',
    'thinking',
    'acting',
    'observing',
    'thinking',
    'completed',
  ]);
});

test('5. LoopStateMachine throws on an illegal transition and keeps state untouched', async () => {
  const sm = new LoopStateMachine(LoopState.CREATED);
  sm.transition(LoopState.RUNNING);
  assert.equal(sm.current, LoopState.RUNNING);
  assert.throws(() => sm.transition(LoopState.CREATED), LoopError);
  assert.throws(() => sm.transition(LoopState.RUNNING), LoopError); // running -> running
  assert.equal(sm.current, LoopState.RUNNING, 'state unchanged after the illegal attempts');
  assert.throws(() => sm.transition('not_a_state'), LoopError);
});

test('6. stopEngine list/register/unregister manage the built-ins and a custom condition', async () => {
  const loop = makeLoop({ script: [{ type: 'final', content: 'x' }] });

  const builtins = loop.stopEngine.list().map((c) => c.name).sort();
  assert.deepEqual(builtins, ['abort_signal', 'max_tokens', 'pause_requested', 'task_timeout']);

  loop.stopEngine.register('custom', () => null, { priority: 50 });
  assert.ok(loop.stopEngine.list().some((c) => c.name === 'custom' && c.priority === 50));
  assert.equal(loop.stopEngine.evaluate({ step: 1, elapsedMs: 0 }), null, 'condition that returns null keeps running');

  loop.stopEngine.unregister('custom');
  assert.ok(!loop.stopEngine.list().some((c) => c.name === 'custom'));
});

test('7. namedStopConditions register an identifiable condition and report it in the result', async () => {
  const loop = makeLoop({
    script: [
      { type: 'tool_call', tool: 'add', args: { a: 1, b: 2 } },
      { type: 'final', content: 'x' },
    ],
    loopOpts: { namedStopConditions: { step_two: ({ step }) => (step >= 2 ? 'max_two_steps' : null) } },
  });
  const result = await loop.run('compute');
  assert.equal(result.status, 'stopped');
  assert.equal(result.stopCondition, 'step_two');
  assert.equal(result.reason, 'max_two_steps');
  assert.ok(loop.stopEngine.list().some((c) => c.name === 'step_two'));
});

test('8. checkpoint() mid-run (without pause) is a valid resumable snapshot', async () => {
  const loop = makeLoop({
    script: [
      { type: 'tool_call', tool: 'add', args: { a: 1, b: 2 } },
      { type: 'tool_call', tool: 'add', args: { a: 3, b: 4 } },
      { type: 'final', content: 'done' },
    ],
  });
  let midRunSnapshot = null;
  loop.onEvent = (event) => {
    if (event === 'observe' && loop._currentStep === 1) {
      midRunSnapshot = loop.checkpoint({ reason: 'mid-run capture' });
    }
  };

  const result = await loop.run('compute');
  assert.equal(result.status, 'final');
  assert.ok(midRunSnapshot, 'snapshot captured from inside onEvent');
  assert.equal(midRunSnapshot.step, 1);
  assert.equal(midRunSnapshot.version, 1);
  assert.ok(midRunSnapshot.context.messages.length >= 3, 'user + tool_call + tool_result recorded');
  assert.equal(midRunSnapshot.stepMemory.length, 1);

  // A snapshot taken mid-run is just as resumable as a pause checkpoint.
  // (Resume on a fresh instance with a fresh reasoner — exactly how a
  // supervisor would continue a captured run later.)
  const fresh = AgentLoop.fromCheckpoint(midRunSnapshot, {
    context: new ContextWindow({ maxTokens: 8000 }),
    tools: (() => {
      const t = new ToolRegistry();
      t.register({
        name: 'add',
        description: 'add two numbers',
        parameters: { a: { type: 'number', required: true }, b: { type: 'number', required: true } },
        handler: async ({ a, b }) => a + b,
      });
      return t;
    })(),
    reasoner: (() => {
      let i = 0;
      const script = [
        { type: 'tool_call', tool: 'add', args: { a: 3, b: 4 } },
        { type: 'final', content: 'done' },
      ];
      return async () => script[Math.min(i++, script.length - 1)];
    })(),
  });
  const resumed = await fresh.resume(midRunSnapshot);
  assert.equal(resumed.status, 'final');
  assert.equal(resumed.content, 'done');
  assert.equal(resumed.steps, 3, 'step 2 (tool call) + step 3 (final) after the step-1 checkpoint');
});
