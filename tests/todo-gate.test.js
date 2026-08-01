/**
 * tests/todo-gate.test.js — TODO / Checklist gate tests
 * ----------------------------------------------------
 * Verifies:
 *   - TodoManager parses, serializes, ticks/unticks
 *   - canFinish() blocks when items are pending/unverified/untested
 *   - completeness.js detects placeholder / stub code
 *   - AgentLoop blocks FINAL while TODO gate is unsatisfied
 *   - Simple (no TODO) turns still finalize normally
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { TodoManager } from '../src/core/todo-manager.js';
import { checkCompleteness, formatCompletenessResult } from '../src/verification/completeness.js';
import { AgentLoop } from '../src/core/loop/index.js';
import { ToolRegistry } from '../src/tools/index.js';
import { ContextWindow } from '../src/core/context.js';
import { createScriptedClient } from '../src/core/reasoner.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tmpDir;
beforeEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = mkdtempSync(join(tmpdir(), 'scrappy-todo-'));
});

test.after(() => { if (tmpDir) rmSync(tmpDir, { recursive: true, force: true }); });

// ---------- TodoManager unit ----------

test('TodoManager: create / tick / canFinish lifecycle', async () => {
  const tm = new TodoManager({ rootDir: tmpDir });
  await tm.create('test goal', [
    { id: '1', text: 'Write file A' },
    { id: '2', text: 'Verify file A' },
    { id: '3', text: 'Test file A' },
  ]);

  let s = tm.summary();
  assert.equal(s.total, 3);
  assert.equal(s.canFinish, false);
  assert.equal(tm.canFinish().ok, false);

  // Tick without verified/tested -> code-like tasks still blocked
  await tm.tick('1');
  assert.equal(tm.canFinish().ok, false);

  await tm.tick('1', { verified: true });
  // code-like item still needs testPassed
  assert.equal(tm.canFinish().ok, false);

  await tm.tick('1', { testPassed: true });
  await tm.tick('2', { verified: true, testPassed: true });
  await tm.tick('3', { verified: true, testPassed: true });
  assert.equal(tm.canFinish().ok, true, 'all items done+verified+tested -> can finish');
});

test('TodoManager: skipped items do not block finish', async () => {
  const tm = new TodoManager({ rootDir: tmpDir });
  await tm.create('goal', [
    { id: '1', text: 'Write README' },
    { id: '2', text: 'Deploy to prod' },
  ]);
  await tm.tick('1', { verified: true, testPassed: true });
  await tm.skip('2', { reason: 'deploy not needed for this task' });
  assert.equal(tm.canFinish().ok, true);
});

test('TodoManager: untick reopens and requires reverify', async () => {
  const tm = new TodoManager({ rootDir: tmpDir });
  await tm.create('g', [{ id: '1', text: 'Write code.js' }]);
  await tm.tick('1', { verified: true, testPassed: true });
  assert.equal(tm.canFinish().ok, true);
  await tm.untick('1', { reason: 'found a bug' });
  assert.equal(tm.canFinish().ok, false);
});

test('TodoManager: serializes to TODO.md on disk', async () => {
  const tm = new TodoManager({ rootDir: tmpDir, filePath: 'TODO.md' });
  await tm.create('my goal', [{ id: '1', text: 'Write file' }]);
  // tick it
  await tm.tick('1', { verified: true, testPassed: true });
  const disk = await import('node:fs/promises').then((fs) => fs.readFile(tm.absolutePath, 'utf8'));
  assert.match(disk, /- \[x\]/);
  assert.match(disk, /my goal/);
});

// ---------- completeness detector ----------

test('completeness: detects TODO comment', () => {
  const r = checkCompleteness('function foo() {\n  // TODO: implement\n  return 1;\n}\n', 'foo.js');
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.name === 'todo_comment'));
});

test('completeness: detects not-implemented stub', () => {
  const r = checkCompleteness('function foo() {\n  throw new Error("not implemented");\n}\n', 'foo.js');
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.name === 'not_implemented_error'));
});

test('completeness: detects unbalanced braces (truncation)', () => {
  const r = checkCompleteness('function foo() {\n  return 1;\n', 'foo.js');
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.name === 'unbalanced_braces'), JSON.stringify(r.errors));
});

test('completeness: accepts a clean, complete file', () => {
  const code = `
export function add(a, b) {
  return a + b;
}
export function sub(a, b) {
  return a - b;
}
`.trim() + '\n';
  const r = checkCompleteness(code, 'math.js');
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.errors.length, 0);
});

test('completeness: detects "your code here" placeholder', () => {
  const r = checkCompleteness('function init() {\n  // your code here\n}\n', 'x.js');
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.name === 'your_code_here'));
});

test('completeness: detects "rest of code" truncation', () => {
  const r = checkCompleteness('// rest of code goes here\nmodule.exports = {};\n', 'x.js');
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.name === 'rest_of_code'));
});

// ---------- AgentLoop FINAL gate ----------

function makeLoop({ todoManager, strictFinal = true } = {}) {
  const tools = new ToolRegistry();
  tools.register({
    name: 'ping',
    description: 'ping',
    parameters: {},
    handler: async () => ({ ok: true, data: 'pong' }),
  });
  const context = new ContextWindow({ maxTokens: 4000, systemPrompt: 'test' });
  const scripted = createScriptedClient([
    { type: 'tool_call', tool: 'ping', args: {} },
    { type: 'final', content: 'done' },
  ]);
  return new AgentLoop({
    context,
    tools,
    reasoner: (rendered, schema, opts) => scripted.chat({ systemPrompt: 'x', messages: rendered, tools: schema }, opts),
    maxSteps: 5,
    adaptiveMaxSteps: false,
    toolRetry: { retries: 0 },
    todoManager,
    strictFinal,
    budgetManager: null,
  });
}

test('AgentLoop: simple turn (no TODO) still finalizes', async () => {
  const loop = makeLoop();
  const res = await loop.run('hello');
  assert.equal(res.status, 'final');
});

test('AgentLoop: blocks final when TODO has pending items', async () => {
  const tm = new TodoManager({ rootDir: tmpDir });
  await tm.create('goal', [{ id: '1', text: 'Do a thing' }]);
  const loop = makeLoop({ todoManager: tm });
  // Reasoner tries tool call then final, but final gets blocked. The scripted
  // client only has two responses, so the loop must NOT produce a final;
  // it will eventually run out of scripted responses and error out.
  // The key assertion: it must NOT return status='final'.
  // Give it a reasoner that always returns final (lazy) and confirm block.
  const tools = new ToolRegistry();
  tools.register({ name: 'ping', description: 'ping', parameters: {}, handler: async () => 'pong' });
  const context = new ContextWindow({ maxTokens: 4000, systemPrompt: 'test' });
  let callCount = 0;
  const loop2 = new AgentLoop({
    context,
    tools,
    reasoner: async () => {
      callCount++;
      if (callCount === 1) return { type: 'tool_call', tool: 'ping', args: {} };
      return { type: 'final', content: 'done' };
    },
    maxSteps: 6,
    adaptiveMaxSteps: false,
    toolRetry: { retries: 0 },
    todoManager: tm,
    strictFinal: true,
    budgetManager: null,
  });
  const res = await loop2.run('hello');
  // The TODO gate blocks final repeatedly; eventually hits max_steps.
  assert.equal(res.status, 'max_steps', 'lazy final blocked until max steps');
  assert.ok(callCount > 2, 'reasoner was called more than twice (loop continued after blocked final)');
});

test('AgentLoop: allows final after TODO is completed', async () => {
  const tm = new TodoManager({ rootDir: tmpDir });
  await tm.create('goal', [{ id: '1', text: 'ping task' }]);

  let call = 0;
  const tools = new ToolRegistry();
  tools.register({
    name: 'ping',
    description: 'ping',
    parameters: {},
    handler: async () => {
      // On first call, mark TODO done
      await tm.tick('1', { verified: true, testPassed: true });
      return { ok: true };
    },
  });
  const context = new ContextWindow({ maxTokens: 4000, systemPrompt: 'test' });
  const loop = new AgentLoop({
    context,
    tools,
    reasoner: async () => {
      call++;
      if (call === 1) return { type: 'tool_call', tool: 'ping', args: {} };
      return { type: 'final', content: 'done' };
    },
    maxSteps: 5,
    adaptiveMaxSteps: false,
    toolRetry: { retries: 0 },
    todoManager: tm,
    strictFinal: true,
    budgetManager: null,
  });
  const res = await loop.run('hi');
  assert.equal(res.status, 'final', 'after TODO is ticked+verified+tested final is allowed');
});
