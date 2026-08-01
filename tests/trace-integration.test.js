import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentLoop } from '../src/core/loop/index.js';
import { ToolRegistry } from '../src/tools/index.js';
import { ContextWindow } from '../src/core/context.js';
import { globalTracer } from '../src/core/tracer.js';

test('Tracer integration: traces agent.run, reasoner and tools hierarchically', async () => {
  globalTracer.clear();

  const tools = new ToolRegistry();
  tools.register({
    name: 'web_search',
    description: 'search the web',
    parameters: {},
    handler: async () => 'search result',
  });

  let i = 0;
  const script = [
    { type: 'tool_call', tool: 'web_search', args: {} },
    { type: 'final', content: 'done' },
  ];
  const reasoner = async () => {
    return script[i++];
  };

  const loop = new AgentLoop({
    context: new ContextWindow({ maxTokens: 8000 }),
    tools,
    reasoner,
  });

  await loop.run('find something');

  // Verify that spans were captured
  const traces = [...globalTracer.traces.values()];
  assert.equal(traces.length, 1);

  const root = traces[0];
  assert.equal(root.name, 'agent.run');

  const children = root.children;
  assert.ok(children.length >= 2, 'Should have at least reasoner and tool search spans');

  const reasonerSpans = children.filter((c) => c.name === 'reasoner');
  assert.ok(reasonerSpans.length >= 1, 'Should contain a reasoner span');

  const toolSpans = children.filter((c) => c.name === 'tool.search');
  assert.equal(toolSpans.length, 1, 'Should map web_search tool to tool.search span name');
  assert.equal(toolSpans[0].attributes.tool, 'web_search');
});
