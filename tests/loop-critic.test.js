import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFilesystemTools } from '../src/tools/filesystem.js';
import { ToolRegistry } from '../src/tools/index.js';
import { VerificationEngine } from '../src/verification/index.js';
import { EvaluationEngine, GoalState } from '../src/evaluation/index.js';
import { BudgetManager } from '../src/budget/budget-manager.js';
import { ArtifactManager } from '../src/artifacts/artifact-manager.js';
import { AgentLoop } from '../src/core/loop/index.js';
import { ContextWindow } from '../src/core/context.js';
import { LoopEvents } from '../src/core/loop/events.js';
import { LongTermMemory } from '../src/memory/layers/long-term-memory.js';

function fsRegistry(root) {
  const reg = new ToolRegistry();
  for (const def of createFilesystemTools({ rootDir: root })) reg.register(def);
  return reg;
}

// --- #19 apply_patch -------------------------------------------------------

test('apply_patch: validates and applies hunks atomically', async () => {
  const root = mkdtempSync(join(tmpdir(), 'scrappyai-patch-'));
  writeFileSync(join(root, 'app.js'), 'const x = 1;\nconsole.log(x);\n');
  const reg = fsRegistry(root);

  const ok = await reg.execute('apply_patch', {
    file: 'app.js',
    hunks: [
      { old: 'const x = 1;', new: 'const x = 2;' },
      { old: 'console.log(x);', new: 'console.log("x is", x);' },
    ],
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.data.hunksApplied, 2);
  assert.equal(ok.data.beforeHash.length, 64);
  assert.notEqual(ok.data.beforeHash, ok.data.afterHash);
  assert.match(readFileSync(join(root, 'app.js'), 'utf8'), /const x = 2;/);
});

test('apply_patch: rejects the whole patch if any hunk does not match exactly once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'scrappyai-patch-'));
  writeFileSync(join(root, 'app.js'), 'const x = 1;\n');
  const reg = fsRegistry(root);

  const r = await reg.execute('apply_patch', {
    file: 'app.js',
    hunks: [
      { old: 'const x = 1;', new: 'const x = 2;' },
      { old: 'THIS DOES NOT EXIST', new: 'nope' },
    ],
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'VALIDATION_ERROR');
  // Nothing was written — atomic.
  assert.match(readFileSync(join(root, 'app.js'), 'utf8'), /const x = 1;/);
});

test('apply_patch: supports optional post-apply verify command', async () => {
  const root = mkdtempSync(join(tmpdir(), 'scrappyai-patch-'));
  writeFileSync(join(root, 'app.js'), 'console.log("hello");\n');
  const reg = fsRegistry(root);
  const r = await reg.execute('apply_patch', {
    file: 'app.js',
    hunks: [{ old: 'hello', new: 'world' }],
    verify: { command: 'grep -q world app.js && echo PASS', expectedExitCode: 0 },
  });
  assert.equal(r.ok, true);
  assert.equal(r.data.verify.ok, true);
});

// --- #23 tool contract versioning + #22 typed results -----------------------

test('tool contract: exposes version, inputSchema, outputSchema', () => {
  const root = mkdtempSync(join(tmpdir(), 'scrappyai-contract-'));
  const reg = fsRegistry(root);
  reg.register({
    name: 'custom_tool',
    version: '2.1.0',
    description: 'a custom tool',
    parameters: { q: { type: 'string', required: true } },
    inputSchema: { q: { type: 'string' } },
    outputSchema: { ok: { type: 'boolean' } },
    handler: async () => ({ ok: true }),
  });
  const c = reg.toolContract('custom_tool');
  assert.equal(c.version, '2.1.0');
  assert.deepEqual(c.inputSchema, { q: { type: 'string' } });
  assert.deepEqual(c.outputSchema, { ok: { type: 'boolean' } });
  assert.equal(reg.toolContract('nope'), null);

  const contracts = reg.listContracts();
  const custom = contracts.find((x) => x.name === 'custom_tool');
  assert.equal(custom.version, '2.1.0');
});

test('typed result: success carries meta, failure carries errorInfo', async () => {
  const root = mkdtempSync(join(tmpdir(), 'scrappyai-typed-'));
  const reg = fsRegistry(root);
  const ok = await reg.execute('write_file', { path: 'a.txt', content: 'hi' });
  assert.equal(ok.ok, true);
  assert.equal(ok.meta.source, 'write_file');
  assert.equal(typeof ok.meta.durationMs, 'number');
  assert.equal(ok.meta.truncated, false);

  const bad = await reg.execute('write_file', { path: 'x.txt', content: 'y', append: true, missingArg: 1 });
  assert.equal(bad.ok, true); // extra arg is fine, but content path ok
  // A genuinely invalid call: unknown tool.
  const unknown = await reg.execute('nope', {});
  assert.equal(unknown.ok, false);
  assert.equal(unknown.errorInfo.code, 'UNKNOWN_TOOL');
  assert.equal(unknown.errorInfo.retryable, false);
  assert.equal(typeof unknown.meta.durationMs, 'number');
});

// --- #15 / #16 memory provenance + conflict ---------------------------------

test('long-term memory: scope, evidence, supersedes recorded', async () => {
  const lt = new LongTermMemory({});
  await lt.upsertByKey({ userId: 'u', key: 'city', value: 'Ilam', source: 'explicit', turnId: 't1', sessionId: 's1' });
  await lt.upsertByKey({ userId: 'u', key: 'city', value: 'Tehran', source: 'explicit', turnId: 't2', sessionId: 's1' });

  const [fact] = await lt.list({ userId: 'u' });
  assert.equal(fact.value, 'Tehran', 'current value is Tehran');
  assert.equal(fact.scope, 'user');
  assert.deepEqual(fact.evidence, { sessionId: 's1', turnId: 't2' });
  assert.equal(fact.supersedes.value, 'Ilam', 'explicit supersession records old value');
  assert.equal(fact.versions.length, 2, 'full history preserved');
});

test('long-term memory: a weaker inferred guess cannot clobber a confirmed fact', async () => {
  const lt = new LongTermMemory({});
  await lt.upsertByKey({ userId: 'u', key: 'city', value: 'Ilam', source: 'explicit', confidence: 1 });
  await lt.upsertByKey({ userId: 'u', key: 'city', value: 'Wrong', source: 'inferred', confidence: 0.6 });

  const [fact] = await lt.list({ userId: 'u' });
  assert.equal(fact.value, 'Ilam', 'confirmed value untouched');
  assert.equal(fact.requiresConfirmation, true);
  assert.equal(fact.pendingValue, 'Wrong');

  await lt.confirmPending(fact.id);
  const [after] = await lt.list({ userId: 'u' });
  assert.equal(after.value, 'Wrong');
  assert.equal(after.confirmedByUser, true);
});

// --- #14 verification evidence ---------------------------------------------

test('verification: runSuite results carry evidence provenance', async () => {
  const root = mkdtempSync(join(tmpdir(), 'scrappyai-evidence-'));
  writeFileSync(join(root, 'server.js'), 'console.log("listening on 3000");');
  const eng = new VerificationEngine({ rootDir: root });
  const res = await eng.runSuite({ checks: [
    { type: 'file', path: 'server.js', contains: '3000' },
    { type: 'command', command: 'node server.js', stdoutContains: 'listening' },
  ]});
  assert.equal(res.ok, true);
  assert.equal(res.passed, 2);
  const cmdRes = res.results.find((r) => r.check === 'command_exit');
  assert.ok(cmdRes.evidence, 'evidence attached');
  assert.equal(cmdRes.evidence.type, 'command');
  assert.match(cmdRes.evidence.output, /listening on 3000/);
  const fileRes = res.results.find((r) => r.check === 'verify_file');
  assert.equal(fileRes.evidence.type, 'file');
});

// --- #11 / #13 / #24 loop wiring --------------------------------------------

function makeLoop({ evaluator, budgetManager, goalState, artifactManager, toolAction }) {
  const root = mkdtempSync(join(tmpdir(), 'scrappyai-loop-'));
  writeFileSync(join(root, 'target.txt'), 'start');
  const tools = fsRegistry(root);
  tools.register({
    name: 'grab_verification',
    handler: async () => ({ ok: true, passed: 2, failed: 0, total: 2 }),
  });
  tools.register({
    name: 'fail_verification',
    handler: async () => ({ ok: false, passed: 0, failed: 2, total: 2 }),
  });
  const context = new ContextWindow({ maxTokens: 4000 });
  let reasonerCalls = 0;
  const reasoner = async () => {
    reasonerCalls += 1;
    if (reasonerCalls <= 1) return toolAction();
    return { type: 'final', content: 'done' };
  };
  return new AgentLoop({ context, tools, reasoner, evaluator, budgetManager, goalState, artifactManager, maxSteps: 6 });
}

test('loop: evaluation steers repair after a failed verification', async () => {
  const evals = [];
  const evaluator = new EvaluationEngine();
  const agent = makeLoop({ evaluator, toolAction: () => ({ type: 'tool_call', tool: 'fail_verification', args: {} }) });
  agent.onEvent = (event, payload) => {
    if (event === LoopEvents.EVALUATE) evals.push(payload.verdict);
  };
  const out = await agent.run('make it work');
  assert.equal(out.status, 'final');
  assert.ok(evals.length >= 1, 'evaluate event fired');
  const last = evals.at(-1);
  assert.equal(last.next, 'repair', 'critic said repair on failing verification');
});

test('loop: goal completion detector is attached to the final result', async () => {
  const goalState = new GoalState({ goal: 'create target', requirements: [{ id: 'file', description: 'file exists' }] });
  const agent = makeLoop({ goalState, toolAction: () => ({ type: 'tool_call', tool: 'read_file', args: { path: 'target.txt' } }) });
  goalState.markSatisfied('file');
  const out = await agent.run('make it work');
  assert.equal(out.status, 'final');
  assert.equal(out.goal.goal, 'create target');
  assert.equal(out.goal.isSatisfied, true);
});

test('loop: artifact ledger is attached to the final result', async () => {
  const artifactManager = new ArtifactManager();
  await artifactManager.register({ type: 'report', data: { title: 'r' } });
  const agent = makeLoop({ artifactManager, toolAction: () => ({ type: 'tool_call', tool: 'read_file', args: { path: 'target.txt' } }) });
  const out = await agent.run('make it work');
  assert.equal(out.artifacts.length, 1);
  assert.equal(out.artifactStats.count, 1);
});

test('loop: budget manager stops the run when a limit is exceeded', async () => {
  const budgetManager = new BudgetManager({ maxToolCalls: 1 });
  // Two steps would be needed (tool then final), but the tool call consumes
  // the only tool-call budget, so the run stops before final.
  const agent = makeLoop({ budgetManager, toolAction: () => ({ type: 'tool_call', tool: 'grab_verification', args: {} }) });
  const out = await agent.run('do it');
  assert.equal(out.status, 'error');
  assert.equal(out.reason, 'budget_exceeded');
});
