/**
 * loop-approval.test.js — tool approval gate, lifecycle hooks, CheckpointManager, SessionLogger
 * ---------------------------------------------------------------------------------------------
 * 10 tests, exactly as listed in LOOP.md → section 19:
 *   1. requiresApproval:true + no onToolApproval -> awaiting_tool_approval
 *   2. resumeWithApproval(checkpoint, true) actually runs the gated tool
 *   3. resumeWithApproval(checkpoint, false) never calls the handler and
 *      tells the reasoner why
 *   4. onToolApproval decides automatically without pausing the run
 *   5. requireApprovalFor: '*' gates every tool
 *   6. lifecycleHooks fire in exact macro-state order (onCreated at construction)
 *   7. lifecycleHooks.onFailed fires on a real reasoner throw
 *   8. CheckpointManager save/get/list work in memory with correct ids
 *   9. CheckpointManager with a dir survives a fresh instance via loadFromDisk()
 *  10. SessionLogger writes every event to events.jsonl + transcript.log
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentLoop, LoopState, TerminationReason, LoopEvents } from '../src/core/loop/index.js';
import { ToolRegistry } from '../src/tools/index.js';
import { ContextWindow } from '../src/core/context.js';
import { CheckpointManager } from '../src/core/checkpoint-manager.js';
import { SessionLogger, attachSessionLogger } from '../src/core/session-logger.js';

function makeLoop({ script = [], loopOpts = {}, toolOpts = {}, tools } = {}) {
  const registry = tools || new ToolRegistry();
  if (!registry.has('add')) {
    registry.register({
      name: 'add',
      description: 'add two numbers',
      parameters: { a: { type: 'number', required: true }, b: { type: 'number', required: true } },
      handler: async ({ a, b }) => a + b,
      ...toolOpts,
    });
  }
  let i = 0;
  const reasoner = async () => {
    const action = script[Math.min(i, script.length - 1)];
    i += 1;
    return action;
  };
  const loop = new AgentLoop({
    context: new ContextWindow({ maxTokens: 8000 }),
    tools: registry,
    reasoner,
    ...loopOpts,
  });
  return { loop, registry };
}

test('1. requiresApproval:true with no hook pauses in awaiting_tool_approval', async () => {
  const { loop } = makeLoop({
    toolOpts: { requiresApproval: true },
    script: [{ type: 'tool_call', tool: 'add', args: { a: 1, b: 2 } }],
  });

  const result = await loop.run('compute');
  assert.equal(result.status, 'awaiting_tool_approval');
  assert.equal(result.reason, TerminationReason.AWAITING_TOOL_APPROVAL);
  assert.equal(result.state, LoopState.AWAITING_TOOL_APPROVAL);
  assert.deepEqual(result.pendingApproval.tool, 'add');
  assert.deepEqual(result.pendingApproval.args, { a: 1, b: 2 });
  assert.equal(result.pendingApproval.step, 1);
  assert.ok(result.checkpoint.pendingApproval, 'checkpoint carries the pending approval');
});

test('2. resumeWithApproval(checkpoint, true) runs the gated tool and continues', async () => {
  let handlerCalls = 0;
  const { loop } = makeLoop({
    toolOpts: {
      requiresApproval: true,
      handler: async ({ a, b }) => {
        handlerCalls += 1;
        return a + b;
      },
    },
    script: [
      { type: 'tool_call', tool: 'add', args: { a: 1, b: 2 } },
      { type: 'final', content: 'approved and done' },
    ],
  });

  const paused = await loop.run('compute');
  assert.equal(paused.status, 'awaiting_tool_approval');
  assert.equal(handlerCalls, 0, 'handler not called before approval');

  const resumed = await loop.resumeWithApproval(paused.checkpoint, true);
  assert.equal(resumed.status, 'final');
  assert.equal(handlerCalls, 1, 'handler ran exactly once after approval');
  assert.equal(resumed.content, 'approved and done');
  const observe = resumed.stepMemory.find((r) => r.phase === 'observe');
  assert.equal(observe.result.data, 3);
  assert.equal(observe.step, 1, 'the gated step number is preserved (not +1)');
});

test('3. resumeWithApproval(checkpoint, false) skips the handler and tells the reasoner', async () => {
  let handlerCalls = 0;
  const { loop } = makeLoop({
    toolOpts: {
      requiresApproval: true,
      handler: async () => {
        handlerCalls += 1;
        return 0;
      },
    },
    script: [
      { type: 'tool_call', tool: 'add', args: { a: 1, b: 2 } },
      { type: 'final', content: 'pivoted' },
    ],
  });

  const paused = await loop.run('compute');
  assert.equal(paused.status, 'awaiting_tool_approval');

  const resumed = await loop.resumeWithApproval(paused.checkpoint, false, { reason: 'not needed' });
  assert.equal(resumed.status, 'final');
  assert.equal(resumed.content, 'pivoted');
  assert.equal(handlerCalls, 0, 'handler never called after rejection');

  const rejection = resumed.stepMemory.find((r) => r.phase === 'tool_rejected');
  assert.ok(rejection, 'rejection is recorded in step memory');
  assert.match(rejection.error, /NOT approved/);
  assert.match(rejection.error, /not needed/);
  const ctxRejection = resumed.checkpoint.context.messages.find((m) => m.content.includes('[tool approval]'));
  assert.ok(ctxRejection, 'rejection message is visible to the reasoner in context');
});

test('4. onToolApproval decides automatically without pausing', async () => {
  let handlerCalls = 0;
  const decisions = [];
  const { loop } = makeLoop({
    toolOpts: {
      requiresApproval: true,
      handler: async ({ a, b }) => {
        handlerCalls += 1;
        return a + b;
      },
    },
    loopOpts: {
      onToolApproval: async (request) => {
        decisions.push(request.tool);
        return { approved: true, reason: 'auto-ok' };
      },
    },
    script: [
      { type: 'tool_call', tool: 'add', args: { a: 1, b: 2 } },
      { type: 'final', content: 'auto done' },
    ],
  });

  const events = [];
  loop.onEvent = (event, payload) => {
    if (event === LoopEvents.TOOL_APPROVAL_GRANTED || event === LoopEvents.TOOL_APPROVAL_REQUESTED) {
      events.push({ event, ...payload });
    }
  };

  const result = await loop.run('compute');
  assert.equal(result.status, 'final');
  assert.equal(handlerCalls, 1);
  assert.deepEqual(decisions, ['add']);
  assert.ok(events.some((e) => e.event === 'tool_approval_requested'));
  assert.ok(events.some((e) => e.event === 'tool_approval_granted'));
});

test('5. requireApprovalFor: "*" gates every tool even without requiresApproval', async () => {
  let handlerCalls = 0;
  const { loop } = makeLoop({
    toolOpts: {
      handler: async () => {
        handlerCalls += 1;
        return 7;
      },
    },
    loopOpts: { requireApprovalFor: '*' },
    script: [{ type: 'tool_call', tool: 'add', args: { a: 1, b: 2 } }],
  });

  const result = await loop.run('compute');
  assert.equal(result.status, 'awaiting_tool_approval');
  assert.equal(result.pendingApproval.tool, 'add');
  assert.equal(handlerCalls, 0);
});

test('6. lifecycleHooks fire in exact macro-state order (onCreated at construction)', async () => {
  const order = [];
  const { loop } = makeLoop({
    loopOpts: {
      lifecycleHooks: {
        onCreated: () => order.push('created'),
        onRunning: () => order.push('running'),
        onAwaitingToolApproval: () => order.push('awaiting_tool_approval'),
        onPaused: () => order.push('paused'),
        onResumed: () => order.push('resumed'),
        onCompleted: () => order.push('completed'),
        onFailed: () => order.push('failed'),
      },
    },
    toolOpts: { requiresApproval: true },
    script: [
      { type: 'tool_call', tool: 'add', args: { a: 1, b: 2 } },
      { type: 'final', content: 'done' },
    ],
  });

  assert.deepEqual(order, ['created'], 'onCreated fired synchronously with the constructor');

  const paused = await loop.run('compute');
  assert.equal(paused.status, 'awaiting_tool_approval');
  // Hooks exist for the seven macro states only — THINKING/ACTING/OBSERVING
  // are fine-grained phases inside RUNNING and have no dedicated hooks.
  assert.deepEqual(order, ['created', 'running', 'awaiting_tool_approval']);

  const resumed = await loop.resumeWithApproval(paused.checkpoint, true);
  assert.equal(resumed.status, 'final');
  assert.deepEqual(order, [
    'created',
    'running',
    'awaiting_tool_approval',
    'resumed',
    'running',
    'completed',
  ]);
});

test('7. lifecycleHooks.onFailed fires on a real reasoner throw', async () => {
  let failedPayload = null;
  const tools = new ToolRegistry();
  tools.register({ name: 'noop', description: 'x', handler: async () => 'ok' });
  const loop = new AgentLoop({
    context: new ContextWindow(),
    tools,
    reasoner: async () => {
      throw new Error('model exploded');
    },
    lifecycleHooks: {
      onFailed: (payload) => {
        failedPayload = payload;
      },
    },
  });

  const result = await loop.run('compute');
  assert.equal(result.status, 'error');
  assert.equal(result.reason, TerminationReason.THINK_ERROR);
  assert.ok(failedPayload, 'onFailed fired');
  assert.equal(failedPayload.state, 'failed');
});

test('8. CheckpointManager save/get/list work in memory with correct ids', async () => {
  const manager = new CheckpointManager();
  const snapshot = { version: 1, step: 2, state: 'paused', context: { messages: [] }, stepMemory: [] };
  const id1 = await manager.save(snapshot, { label: 'first' });
  const id2 = await manager.save({ ...snapshot, step: 5 }, { label: 'second' });

  assert.ok(id1 !== id2, 'ids are unique');
  const got = await manager.get(id1);
  assert.equal(got.id, id1);
  assert.equal(got.meta.label, 'first');
  assert.equal(got.snapshot.step, 2);

  const list = manager.list();
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((r) => r.step), [2, 5], 'listed oldest -> newest');
  assert.ok(list.every((r) => !('snapshot' in r) || r.snapshot === undefined), 'list is lightweight');

  const latest = manager.latest();
  assert.equal(latest.id, id2);
  await manager.delete(id1);
  assert.equal(await manager.get(id1), null);
  assert.equal(manager.list().length, 1);
});

test('9. CheckpointManager with a dir survives a fresh instance via loadFromDisk()', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'scrappyai-checkpoints-'));
  const manager = new CheckpointManager({ dir });
  const id = await manager.save(
    { version: 1, step: 3, state: 'paused', context: { messages: [{ role: 'user', content: 'hi' }] }, stepMemory: [] },
    { label: 'durable' }
  );
  assert.ok(existsSync(join(dir, `${id}.json`)), 'checkpoint file written to disk');

  // Brand-new manager over the same directory — process restart simulation.
  const fresh = new CheckpointManager({ dir });
  assert.equal(fresh.list().length, 0, 'index is empty before loadFromDisk');
  const loaded = await fresh.loadFromDisk();
  assert.equal(loaded, 1);
  assert.equal(fresh.list().length, 1, 'index rebuilt after loadFromDisk');
  const got = await fresh.get(id);
  assert.equal(got.id, id);
  assert.equal(got.snapshot.step, 3);
});

test('10. SessionLogger writes every event to events.jsonl and transcript.log', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'scrappyai-logs-'));
  const logger = new SessionLogger({ sessionId: 'sess-test-1', rootDir: dir });
  const { loop } = makeLoop({
    script: [
      { type: 'tool_call', tool: 'add', args: { a: 1, b: 2 } },
      { type: 'final', content: 'logged' },
    ],
  });
  attachSessionLogger(loop, logger);

  const result = await loop.run('compute');
  assert.equal(result.status, 'final');

  const eventsPath = join(dir, 'sess-test-1', 'events.jsonl');
  const transcriptPath = join(dir, 'sess-test-1', 'transcript.log');
  assert.ok(existsSync(eventsPath));
  assert.ok(existsSync(transcriptPath));

  const lines = readFileSync(eventsPath, 'utf8').trim().split('\n').filter(Boolean);
  assert.ok(lines.length >= 8, `got ${lines.length} event lines`);
  const events = lines.map((l) => JSON.parse(l));
  assert.ok(events.every((e) => typeof e.seq === 'number' && e.event && e.ts));
  const names = events.map((e) => e.event);
  for (const expected of ['step_start', 'think', 'act', 'observe', 'final']) {
    assert.ok(names.includes(expected), `event stream includes ${expected}`);
  }
  const finalEvent = events.find((e) => e.event === 'final');
  assert.equal(finalEvent.payload.content, 'logged');

  const transcript = readFileSync(transcriptPath, 'utf8');
  assert.match(transcript, /session sess-test-1 started/);
  assert.match(transcript, /\(loop\) act\s*\n\s*tool: add\(/);
  assert.match(transcript, /\(loop\) final\s*\n\s*content: logged/);
});
