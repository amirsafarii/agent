import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BudgetManager } from '../src/budget/budget-manager.js';

test('BudgetManager: tracks usage and reports exceeded limits', () => {
  const b = new BudgetManager({ maxToolCalls: 3, maxModelCalls: 2 });
  assert.equal(b.exceeded().exceeded, false);
  b.recordToolCall();
  b.recordToolCall();
  assert.equal(b.exceeded().exceeded, false);
  b.recordToolCall();
  assert.equal(b.exceeded().exceeded, true);
  assert.deepEqual(b.exceeded().units, ['toolCalls']);
  assert.match(b.reason(), /budget exceeded: toolCalls \(3 >= 3\)/);
});

test('BudgetManager: model calls and tokens aggregate with dollars', () => {
  const b = new BudgetManager({ maxModelCalls: 1 });
  b.recordModelCall(1000);
  assert.equal(b.usage.modelCalls, 1);
  assert.equal(b.usage.tokens, 1000);
  assert.ok(b.dollars > 0, 'derives a dollar figure from tokens');
  assert.equal(b.exceeded().exceeded, true);
});

test('BudgetManager: runtime budget enforced via elapsed time', async () => {
  const b = new BudgetManager({ maxRuntimeMs: 5 });
  await new Promise((r) => setTimeout(r, 15));
  const ex = b.exceeded();
  assert.equal(ex.exceeded, true);
  assert.ok(ex.units.includes('runtimeMs'));
});

test('BudgetManager: scoped children share counters and cannot overspend the parent', () => {
  const parent = new BudgetManager({ maxToolCalls: 4 });
  parent.recordToolCall(); // 1 used, 3 left
  const childA = parent.scope('task_a');
  const childB = parent.scope('task_b');
  childA.recordToolCall();
  childA.recordToolCall();
  childB.recordToolCall(); // total now 4
  assert.equal(parent.usage.toolCalls, 4, 'children share the same counters');
  assert.equal(parent.exceeded().exceeded, true);
  // Child remaining was fixed at spawn (3), so it thinks it exceeded too.
  assert.equal(childA.exceeded().exceeded, true);
});

test('BudgetManager: no limits means never exceeded', () => {
  const b = new BudgetManager();
  b.recordToolCall();
  b.recordModelCall(999999);
  assert.equal(b.exceeded().exceeded, false);
  assert.equal(b.reason(), null);
});

test('BudgetManager: toJSON snapshot is serializable', () => {
  const b = new BudgetManager({ maxToolCalls: 2 });
  b.recordToolCall();
  const snap = b.toJSON();
  assert.equal(snap.usage.toolCalls, 1);
  assert.equal(snap.limits.toolCalls, 2);
  assert.equal(snap.remaining.toolCalls, 1);
});
