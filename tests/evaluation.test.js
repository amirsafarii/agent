import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EvaluationEngine,
  GoalState,
  EvalNext,
  evidenceOf,
  sha256,
} from '../src/evaluation/index.js';

test('EvaluationEngine: deterministic critic demands evidence before success', async () => {
  const eng = new EvaluationEngine();
  // No evidence, no expected match → cannot claim success.
  const open = await eng.evaluate({ goal: 'make a server', action: { type: 'tool_call', tool: 'write_file' }, observation: null });
  assert.equal(open.success, false);
  assert.equal(open.next, EvalNext.CONTINUE);
  assert.equal(open.confidence, 0.1);

  // Verification evidence backs the claim → success.
  const verified = await eng.evaluate({
    goal: 'create app',
    action: { type: 'tool_call', tool: 'verify_suite' },
    observation: { ok: true, passed: 3, failed: 0, total: 3 },
    verification: { ok: true, passed: 3, failed: 0, total: 3 },
  });
  assert.equal(verified.success, true);
  assert.equal(verified.next, EvalNext.FINISH);
  assert.ok(verified.confidence > 0.9, 'high confidence when verification passed');

  // Verification failure → repair.
  const failed = await eng.evaluate({
    goal: 'create app',
    action: { type: 'tool_call', tool: 'verify_suite' },
    observation: { ok: false, failed: 1 },
    verification: { ok: false, passed: 0, failed: 1, total: 1 },
  });
  assert.equal(failed.success, false);
  assert.equal(failed.next, EvalNext.REPAIR);
});

test('EvaluationEngine: expected-outcome matching drives success', async () => {
  const eng = new EvaluationEngine();
  const good = await eng.evaluate({
    goal: 'server returns hello',
    action: { type: 'tool_call', tool: 'http_get' },
    observation: 'hello world',
    expected: 'hello',
  });
  assert.equal(good.success, true);
  assert.equal(good.next, EvalNext.FINISH);

  const bad = await eng.evaluate({
    goal: 'server returns hello',
    action: { type: 'tool_call', tool: 'http_get' },
    observation: 'goodbye',
    expected: 'hello',
  });
  assert.equal(bad.success, false);
  assert.equal(bad.next, EvalNext.REPAIR);
  assert.equal(bad.confidence, 0.3);
});

test('EvaluationEngine: custom LLM critic is honored', async () => {
  const eng = new EvaluationEngine({
    critic: async ({ goal, observation }) => ({
      success: true,
      confidence: 0.8,
      reason: `critic judged "${observation}" satisfies "${goal}"`,
      next: EvalNext.FINISH,
    }),
  });
  const out = await eng.evaluate({ goal: 'g', observation: 'anything' });
  assert.equal(out.success, true);
  assert.equal(out.confidence, 0.8);
  assert.match(out.reason, /critic judged/);
});

test('EvaluationEngine: a throwing critic degrades, never crashes', async () => {
  const eng = new EvaluationEngine({ critic: async () => { throw new Error('model down'); } });
  const out = await eng.evaluate({ goal: 'g', observation: 'x' });
  assert.equal(out.success, false);
  assert.equal(out.confidence, 0.1);
});

test('GoalState: tracks requirements with evidence and proves satisfaction', () => {
  const gs = new GoalState({ goal: 'Create X', requirements: [
    { id: 'file', description: 'file exists' },
    { id: 'api', description: 'API works' },
    { id: 'tests', description: 'tests pass' },
    { id: 'readme', description: 'README missing' },
  ] });
  assert.equal(gs.isSatisfied(), false);
  gs.markSatisfied('file', evidenceOf('file exists', [{ type: 'file', path: 'x.js' }]));
  gs.markSatisfied('api', evidenceOf('API works', [{ type: 'command', command: 'curl /api', output: '200' }]));
  gs.markSatisfied('tests', evidenceOf('tests pass', [{ type: 'command', command: 'npm test', output: '152 passed' }]));
  assert.equal(gs.isSatisfied(), false, 'README still unsatisfied');
  assert.equal(gs.unsatisfied.length, 1);
  assert.equal(gs.unsatisfied[0].id, 'readme');

  gs.markSatisfied('readme', evidenceOf('README present', [{ type: 'file', path: 'README.md' }]));
  assert.equal(gs.isSatisfied(), true);
  assert.equal(gs.satisfied.length, 4);

  const s = gs.toJSON();
  assert.equal(s.goal, 'Create X');
  assert.equal(s.isSatisfied, true);
  assert.ok(s.requirements.every((r) => r.satisfied));
  assert.equal(s.requirements[1].evidence.length, 1);

  const restored = GoalState.fromJSON(s);
  assert.equal(restored.isSatisfied(), true);
});

test('GoalState: requirement with evidence carries provenance shape', () => {
  const gs = new GoalState({ goal: 'g' });
  gs.addRequirement('tests pass').markSatisfied('req_1', evidenceOf('tests pass', [
    { type: 'command', command: 'npm test', output: '152 passed' },
  ]));
  const req = gs.toJSON().requirements[0];
  assert.deepEqual(req.evidence[0], {
    type: 'command',
    command: 'npm test',
    output: '152 passed',
  });
});

test('evidenceOf: builds structured provenance and sha256 works', () => {
  const ev = evidenceOf('server runs on port 3000', [{ type: 'command', command: 'npm test', stdout: '152 passed' }]);
  assert.equal(ev.claim, 'server runs on port 3000');
  assert.equal(ev.evidence[0].command, 'npm test');
  assert.equal(ev.evidence[0].output, '152 passed');
  assert.equal(sha256('abc'), sha256('abc'));
  assert.equal(sha256('abc').length, 64);
  assert.notEqual(sha256('abc'), sha256('abd'));
});
