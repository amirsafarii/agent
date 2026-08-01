/**
 * tool-system.test.js — modular registry/runner/plugin contract
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ToolRegistry,
  ToolErrorCode,
  createPlugin,
  createWebPlugin,
} from '../src/tools/index.js';
import { AgentLoop } from '../src/core/loop/index.js';
import { ContextWindow } from '../src/core/context.js';

function helloTool(state = {}) {
  return {
    name: 'hello',
    description: 'Say hello',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
    async execute({ name }, context) {
      state.context = context;
      return `Hello ${name}`;
    },
  };
}

test('custom Tool uses the canonical contract and LLM definitions hide implementation', async () => {
  const state = {};
  const registry = new ToolRegistry();
  registry.register(helloTool(state));

  assert.equal(registry.has('hello'), true);
  assert.equal(registry.get('hello').execute instanceof Function, true);
  assert.deepEqual(registry.getDefinitions(), [{
    name: 'hello',
    description: 'Say hello',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
  }]);
  assert.equal('execute' in registry.getDefinitions()[0], false);
  assert.equal('handler' in registry.getDefinitions()[0], false);

  const result = await registry.run('hello', { name: 'Ada' });
  assert.equal(result.ok, true);
  assert.equal(result.data, 'Hello Ada');
  assert.ok(state.context.logger);
  assert.ok('signal' in state.context);
  assert.ok('config' in state.context);

  registry.unregister('hello');
  assert.equal(registry.has('hello'), false);
});

test('plugin mounts multiple first-class Tools, preserves metadata, and removes ownership', async () => {
  const plugin = createPlugin({
    name: 'custom-plugin',
    metadata: { owner: 'tests', feature: 'demo' },
    tools: [
      { name: 'one', description: 'one', execute: async () => 1 },
      { name: 'two', description: 'two', execute: async () => 2 },
    ],
  });
  const registry = new ToolRegistry();
  registry.use(plugin);

  assert.deepEqual(registry.listPlugins(), [{
    name: 'custom-plugin',
    metadata: { owner: 'tests', feature: 'demo' },
    tools: ['one', 'two'],
  }]);
  assert.equal(registry.get('one').pluginName, 'custom-plugin');
  assert.equal((await registry.run('two', {})).data, 2);
  assert.equal(registry.removePlugin('custom-plugin'), true);
  assert.equal(registry.has('one'), false);
  assert.equal(registry.has('two'), false);
  assert.equal(registry.removePlugin('custom-plugin'), false);
});

test('central validation happens before execute and returns TOOL_INVALID_INPUT', async () => {
  let called = false;
  const registry = new ToolRegistry();
  registry.register({
    name: 'needs_name',
    description: 'validation test',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
    execute: async () => {
      called = true;
      return 'should not run';
    },
  });

  const result = await registry.run('needs_name', {});
  assert.equal(result.ok, false);
  assert.equal(result.error.code, ToolErrorCode.INVALID_INPUT);
  assert.match(result.error.message, /Missing required argument "name"/);
  assert.equal(called, false);
});

test('standard errors cover not found, disabled, permission and Tool failures', async () => {
  const registry = new ToolRegistry({ profile: 'readonly' });
  registry.register({
    name: 'process_tool',
    description: 'needs process capability',
    permissions: ['process'],
    execute: async () => 1,
  });
  registry.register({
    name: 'disabled_tool',
    description: 'off',
    enabled: false,
    execute: async () => 1,
  });
  registry.register({
    name: 'broken_tool',
    description: 'throws',
    execute: async () => {
      throw new Error('broken');
    },
  });

  assert.equal((await registry.run('missing', {})).error.code, ToolErrorCode.NOT_FOUND);
  assert.equal((await registry.run('disabled_tool', {})).error.code, ToolErrorCode.DISABLED);
  assert.equal((await registry.run('process_tool', {})).error.code, ToolErrorCode.PERMISSION_DENIED);
  const failed = await registry.run('broken_tool', {});
  assert.equal(failed.ok, false);
  assert.equal(failed.error.code, ToolErrorCode.FAILED);
  assert.equal(failed.error.message, 'broken');
});

test('runner middleware is shared by custom Tools and receives a ToolContext', async () => {
  const registry = new ToolRegistry({ config: { fromHost: true } });
  const calls = [];
  registry.runner.use(async (execution, next) => {
    calls.push(`before:${execution.name}`);
    const result = await next(execution);
    calls.push(`after:${result.ok}`);
    return result;
  });
  registry.register({ name: 'middleware_tool', description: 'middleware', execute: async (_input, context) => ({ configured: context.config.fromHost }) });

  const result = await registry.run('middleware_tool', {});
  assert.deepEqual(calls, ['before:middleware_tool', 'after:true']);
  assert.deepEqual(result.data, { configured: true });
});

test('timeout and AbortSignal are enforced by ToolRunner', async () => {
  const registry = new ToolRegistry({ profile: 'admin' });
  let signal;
  registry.register({
    name: 'slow_tool',
    description: 'cooperative slow tool',
    execute: async (_input, context) => {
      signal = context.signal;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 1000);
        context.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('stopped'));
        }, { once: true });
      });
      return 'finished';
    },
  });

  const timeout = await registry.run('slow_tool', {}, { timeout: 10 });
  assert.equal(timeout.ok, false);
  assert.equal(timeout.error.code, ToolErrorCode.TIMEOUT);
  assert.equal(signal.aborted, true);

  const controller = new AbortController();
  const pending = registry.run('slow_tool', {}, { timeout: 1000, signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  const aborted = await pending;
  assert.equal(aborted.ok, false);
  assert.equal(aborted.error.code, ToolErrorCode.ABORTED);
});

test('static built-in plugins are ordinary plugin objects', () => {
  const plugin = createWebPlugin({ includeFetchUrl: false });
  assert.equal(plugin.name, 'web');
  assert.deepEqual(plugin.tools.map((tool) => tool.name), ['web_search']);
  assert.equal(typeof plugin.tools[0].handler, 'function');
});

test('AgentLoop routes a custom execute Tool through the same runner pipeline', async () => {
  const registry = new ToolRegistry({ profile: 'admin' });
  registry.register(helloTool());
  let step = 0;
  const loop = new AgentLoop({
    context: new ContextWindow({ maxTokens: 2000 }),
    tools: registry,
    reasoner: async (_context, definitions) => {
      step += 1;
      if (step === 1) {
        assert.equal(definitions[0].inputSchema.type, 'object');
        return { type: 'tool_call', tool: 'hello', args: { name: 'Loop' } };
      }
      return { type: 'final', content: 'done' };
    },
    maxSteps: 3,
  });
  const result = await loop.run('say hello');
  assert.equal(result.status, 'final');
  assert.equal(result.stepMemory.find((record) => record.phase === 'observe').result.data, 'Hello Loop');
});
