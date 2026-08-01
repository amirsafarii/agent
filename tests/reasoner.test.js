/**
 * reasoner.test.js — createReasoner() + createScriptedClient()
 * ------------------------------------------------------------
 * Normalization of RawResponse into Actions, native history maintenance
 * (tool_call_id correlation), addUser/addToolResult hooks, retry on
 * transient client failures, reset/getHistory, and scripted-client errors.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReasoner, createScriptedClient, ReasonerError } from '../src/core/reasoner.js';

test('normalizes a tool_call response and assigns a stable id', async () => {
  const client = {
    chat: async ({ messages, tools }) => {
      assert.ok(Array.isArray(messages), 'history is an array');
      assert.equal(tools.length, 0);
      return { type: 'tool_call', tool: 'search', args: { q: 'x' }, id: 'call_abc', reasoning: 'thinking...' };
    },
  };
  const reasoner = createReasoner({ client, systemPrompt: 'sys' });
  const action = await reasoner([{ role: 'user', content: 'hi' }], []);

  assert.equal(action.type, 'tool_call');
  assert.equal(action.tool, 'search');
  assert.deepEqual(action.args, { q: 'x' });
  assert.equal(action._toolCallId, 'call_abc');
  assert.equal(action.reasoning, 'thinking...');

  // Native history = seeded user turn + the assistant turn with the tool call.
  const history = reasoner.getHistory();
  assert.equal(history.length, 2);
  assert.equal(history[0].role, 'user');
  assert.equal(history[1].role, 'assistant');
  assert.deepEqual(history[1].tool_calls[0], { id: 'call_abc', name: 'search', args: { q: 'x' } });
});

test('normalizes final and need_clarification responses', async () => {
  let mode = 'final';
  const client = {
    chat: async () =>
      mode === 'final'
        ? { type: 'final', content: 'the answer' }
        : { type: 'need_clarification', question: 'which one?' },
  };
  const reasoner = createReasoner({ client });

  const final = await reasoner([], []);
  assert.deepEqual(final, { type: 'final', content: 'the answer', reasoning: undefined });

  mode = 'clarify';
  const clarify = await reasoner([], []);
  assert.equal(clarify.type, 'need_clarification');
  assert.equal(clarify.question, 'which one?');

  const history = reasoner.getHistory();
  assert.deepEqual(history.map((h) => h.content), ['the answer', 'which one?']);
});

test('addUser/addToolResult mirror turns into the native history with tool_call_id', async () => {
  // Full realistic flow: turn 1 produces a tool_call (id call_42), the loop
  // then mirrors the tool result via addToolResult(), and turn 2's request
  // must show the provider the exact OpenAI-style trio:
  //   user -> assistant(tool_calls) -> tool(tool_call_id echo)
  const seen = [];
  const client = {
    chat: async ({ messages }) => {
      seen.push(messages.map((m) => ({ role: m.role, content: m.content, tool_call_id: m.tool_call_id, tool_calls: m.tool_calls })));
      return seen.length === 1
        ? { type: 'tool_call', tool: 'add', args: { a: 1, b: 2 }, id: 'call_42' }
        : { type: 'final', content: 'ok' };
    },
  };
  const reasoner = createReasoner({ client });

  reasoner.addUser('compute'); // loop before the first think
  const action1 = await reasoner([], []);
  assert.equal(action1._toolCallId, 'call_42');
  reasoner.addToolResult('call_42', { ok: true, data: 3 }); // loop after observe

  const action2 = await reasoner([], []);
  assert.equal(action2.type, 'final');

  const secondRequest = seen[1];
  assert.equal(secondRequest.length, 3);
  assert.deepEqual(secondRequest.map((m) => m.role), ['user', 'assistant', 'tool']);
  assert.equal(secondRequest[1].tool_calls[0].id, 'call_42');
  assert.equal(secondRequest[2].tool_call_id, 'call_42');
  assert.match(secondRequest[2].content, /"data":3/);
});

test('retries transient client failures, then succeeds', async () => {
  let calls = 0;
  const client = {
    chat: async () => {
      calls += 1;
      if (calls < 3) throw new Error(`boom ${calls}`);
      return { type: 'final', content: 'recovered' };
    },
  };
  const retries = [];
  const reasoner = createReasoner({
    client,
    maxRetries: 2,
    onEvent: (event, payload) => {
      if (event === 'retry') retries.push(payload);
    },
  });

  const action = await reasoner([], []);
  assert.equal(action.content, 'recovered');
  assert.equal(calls, 3);
  assert.equal(retries.length, 2);
});

test('gives up with a CLIENT_ERROR after exhausting retries', async () => {
  const client = {
    chat: async () => {
      throw new Error('always down');
    },
  };
  const reasoner = createReasoner({ client, maxRetries: 1 });
  await assert.rejects(() => reasoner([], []), (err) => {
    assert.ok(err instanceof ReasonerError);
    assert.equal(err.code, 'CLIENT_ERROR');
    assert.match(err.message, /always down/);
    return true;
  });
});

test('throws on an unknown response type', async () => {
  const client = { chat: async () => ({ type: 'banana' }) };
  const reasoner = createReasoner({ client });
  await assert.rejects(() => reasoner([], []), ReasonerError);
});

test('throws on a non-object response', async () => {
  const client = { chat: async () => 'hello' };
  const reasoner = createReasoner({ client });
  await assert.rejects(() => reasoner([], []), ReasonerError);
});

test('createReasoner requires a client with a chat method', () => {
  assert.throws(() => createReasoner({}), ReasonerError);
  assert.throws(() => createReasoner({ client: {} }), ReasonerError);
});

test('reset() clears history and mints a fresh call id', async () => {
  const client = {
    chat: async () => ({ type: 'tool_call', tool: 'search', args: {} }), // no id -> auto-generated
  };
  const reasoner = createReasoner({ client });
  await reasoner([], []);
  assert.equal(reasoner.getHistory().length, 1);
  const firstId = reasoner.getHistory()[0].tool_calls[0].id;

  reasoner.reset();
  assert.equal(reasoner.getHistory().length, 0);
  // A new conversation turn, a fresh id — even if minted within the same
  // millisecond as the first one (timestamp + counter both restart).
  await new Promise((r) => setTimeout(r, 5));
  await reasoner([], []);
  const secondId = reasoner.getHistory()[0].tool_calls[0].id;
  assert.notEqual(firstId, secondId, 'a new id is minted after reset');
});

test('seeds native history from rendered context on first call when empty', async () => {
  const seen = [];
  const client = {
    chat: async ({ messages }) => {
      seen.push(messages.map((m) => ({ role: m.role, content: m.content })));
      return { type: 'final', content: 'ok' };
    },
  };
  const reasoner = createReasoner({ client });
  await reasoner(
    [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
      { role: 'tool_result', content: 'tr' },
    ],
    []
  );
  // User/assistant roles are seeded; dynamic system messages are synced into
  // native history too (turn-memory fix) — tool_result stays out (the loop
  // mirrors those via addToolResult with the proper tool_call_id).
  assert.deepEqual(seen[0], [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'u1' },
    { role: 'assistant', content: 'a1' },
  ]);
});

test('turn memory: dynamic [memory] system messages are synced to the model and refreshed', async () => {
  const seen = [];
  const client = {
    chat: async ({ messages }) => {
      seen.push(messages.map((m) => ({ role: m.role, content: m.content })));
      return { type: 'final', content: 'ok' };
    },
  };
  const reasoner = createReasoner({ client });

  // Turn 1: wireMemory injected a [memory] block into the rendered context.
  await reasoner(
    [
      { role: 'system', content: '[memory]\n- The user\'s name is Amir.' },
      { role: 'user', content: 'hi' },
    ],
    []
  );
  assert.equal(seen[0].filter((m) => m.role === 'system' && m.content.includes('[memory]')).length, 1, 'memory block reaches the provider');

  // Turn 2: the memory block changed (a new fact was added) — the OLD block
  // must be replaced, not stacked.
  await reasoner(
    [
      { role: 'system', content: '[memory]\n- The user\'s name is Amir.\n- The user prefers Python.' },
      { role: 'user', content: 'what do you know?' },
    ],
    []
  );
  const memoryInSecond = seen[1].filter((m) => m.role === 'system' && m.content.includes('[memory]'));
  assert.equal(memoryInSecond.length, 1, 'old memory block replaced by the current one');
  assert.match(memoryInSecond[0].content, /prefers Python/);

  // Non-memory system messages (e.g. [loop guard]) are synced once, deduped.
  await reasoner(
    [
      { role: 'system', content: '[loop guard] something happened' },
      { role: 'user', content: 'again' },
    ],
    []
  );
  assert.equal(seen[2].filter((m) => m.role === 'system' && m.content.includes('[loop guard]')).length, 1);
  await reasoner(
    [
      { role: 'system', content: '[loop guard] something happened' },
      { role: 'user', content: 'third' },
    ],
    []
  );
  const guardCount = seen[3].filter((m) => m.role === 'system' && m.content.includes('[loop guard]')).length;
  assert.equal(guardCount, 1, 'identical guard message is not duplicated');
});

test('turn memory: the persistent systemPrompt is never duplicated by the sync — even when it mentions "[memory]"', async () => {
  const seen = [];
  const client = {
    chat: async ({ messages }) => {
      seen.push(messages);
      return { type: 'final', content: 'ok' };
    },
  };
  // The real built-in prompt mentions "[memory]" in its rules — a naive
  // includes() match would treat the prompt itself as the memory block.
  const systemPrompt =
    'You are ScrappyAi. A "[memory]" system message, when present, lists facts you already know. Be terse.';
  const reasoner = createReasoner({ client, systemPrompt });

  await reasoner(
    [
      { role: 'system', content: systemPrompt }, // rendered context includes the prompt
      { role: 'system', content: '[memory]\n- The user\'s name is Amir.' },
      { role: 'user', content: 'hi' },
    ],
    []
  );

  const req = seen[0];
  const promptCopies = req.filter((m) => m.role === 'system' && m.content === systemPrompt);
  assert.equal(promptCopies.length, 0, 'history has no prompt copy — the client sends it separately');
  const memoryBlocks = req.filter((m) => m.role === 'system' && m.content.startsWith('[memory]'));
  assert.equal(memoryBlocks.length, 1, 'the real [memory] block is synced');
  assert.match(memoryBlocks[0].content, /name is Amir/);
});

test('createScriptedClient plays responses in order and cycles at the end', async () => {
  const client = createScriptedClient([
    { type: 'tool_call', tool: 'a', args: {} },
    { type: 'final', content: 'done' },
  ]);
  assert.equal((await client.chat()).type, 'tool_call');
  assert.equal((await client.chat()).type, 'final');
  assert.equal((await client.chat()).type, 'final', 'cycles to last response');
});

test('createScriptedClient with an empty script throws EMPTY_SCRIPT', async () => {
  const client = createScriptedClient([]);
  await assert.rejects(() => client.chat(), (err) => {
    assert.equal(err.code, 'EMPTY_SCRIPT');
    return true;
  });
});

test('setTokenSink attaches/detaches the streamed token consumer', async () => {
  const client = {
    chatStream: async ({ onDelta }) => {
      onDelta({ type: 'content', text: 'Hel' });
      onDelta({ type: 'content', text: 'lo' });
      onDelta({ type: 'tool_call_args', text: '{"q":' }); // never forwarded to the sink
      return { type: 'final', content: 'Hello' };
    },
  };
  const reasoner = createReasoner({ client, stream: true });
  const tokens = [];
  reasoner.setTokenSink((t) => tokens.push(t));
  const action = await reasoner([], []);
  assert.equal(action.content, 'Hello');
  assert.deepEqual(tokens, ['Hel', 'lo'], 'content deltas only, tool_call_args excluded');

  reasoner.setTokenSink(null);
  tokens.length = 0;
  await reasoner([], []);
  assert.deepEqual(tokens, [], 'detached sink receives nothing');
});
