/**
 * repl.test.js — multi-turn REPL behaviors
 * ----------------------------------------
 * Drives runRepl() with in-memory input/output streams: normal turns,
 * slash commands (/help, /history, /system, /reset, /scratchpad), the
 * /approve + /deny human-in-the-loop flow, and streamed final answers
 * (no duplicate print when tokens already streamed).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { runRepl } from '../src/repl.js';
import { AgentLoop } from '../src/loop.js';
import { ToolRegistry } from '../src/tools.js';
import { ContextWindow } from '../src/context.js';
import { createScriptedClient, createReasoner } from '../src/reasoner.js';

/** Collect writes into an array while behaving like a Writable. */
function memoryOutput() {
  const chunks = [];
  const output = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(String(chunk));
      cb();
    },
  });
  return { output, text: () => chunks.join('') };
}

function makeAgent({ script, toolOpts = {}, loopOpts = {} } = {}) {
  const tools = new ToolRegistry();
  tools.register({
    name: 'add',
    description: 'add two numbers',
    parameters: { a: { type: 'number', required: true }, b: { type: 'number', required: true } },
    handler: async ({ a, b }) => a + b,
    ...toolOpts,
  });
  const scripted = createScriptedClient(script);
  const reasoner = async (rendered, schema) => scripted.chat({ systemPrompt: null, messages: rendered, tools: schema });
  return new AgentLoop({ context: new ContextWindow(), tools, reasoner, ...loopOpts });
}

function feedLines(agent, lines, { onToken } = {}) {
  const input = Readable.from([...lines.map((l) => `${l}\n`), '']);
  const { output, text } = memoryOutput();
  const done = runRepl({ agent, input, output, prompt: 'scrappyai> ', onToken });
  return { done, text };
}

test('REPL: runs turns, prints final answers, handles /help /history /system /reset /exit', async () => {
  const agent = makeAgent({
    script: [
      { type: 'final', content: 'ok, noted.' },
      { type: 'final', content: 'your name is yysafari86.' },
    ],
  });
  const { done, text } = feedLines(agent, [
    'my name is yysafari86',
    '/history',
    '/system',
    '/reset',
    'what is my name?',
    '/help',
    '/exit',
  ]);

  await done;
  const out = text();
  assert.match(out, /ok, noted\./);
  assert.match(out, /your name is yysafari86\./);
  assert.match(out, /"role": "user"/, '/history dumps the rendered context');
  assert.match(out, /\(no system prompt set\)/, '/system on a raw loop reports no prompt');
  assert.match(out, /Commands:/, '/help lists commands');
  assert.match(out, /conversation memory cleared\./, '/reset works');
  assert.match(out, /bye\./, '/exit leaves');
});

test('REPL: tool-use turns work and the scratchpad shows the step trail', async () => {
  const agent = makeAgent({
    script: [
      { type: 'tool_call', tool: 'add', args: { a: 2, b: 3 }, reasoning: 'let me add' },
      { type: 'final', content: 'five' },
    ],
  });
  const { done, text } = feedLines(agent, ['2+3?', '/scratchpad', '/exit']);
  await done;
  const out = text();
  assert.match(out, /five/);
  assert.match(out, /Agent Scratchpad/);
  assert.match(out, /add\(\{"a":2,"b":3\}\)/);
});

test('REPL: /approve runs a gated tool; /deny rejects it and continues', async () => {
  let handlerCalls = 0;
  const agent = makeAgent({
    toolOpts: {
      requiresApproval: true,
      handler: async ({ a, b }) => {
        handlerCalls += 1;
        return a + b;
      },
    },
    script: [
      { type: 'tool_call', tool: 'add', args: { a: 1, b: 2 } },
      { type: 'final', content: 'approved and done' },
    ],
  });

  const { done, text } = feedLines(agent, ['compute', '/approve', '/exit']);
  await done;
  const out = text();
  assert.match(out, /\[awaiting approval\] tool "add"/);
  assert.equal(handlerCalls, 1, 'handler ran after /approve');
  assert.match(out, /approved and done/);

  // --- deny path ---
  handlerCalls = 0;
  const agent2 = makeAgent({
    toolOpts: {
      requiresApproval: true,
      handler: async () => {
        handlerCalls += 1;
        return 0;
      },
    },
    script: [
      { type: 'tool_call', tool: 'add', args: { a: 1, b: 2 } },
      { type: 'final', content: 'pivoted' },
    ],
  });
  const denied = feedLines(agent2, ['compute', '/deny not needed now', '/exit']);
  await denied.done;
  const deniedOut = denied.text();
  assert.equal(handlerCalls, 0, 'handler never ran after /deny');
  assert.match(deniedOut, /pivoted/);

  // /approve with nothing pending is a no-op
  const idle = feedLines(agent2, ['/approve', '/exit']);
  await idle.done;
  assert.match(idle.text(), /nothing is currently awaiting tool approval\./);
});

test('REPL: streamed final answers are not printed twice', async () => {
  const streamedChunks = [];
  // The token sink is the printer — like index.js wiring, it writes each
  // chunk to the output as it arrives.
  const { output, text } = memoryOutput();
  const tokenSink = (t) => {
    streamedChunks.push(t);
    output.write(t);
  };
  // A real streaming reasoner (createReasoner + a chatStream client that
  // emits one content delta), so reasoner.setTokenSink exists and runRepl
  // can attach its tracking wrapper.
  const client = {
    async chatStream({ onDelta }) {
      onDelta({ type: 'content', text: 'streamed answer' });
      return { type: 'final', content: 'streamed answer' };
    },
  };
  const reasoner = createReasoner({ client, stream: true });
  const tools = new ToolRegistry();
  tools.register({ name: 'noop', description: 'x', handler: async () => 'ok' });
  const agent = new AgentLoop({ context: new ContextWindow(), tools, reasoner });

  const input = Readable.from(['hello\n', '/exit\n', '']);
  await runRepl({ agent, input, output, prompt: 'scrappyai> ', onToken: tokenSink });

  const out = text();
  assert.deepEqual(streamedChunks, ['streamed answer'], 'token sink received the content');
  const finalCount = (out.match(/streamed answer/g) || []).length;
  assert.equal(finalCount, 1, 'content appears exactly once (streamed, not re-printed)');
  assert.match(out, /streamed answer\n/, 'a single newline closes the streamed line');
});
