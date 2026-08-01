import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentLoop } from '../src/core/loop/index.js';
import { ToolRegistry } from '../src/tools/index.js';
import { ContextWindow } from '../src/core/context.js';
import { EventBus } from '../src/core/event-bus.js';

test('EventBus integration: fires all key loop events', async () => {
  const tools = new ToolRegistry();
  tools.register({
    name: 'test_tool',
    description: 'a test tool',
    parameters: {},
    handler: async () => 'tool output',
  });

  let i = 0;
  const script = [
    { type: 'tool_call', tool: 'test_tool', args: {} },
    { type: 'final', content: 'finished!' },
  ];
  const reasoner = async () => {
    const action = script[i++];
    return action;
  };

  const bus = new EventBus();
  const fired = [];

  bus.subscribe('*', (evt) => {
    fired.push(evt);
  });

  const loop = new AgentLoop({
    context: new ContextWindow({ maxTokens: 8000 }),
    tools,
    reasoner,
    eventBus: bus,
  });

  await loop.run('hello');

  const eventNames = fired.map((f) => f.event);
  assert.ok(eventNames.includes('agent.run.started'), 'should fire agent.run.started');
  assert.ok(eventNames.includes('agent.step.started'), 'should fire agent.step.started');
  assert.ok(eventNames.includes('agent.tool.started'), 'should fire agent.tool.started');
  assert.ok(eventNames.includes('agent.tool.completed'), 'should fire agent.tool.completed');
  assert.ok(eventNames.includes('agent.run.completed'), 'should fire agent.run.completed');
  assert.ok(eventNames.includes('agent.task.completed'), 'should fire agent.task.completed');

  const started = fired.find((f) => f.event === 'agent.tool.started');
  assert.equal(started.tool, 'test_tool');

  const completed = fired.find((f) => f.event === 'agent.tool.completed');
  assert.equal(completed.tool, 'test_tool');
  assert.equal(completed.result.ok, true);
});
