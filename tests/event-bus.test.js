import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../src/core/event-bus.js';

test('EventBus: publishes events and unsubscribes cleanly', () => {
  const bus = new EventBus();
  const events = [];

  const unsub = bus.subscribe('agent.run.started', (data) => {
    events.push(data);
  });

  bus.publish('agent.run.started', { runId: 'r1' });
  assert.equal(events.length, 1);
  assert.equal(events[0].runId, 'r1');
  assert.equal(events[0].event, 'agent.run.started');

  unsub();
  bus.publish('agent.run.started', { runId: 'r2' });
  assert.equal(events.length, 1); // no new events
});

test('EventBus: supports wildcard subscription', () => {
  const bus = new EventBus();
  const events = [];

  bus.subscribe('*', (data) => {
    events.push(data);
  });

  bus.publish('agent.run.started', { runId: 'r1' });
  bus.publish('agent.step.started', { step: 1 });

  assert.equal(events.length, 2);
  assert.equal(events[0].event, 'agent.run.started');
  assert.equal(events[1].event, 'agent.step.started');
});
