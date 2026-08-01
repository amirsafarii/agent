/**
 * smoke.test.js — wiring everything together
 * ------------------------------------------
 * buildAgent() end-to-end (with a stubbed 9router fetch — no network),
 * loadSystemPrompt() precedence, the default tool registry, memory
 * backend selection, and single-turn execution through the real
 * 9router client + AgentLoop + ContextWindow stack.
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildAgent, loadSystemPrompt, createDefaultToolRegistry } from '../src/index.js';
import { AgentLoop } from '../src/loop.js';
import { ToolRegistry } from '../src/tools.js';
import { ContextWindow } from '../src/context.js';
import { createScriptedClient } from '../src/reasoner.js';

const originalFetch = global.fetch;

beforeEach(() => {
  // Minimum env for createNineRouterClient() to build.
  process.env.NINEROUTER_BASE_URL = 'https://nine.example/v1';
  process.env.NINEROUTER_API_KEY = 'sk-test';
  process.env.NINEROUTER_MODEL = 'gpt-4o-mini';
  delete process.env.SCRAPPYAI_MEMORY_ENABLED;
  delete process.env.SCRAPPYAI_SESSION_LOG;
  delete process.env.SCRAPPYAI_REDIS_URL;
  delete process.env.SCRAPPYAI_SYSTEM_PROMPT;
  delete process.env.SCRAPPYAI_SYSTEM_PROMPT_FILE;
});

test.after(() => {
  global.fetch = originalFetch;
});

test('buildAgent: wires the full stack with the 20 default tools and memory', () => {
  global.fetch = async () =>
    new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }), { status: 200 });

  const agent = buildAgent({ sessionId: 'smoke-1' });
  assert.ok(agent instanceof AgentLoop);
  assert.ok(agent.context instanceof ContextWindow);
  assert.ok(agent.tools instanceof ToolRegistry);
  const toolNames = agent.tools.list().map((t) => t.name).sort();
  assert.deepEqual(toolNames, [
    'code_run',
    'code_test',
    'code_validate',
    'copy_file',
    'delete_file',
    'edit_file',
    'list_dir',
    'make_dir',
    'move_file',
    'npm',
    'package_info',
    'package_install',
    'read_file',
    'search_files',
    'shell',
    'shell_kill',
    'shell_spawn',
    'shell_which',
    'web_search',
    'write_file',
  ]);
  assert.equal(agent.tools.get('delete_file').requiresApproval, true, 'delete_file is approval-gated');
  assert.equal(agent.tools.get('shell_kill').requiresApproval, true, 'shell_kill is approval-gated');
  assert.equal(agent.sessionId, 'smoke-1');
  assert.equal(agent.memoryBackend, 'in-process', 'memory on by default, in-process without Redis');
  assert.ok(agent.systemPrompt.includes('ScrappyAi'), 'built-in system prompt resolved');
  assert.match(agent.systemPrompt, /Fallback Rule/, 'fallback rule is in the system prompt');
  assert.ok(agent.reasoner.getHistory, 'reasoner exposes history');
  assert.ok(agent.checkpoints, 'checkpoint manager attached');
  assert.deepEqual(agent.adaptiveMaxSteps, { growthFactor: 2, max: 48 }, 'adaptive step budget on by default (12 base, 48 cap)');
  assert.equal(agent.maxToolCallsPerTool, 8, 'tool-overuse guard on by default');
});

test('buildAgent: runs one full turn end to end through the real 9router client', async () => {
  const calls = [];
  global.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    return new Response(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content: `echo: ${body.messages.at(-1).content}` } }],
      }),
      { status: 200 }
    );
  };

  const agent = buildAgent({ sessionId: 'smoke-turn', memory: false });
  const result = await agent.run('hello there');
  assert.equal(result.status, 'final');
  assert.equal(result.content, 'echo: hello there');
  assert.ok(calls.length >= 1, 'the client was called');
  assert.equal(calls[0].stream, false);
  assert.ok(calls[0].messages.some((m) => m.role === 'system'), 'system prompt sent');
});

test('buildAgent: multi-turn memory is just the same agent reused', async () => {
  let turns = 0;
  global.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    turns += 1;
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              role: 'assistant',
              content: turns === 1 ? 'what name?' : `your name is ${body.messages.at(-1).content}`,
            },
          },
        ],
      }),
      { status: 200 }
    );
  };

  const agent = buildAgent({ sessionId: 'smoke-multi', memory: false });
  const first = await agent.run('remember: my name is yysafari86');
  assert.equal(first.status, 'final');

  const second = await agent.run('yysafari86');
  assert.equal(second.content, 'your name is yysafari86');
  assert.equal(turns, 2);
});

test('loadSystemPrompt: override > file > inline env > built-in default', () => {
  // 1. explicit override wins over everything
  assert.equal(loadSystemPrompt('explicit'), 'explicit');

  // 2. file beats inline env
  process.env.SCRAPPYAI_SYSTEM_PROMPT = 'inline prompt';
  process.env.SCRAPPYAI_SYSTEM_PROMPT_FILE = new URL('./fixtures/prompt.txt', import.meta.url).pathname;
  try {
    assert.equal(loadSystemPrompt(), 'from the file');
  } finally {
    delete process.env.SCRAPPYAI_SYSTEM_PROMPT_FILE;
  }

  // 3. inline env beats the built-in default
  assert.equal(loadSystemPrompt(), 'inline prompt');
  delete process.env.SCRAPPYAI_SYSTEM_PROMPT;

  // 4. built-in default
  const def = loadSystemPrompt();
  assert.match(def, /ScrappyAi/);
});

test('loadSystemPrompt: an unreadable file throws a descriptive error', () => {
  process.env.SCRAPPYAI_SYSTEM_PROMPT_FILE = '/nonexistent/prompt.txt';
  try {
    assert.throws(() => loadSystemPrompt(), /could not be read/);
  } finally {
    delete process.env.SCRAPPYAI_SYSTEM_PROMPT_FILE;
  }
});

test('createDefaultToolRegistry: registers into an existing registry too', () => {
  const registry = new ToolRegistry();
  const out = createDefaultToolRegistry({ registry });
  assert.equal(out, registry);
  assert.equal(registry.list().length, 20);
  const names = registry.list().map((t) => t.name);
  for (const expected of ['edit_file', 'list_dir', 'search_files', 'make_dir', 'move_file', 'copy_file', 'delete_file',
    'shell_spawn', 'shell_kill', 'shell_which', 'code_run', 'code_test', 'code_validate',
    'npm', 'package_install', 'package_info', 'read_file', 'write_file', 'shell', 'web_search']) {
    assert.ok(names.includes(expected), `tool ${expected} registered`);
  }
});

test('minimal wiring: raw reasoner function + ToolRegistry + ContextWindow (README quickstart)', async () => {
  const tools = new ToolRegistry();
  tools.register({
    name: 'search',
    description: 'search the web',
    parameters: { query: { type: 'string', required: true } },
    handler: async ({ query }) => `results for ${query}`,
  });
  const context = new ContextWindow({ maxTokens: 8000 });
  const reasoner = createScriptedClient([
    { type: 'tool_call', tool: 'search', args: { query: 'nodejs' } },
    { type: 'final', content: 'done' },
  ]);
  const loop = new AgentLoop({
    context,
    tools,
    reasoner: async (rendered, schema) => {
      // exactly what a hand-written reasoner looks like
      return reasoner.chat({ systemPrompt: null, messages: rendered, tools: schema });
    },
  });
  const result = await loop.run('find me something');
  assert.equal(result.status, 'final');
  assert.equal(result.content, 'done');
  const observe = result.stepMemory.find((r) => r.phase === 'observe');
  assert.equal(observe.result.data, 'results for nodejs');
});

test('abort signal: runOpts.signal aborts between steps with aborted_by_signal', async () => {
  const controller = new AbortController();
  const tools = new ToolRegistry();
  tools.register({
    name: 'slow',
    description: 'takes a while',
    handler: () => new Promise((r) => setTimeout(r, 2000)),
  });
  const loop = new AgentLoop({
    context: new ContextWindow(),
    tools,
    reasoner: async () => ({ type: 'tool_call', tool: 'slow', args: {} }),
    toolRetry: { retries: 0 },
  });

  const runPromise = loop.run('go', { signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  const result = await runPromise;
  assert.equal(result.status, 'aborted');
  assert.equal(result.reason, 'aborted_by_signal');
});
