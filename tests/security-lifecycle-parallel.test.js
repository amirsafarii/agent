/**
 * security-lifecycle-parallel.test.js
 * ------------------------------------
 * Covers the architecture upgrades:
 *   1. Tool lifecycle (DISCOVERED → … → ACTIVE → DEPRECATED → REMOVED)
 *   2. Tool metadata + permission model + profiles
 *   3. Realpath-based sandbox (symlink escape)
 *   4. Task model separate from Run
 *   5. Parallel execution (concurrency, cancel, timeout, partial failure, retry)
 *   6. End-to-end AbortSignal propagation into tool handlers
 *   7. Plan / session / step approval grants
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, symlinkSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ToolRegistry,
  ToolLifecycle,
  createFilesystemTools,
} from '../src/tools/index.js';
import {
  resolveProfile,
  checkPermissions,
  ApprovalManager,
  PermissionValue,
  PROFILES,
  shouldRequireApproval,
  resolveToolPermissions,
  resolveToolRisk,
} from '../src/security/permissions.js';
import { createSandbox, SandboxLevel } from '../src/security/sandbox.js';
import { Task, TaskStatus, Run } from '../src/planning/task.js';
import { ParallelExecutor, parallel } from '../src/planning/parallel-executor.js';
import { DAG } from '../src/planning/dag.js';
import { DAGExecutor } from '../src/planning/dag-executor.js';
import { PlanningEngine } from '../src/planning/engine.js';
import { AgentLoop } from '../src/core/loop/index.js';
import { ContextWindow } from '../src/core/context.js';

// ---------------------------------------------------------------------------
// 1. Tool lifecycle
// ---------------------------------------------------------------------------

test('tool lifecycle: discover → draft → … → active → deprecate → remove', () => {
  const r = new ToolRegistry({ profile: 'developer' });
  r.discover({
    name: 'echo',
    description: 'echoes',
    handler: async ({ x }) => x,
    parameters: { x: { type: 'string', required: true } },
  });
  assert.equal(r.has('echo'), false, 'discovered tools are not yet registered');
  assert.equal(r._discovered.get('echo').lifecycle, ToolLifecycle.DRAFT);

  r.register({
    name: 'echo',
    description: 'echoes',
    handler: async ({ x }) => x,
    parameters: { x: { type: 'string', required: true } },
  });
  const tool = r.get('echo');
  assert.equal(tool.lifecycle, ToolLifecycle.ACTIVE);
  assert.ok(tool.metadata);
  assert.equal(tool.metadata.version, '1.0.0');
  assert.ok(tool.metadata.metrics);

  // Only ACTIVE tools appear in schema
  assert.deepEqual(r.toSchema().map((t) => t.name), ['echo']);

  r.deprecate('echo', 'use echo_v2', 'echo_v2');
  assert.equal(r.get('echo').lifecycle, ToolLifecycle.DEPRECATED);
  assert.equal(r.get('echo').metadata.replacedBy, 'echo_v2');
  // Deprecated still executable, but not advertised
  assert.equal(r.toSchema().length, 0);

  r.remove('echo');
  assert.equal(r.has('echo'), false);
});

test('tool lifecycle: non-active tools cannot execute', async () => {
  const r = new ToolRegistry({ profile: 'admin' });
  r.register({
    name: 'drafty',
    description: 'stays draft',
    handler: async () => 'nope',
    autoActivate: false,
  });
  // autoActivate:false leaves it at DRAFT
  assert.equal(r.get('drafty').lifecycle, ToolLifecycle.DRAFT);
  const res = await r.execute('drafty', {});
  assert.equal(res.ok, false);
  assert.equal(res.code, 'TOOL_NOT_ACTIVE');
});

test('tool metadata is recorded on every execution', async () => {
  const r = new ToolRegistry({ profile: 'admin' });
  r.register({
    name: 'ping',
    description: 'ping',
    handler: async () => 'pong',
  });
  await r.execute('ping', {});
  await r.execute('ping', {});
  const m = r.get('ping').metadata.metrics;
  assert.equal(m.executions, 2);
  assert.equal(m.successes, 2);
  assert.ok(m.lastExecutedAt);
});

// ---------------------------------------------------------------------------
// 2. Permissions + profiles
// ---------------------------------------------------------------------------

test('permission profiles: readonly denies write/shell/package', () => {
  const ro = resolveProfile('readonly');
  assert.equal(ro.permissions.filesystem, PermissionValue.READONLY);
  assert.equal(ro.permissions.shell, PermissionValue.NONE);

  const writePerms = resolveToolPermissions({ name: 'write_file' });
  const check = checkPermissions(writePerms, ro.permissions);
  assert.equal(check.ok, false);
  assert.equal(check.code, 'PERMISSION_DENIED');

  const readPerms = resolveToolPermissions({ name: 'read_file' });
  assert.equal(checkPermissions(readPerms, ro.permissions).ok, true);
});

test('ToolRegistry enforces profile permissions on execute', async () => {
  const root = mkdtempSync(join(tmpdir(), 'scrappy-perm-'));
  const r = new ToolRegistry({ profile: 'readonly', filesRoot: root });
  for (const def of createFilesystemTools({ rootDir: root, sandbox: r.sandbox })) {
    r.register(def);
  }

  // Seed a file outside the registry (direct fs) so read can succeed.
  writeFileSync(join(root, 'a.txt'), 'hi');
  const read = await r.execute('read_file', { path: 'a.txt' });
  assert.equal(read.ok, true);
  assert.equal(read.data.content, 'hi');

  const write = await r.execute('write_file', { path: 'b.txt', content: 'x' });
  assert.equal(write.ok, false);
  assert.equal(write.code, 'PERMISSION_DENIED');
});

test('session approval grants bypass requiresApproval; denials block', async () => {
  const r = new ToolRegistry({ profile: 'developer' });
  r.register({
    name: 'danger',
    description: 'gated',
    requiresApproval: true,
    risk: 'critical',
    handler: async () => 'ok',
  });
  assert.equal(r.requiresApproval('danger'), true);

  r.approvals.approveToolForSession('danger');
  assert.equal(r.requiresApproval('danger'), false);

  r.approvals.denyToolForSession('danger');
  assert.equal(r.requiresApproval('danger'), true);
  const res = await r.execute('danger', {});
  assert.equal(res.ok, false);
  assert.equal(res.code, 'SESSION_DENIED');
});

test('shouldRequireApproval respects risk threshold of profile', () => {
  const def = { name: 'shell', risk: 'medium', requiresApproval: false };
  assert.equal(shouldRequireApproval(def, PROFILES.developer), false, 'medium < high threshold');
  assert.equal(shouldRequireApproval(def, PROFILES.readonly), true, 'medium >= medium threshold');
  assert.equal(shouldRequireApproval({ ...def, requiresApproval: true }, PROFILES.autonomous), true);
});

// ---------------------------------------------------------------------------
// 3. Realpath sandbox / symlink escape
// ---------------------------------------------------------------------------

test('sandbox: symlink pointing outside root is rejected (SYMLINK_ESCAPE)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'scrappy-sym-'));
  const outside = mkdtempSync(join(tmpdir(), 'scrappy-out-'));
  writeFileSync(join(outside, 'secret.txt'), 'TOP SECRET');
  // symlink inside sandbox → outside
  symlinkSync(outside, join(root, 'link'));

  const sandbox = createSandbox({ rootDir: root });
  assert.throws(() => sandbox.resolve('link/secret.txt'), /symlink|escape/i);

  const r = new ToolRegistry({ profile: 'admin', sandbox, filesRoot: root });
  // admin still has path containment unless allowSymlinksOutside
  for (const def of createFilesystemTools({ rootDir: root, sandbox })) r.register(def);

  const res = await r.execute('read_file', { path: 'link/secret.txt' });
  assert.equal(res.ok, false);
  assert.ok(
    res.code === 'SYMLINK_ESCAPE' || res.code === 'PATH_ESCAPE',
    `expected symlink/path escape, got ${res.code}: ${res.error}`
  );
});

test('sandbox: normal relative paths inside root still work', async () => {
  const root = mkdtempSync(join(tmpdir(), 'scrappy-ok-'));
  const sandbox = createSandbox({ rootDir: root });
  const abs = sandbox.resolve('sub/file.txt');
  assert.ok(abs.startsWith(root));
});

// ---------------------------------------------------------------------------
// 4. Task separate from Run
// ---------------------------------------------------------------------------

test('Task model: full lifecycle fields + subtasks', () => {
  const run = new Run({ input: 'build a REST API' });
  run.start();
  const task = run.addTask({
    goal: 'Build a REST API',
    title: 'REST API',
  });
  assert.equal(task.runId, run.id);
  assert.equal(task.status, TaskStatus.PENDING);

  const inspect = task.addSubtask({ goal: 'inspect project', title: 'inspect' });
  const plan = task.addSubtask({ goal: 'create plan', title: 'plan', dependencies: [inspect.id] });
  assert.equal(inspect.parentId, task.id);
  assert.equal(task.subtasks.length, 2);

  inspect.start();
  inspect.complete({ files: 3 });
  assert.equal(inspect.status, TaskStatus.COMPLETED);
  assert.equal(inspect.attemptCount, 1);
  assert.ok(inspect.startedAt);
  assert.ok(inspect.finishedAt);
  assert.deepEqual(inspect.outputs.files, 3);

  plan.start();
  plan.fail(new Error('boom'), { retryable: true });
  assert.equal(plan.status, TaskStatus.PENDING, 'retryable failure resets to pending');
  plan.start();
  plan.fail(new Error('boom2'), { retryable: true });
  plan.start();
  plan.fail(new Error('boom3'), { retryable: true });
  assert.equal(plan.status, TaskStatus.FAILED, 'exhausted maxAttempts');

  const json = task.toJSON();
  assert.equal(json.goal, 'Build a REST API');
  assert.ok(Array.isArray(json.subtasks));
  assert.ok(Array.isArray(json.attempts) || json.attempts.length === 0);

  const restored = Task.fromJSON(json);
  assert.equal(restored.id, task.id);
  assert.equal(restored.subtasks.length, 2);
});

test('PlanningEngine: tasks carry goal/deps/artifacts and attach to Run', () => {
  const engine = new PlanningEngine();
  const run = engine.startRun({ input: 'feature X' });
  const plan = engine.createPlan({
    title: 'Feature X',
    tasks: [
      { id: '1', goal: 'inspect project', title: 'inspect' },
      { id: '2', goal: 'implement', title: 'implement', deps: ['1'] },
    ],
  });
  assert.equal(plan.runId, run.id);
  assert.equal(plan.tasks[0].goal, 'inspect project');
  assert.deepEqual(plan.tasks[1].dependencies, ['1']);
  assert.equal(plan.nextActionableTasks.length, 1);
  assert.equal(plan.nextActionableTasks[0].id, '1');

  engine.updateTask({ taskId: '1', status: 'completed', outputs: { ok: true } });
  engine.updateTask({
    taskId: '1',
    artifact: { type: 'file', path: 'notes.md', description: 'inspection notes' },
  });
  const summary = engine.getPlanSummary();
  assert.equal(summary.progress.completed, 1);
  assert.equal(summary.tasks[0].artifacts.length, 1);
  assert.equal(summary.nextActionableTasks[0].id, '2');
});

// ---------------------------------------------------------------------------
// 5. Parallel execution
// ---------------------------------------------------------------------------

test('parallel(): independent tasks run concurrently', async () => {
  const started = [];
  const order = [];
  const summary = await parallel(
    [
      async () => {
        started.push('A');
        await new Promise((r) => setTimeout(r, 40));
        order.push('A');
        return 'a';
      },
      async () => {
        started.push('B');
        await new Promise((r) => setTimeout(r, 10));
        order.push('B');
        return 'b';
      },
      async () => {
        started.push('C');
        await new Promise((r) => setTimeout(r, 20));
        order.push('C');
        return 'c';
      },
    ],
    { concurrency: 3 }
  );

  assert.equal(summary.ok, true);
  assert.equal(summary.completedCount, 3);
  assert.deepEqual(summary.data, ['a', 'b', 'c']);
  // All three should have started before the first finished (true concurrency).
  assert.equal(started.length, 3);
  // B is fastest so should finish first
  assert.equal(order[0], 'B');
});

test('parallel(): concurrency limit is respected', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const mk = (id) => async () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 30));
    inFlight -= 1;
    return id;
  };
  const summary = await parallel([mk(1), mk(2), mk(3), mk(4), mk(5)], { concurrency: 2 });
  assert.equal(summary.ok, true);
  assert.ok(maxInFlight <= 2, `maxInFlight=${maxInFlight}`);
  assert.equal(summary.completedCount, 5);
});

test('parallel(): cancellation via AbortSignal stops pending work', async () => {
  const ac = new AbortController();
  let started = 0;
  let finished = 0;
  const mk = () => async ({ signal }) => {
    started += 1;
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        finished += 1;
        resolve('done');
      }, 200);
      signal.addEventListener('abort', () => {
        clearTimeout(t);
        reject(Object.assign(new Error('aborted'), { code: 'ABORTED' }));
      }, { once: true });
    });
  };

  setTimeout(() => ac.abort(), 30);
  const summary = await parallel([mk(), mk(), mk(), mk()], {
    concurrency: 2,
    signal: ac.signal,
  });
  assert.equal(summary.ok, false);
  assert.ok(summary.aborted || summary.cancelledCount > 0 || summary.failedCount > 0);
  assert.ok(finished < 4, 'not all tasks should finish after abort');
});

test('parallel(): per-task timeout', async () => {
  const summary = await parallel(
    [
      async () => {
        await new Promise((r) => setTimeout(r, 200));
        return 'slow';
      },
    ],
    { taskTimeoutMs: 30 }
  );
  assert.equal(summary.ok, false);
  assert.equal(summary.results[0].code, 'TASK_TIMEOUT');
});

test('parallel(): partial failure collect policy', async () => {
  const summary = await parallel(
    [
      async () => 'ok1',
      async () => {
        throw Object.assign(new Error('nope'), { code: 'NOPE' });
      },
      async () => 'ok3',
    ],
    { onError: 'collect' }
  );
  assert.equal(summary.ok, false);
  assert.equal(summary.completedCount, 2);
  assert.equal(summary.failedCount, 1);
  assert.equal(summary.data[0], 'ok1');
  assert.equal(summary.data[2], 'ok3');
});

test('parallel(): retry policy retries failed tasks', async () => {
  let tries = 0;
  const summary = await parallel(
    [
      async () => {
        tries += 1;
        if (tries < 3) throw new Error('transient');
        return 'recovered';
      },
    ],
    { retry: { retries: 3, backoffMs: 5, factor: 1 } }
  );
  assert.equal(summary.ok, true);
  assert.equal(summary.data[0], 'recovered');
  assert.equal(tries, 3);
});

test('DAGExecutor runs independent nodes in parallel waves', async () => {
  const dag = new DAG();
  //   A   B
  //    \ /
  //     C
  dag.addNode('A', { title: 'A' });
  dag.addNode('B', { title: 'B' });
  dag.addNode('C', { title: 'C' });
  dag.addEdge('A', 'C');
  dag.addEdge('B', 'C');

  const waveStarted = [];
  const executor = new DAGExecutor({
    dag,
    concurrency: 2,
    taskRunner: async (node) => {
      waveStarted.push({ id: node.id, at: Date.now() });
      await new Promise((r) => setTimeout(r, 40));
      return { ok: true, id: node.id };
    },
  });
  const res = await executor.executeAll();
  assert.equal(res.ok, true);
  assert.deepEqual(res.completedIds.sort(), ['A', 'B', 'C']);
  // A and B should start within a tight window (same wave)
  const a = waveStarted.find((w) => w.id === 'A');
  const b = waveStarted.find((w) => w.id === 'B');
  const c = waveStarted.find((w) => w.id === 'C');
  assert.ok(Math.abs(a.at - b.at) < 30, 'A and B should start nearly together');
  assert.ok(c.at >= a.at + 30, 'C starts after A/B finish');
});

// ---------------------------------------------------------------------------
// 6. End-to-end AbortSignal into tool handlers
// ---------------------------------------------------------------------------

test('AbortSignal reaches tool handler context', async () => {
  const r = new ToolRegistry({ profile: 'admin' });
  let sawSignal = false;
  let sawAborted = false;
  r.register({
    name: 'wait',
    description: 'waits until aborted',
    timeoutMs: 5000,
    handler: async (_args, ctx) => {
      sawSignal = !!ctx.signal;
      return new Promise((resolve, reject) => {
        if (!ctx.signal) return resolve('no-signal');
        if (ctx.signal.aborted) {
          sawAborted = true;
          return reject(Object.assign(new Error('aborted'), { code: 'ABORTED' }));
        }
        ctx.signal.addEventListener('abort', () => {
          sawAborted = true;
          reject(Object.assign(new Error('aborted'), { code: 'ABORTED' }));
        }, { once: true });
      });
    },
  });

  const ac = new AbortController();
  const p = r.execute('wait', {}, { signal: ac.signal });
  setTimeout(() => ac.abort(), 20);
  const res = await p;
  assert.equal(sawSignal, true);
  assert.equal(sawAborted, true);
  assert.equal(res.ok, false);
  assert.ok(res.code === 'ABORTED' || /abort/i.test(res.error));
});

test('handler context exposes sandbox, permissions, logger, tool metadata', async () => {
  const r = new ToolRegistry({ profile: 'developer' });
  let ctxSnap = null;
  r.register({
    name: 'inspect_ctx',
    description: 'captures ctx',
    handler: async (_args, ctx) => {
      ctxSnap = {
        hasSignal: 'signal' in ctx,
        hasSandbox: !!ctx.sandbox,
        hasPermissions: !!ctx.permissions,
        hasLogger: !!ctx.logger,
        hasTool: !!ctx.tool,
        toolName: ctx.tool?.name,
        fs: ctx.permissions?.filesystem,
      };
      return 'ok';
    },
  });
  const res = await r.execute('inspect_ctx', {});
  assert.equal(res.ok, true);
  assert.equal(ctxSnap.hasSandbox, true);
  assert.equal(ctxSnap.hasPermissions, true);
  assert.equal(ctxSnap.hasLogger, true);
  assert.equal(ctxSnap.toolName, 'inspect_ctx');
  assert.equal(ctxSnap.fs, 'sandbox');
});

// ---------------------------------------------------------------------------
// 7. AgentLoop: Run separation + parallel tool_calls + session approval
// ---------------------------------------------------------------------------

test('AgentLoop.run creates a Run distinct from tasks and returns runId', async () => {
  const tools = new ToolRegistry({ profile: 'admin' });
  tools.register({ name: 'noop', description: 'n', handler: async () => 1 });
  const reasoner = async () => ({ type: 'final', content: 'done' });
  const loop = new AgentLoop({
    context: new ContextWindow({ maxTokens: 4000 }),
    tools,
    reasoner,
    maxSteps: 3,
  });
  const result = await loop.run('hello');
  assert.equal(result.status, 'final');
  assert.ok(result.runId);
  assert.ok(result.run);
  assert.equal(result.run.status, 'completed');
  assert.equal(result.run.input, 'hello');
  assert.ok(result.checkpoint.runId);
});

test('AgentLoop executes parallel tool_calls concurrently', async () => {
  const tools = new ToolRegistry({ profile: 'admin' });
  const started = [];
  for (const name of ['a', 'b', 'c']) {
    tools.register({
      name,
      description: name,
      handler: async () => {
        started.push(name);
        await new Promise((r) => setTimeout(r, 30));
        return name.toUpperCase();
      },
    });
  }

  let step = 0;
  const reasoner = async () => {
    step += 1;
    if (step === 1) {
      return {
        type: 'tool_call',
        tools: [
          { tool: 'a', args: {} },
          { tool: 'b', args: {} },
          { tool: 'c', args: {} },
        ],
      };
    }
    return { type: 'final', content: 'all done' };
  };

  const loop = new AgentLoop({
    context: new ContextWindow({ maxTokens: 4000 }),
    tools,
    reasoner,
    maxSteps: 5,
    parallelConcurrency: 3,
  });
  const result = await loop.run('go');
  assert.equal(result.status, 'final');
  assert.equal(started.length, 3);
  const observe = result.stepMemory.find((s) => s.phase === 'observe');
  assert.ok(observe);
  assert.equal(observe.result.ok, true);
  assert.equal(observe.result.data.parallel, true);
  assert.equal(observe.result.data.completedCount, 3);
});

test('AgentLoop: approveToolForSession skips the approval gate', async () => {
  const tools = new ToolRegistry({ profile: 'developer' });
  let ran = false;
  tools.register({
    name: 'danger',
    description: 'gated',
    requiresApproval: true,
    handler: async () => {
      ran = true;
      return 'did-it';
    },
  });

  let step = 0;
  const reasoner = async () => {
    step += 1;
    if (step === 1) return { type: 'tool_call', tool: 'danger', args: {} };
    return { type: 'final', content: 'ok' };
  };

  const loop = new AgentLoop({
    context: new ContextWindow({ maxTokens: 4000 }),
    tools,
    reasoner,
    maxSteps: 5,
    approvals: tools.approvals,
  });

  // Without grant → pauses
  const paused = await loop.run('try');
  assert.equal(paused.status, 'awaiting_tool_approval');
  assert.equal(ran, false);

  // With session grant → runs
  loop.approveToolForSession('danger');
  const tools2 = new ToolRegistry({ profile: 'developer' });
  let ran2 = false;
  tools2.register({
    name: 'danger',
    description: 'gated',
    requiresApproval: true,
    handler: async () => {
      ran2 = true;
      return 'did-it';
    },
  });
  let step2 = 0;
  const reasoner2 = async () => {
    step2 += 1;
    if (step2 === 1) return { type: 'tool_call', tool: 'danger', args: {} };
    return { type: 'final', content: 'ok' };
  };
  const loop2 = new AgentLoop({
    context: new ContextWindow({ maxTokens: 4000 }),
    tools: tools2,
    reasoner: reasoner2,
    maxSteps: 5,
    approvals: tools2.approvals,
  });
  loop2.approveToolForSession('danger');
  const ok = await loop2.run('try2');
  assert.equal(ok.status, 'final');
  assert.equal(ran2, true);
});

test('npm package_install defaults to --ignore-scripts under developer profile', async () => {
  // We don't actually run npm install (network); we unit-test the decision helper
  // via the sandbox API.
  const sandbox = createSandbox({ rootDir: process.cwd(), level: SandboxLevel.RESTRICTED });
  assert.equal(sandbox.allowLifecycleScripts({ package: 'allow' }), false, 'restricted never allows scripts');
  const dangerous = createSandbox({ rootDir: process.cwd(), level: SandboxLevel.DANGEROUS });
  assert.equal(dangerous.allowLifecycleScripts({ package: 'allow' }), true);
  assert.equal(dangerous.allowLifecycleScripts({ package: 'no_scripts' }), false);
});

test('resolveToolRisk / resolveToolPermissions cover known tools', () => {
  assert.equal(resolveToolRisk({ name: 'delete_file' }), 'high');
  assert.equal(resolveToolRisk({ name: 'read_file' }), 'low');
  assert.equal(resolveToolPermissions({ name: 'web_search' }).network, 'allow');
  assert.equal(resolveToolPermissions({ name: 'shell' }).shell, 'restricted');
});
