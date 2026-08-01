import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Tracer, Span } from '../src/core/tracer.js';

test('Tracer: starts and ends spans with hierarchy', () => {
  const tracer = new Tracer();
  
  const root = tracer.startSpan('agent.run');
  assert.equal(root.name, 'agent.run');
  assert.ok(root.traceId);
  assert.equal(root.parentId, null);

  const child = tracer.startSpan('reasoner');
  assert.equal(child.name, 'reasoner');
  assert.equal(child.parentId, root.id);
  assert.equal(child.traceId, root.traceId);

  tracer.endSpan(child);
  assert.ok(child.endTime);

  tracer.endSpan(root);
  assert.ok(root.endTime);

  const tree = root.toJSON();
  assert.equal(tree.children.length, 1);
  assert.equal(tree.children[0].name, 'reasoner');
});
