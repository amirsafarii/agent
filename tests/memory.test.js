/**
 * memory.test.js — seven-layer memory system + wireMemory integration
 * -------------------------------------------------------------------
 * Runs entirely in-process (no Redis, no network): createMemory() with
 * SCRAPPYAI_REDIS_URL unset selects the EphemeralFallback backend. Covers
 * long-term fact upsert + the confirmed-vs-inferred conflict rule, session
 * turns, semantic recall via the deterministic offline embedding, episodic
 * recall, tool stats, project facts, the trigger-gated extractor, and
 * wireMemory()'s inject/record best-effort behavior.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemory } from '../src/memory/index.js';
import { MemoryManager } from '../src/memory/memory-manager.js';
import { cosineSimilarity } from '../src/memory/embeddings.js';
import { wireMemory } from '../src/memory/integration.js';
import { AgentLoop } from '../src/core/loop/index.js';
import { ToolRegistry } from '../src/tools/index.js';
import { ContextWindow } from '../src/core/context.js';

// The shared 9router client adapter (see memory/index.js) — a fake one with
// the same shape; only used by the fact extractor's model call.
const fakeClient = {
  async chat({ systemPrompt, messages }) {
    const user = messages.map((m) => m.content).join(' ');
    if (/name is/i.test(user)) {
      return {
        type: 'final',
        content: JSON.stringify([
          { key: 'user_name', value: "The user's name is Amir.", tags: ['identity'], importance: 0.9, confidence: 1.0, source: 'explicit' },
        ]),
      };
    }
    return { type: 'final', content: '[]' };
  },
};

function freshMemory() {
  const memory = createMemory({ client: fakeClient });
  assert.ok(memory, 'memory is enabled by default');
  assert.equal(memory.backend, 'in-process', 'no REDIS_URL -> in-process backend');
  return memory;
}

test('long-term memory: upsertByKey dedupes by (userId, key) and versions', async () => {
  const { memoryManager } = freshMemory();
  const id1 = await memoryManager.longTerm.upsertByKey({
    userId: 'u1', key: 'user_name', value: "The user's name is Amir.", source: 'explicit', confidence: 1,
  });
  const id2 = await memoryManager.longTerm.upsertByKey({
    userId: 'u1', key: 'user_name', value: "The user's name is Amir S.", source: 'explicit', confidence: 1,
  });
  assert.equal(id1, id2, 'same key+user upserts, never duplicates');

  const fact = await memoryManager.longTerm.get(id1);
  assert.equal(fact.value, "The user's name is Amir S.");
  assert.equal(fact.confirmedByUser, true);
  assert.equal(fact.versions.length, 2, 'history of values kept');

  const confirmed = await memoryManager.longTerm.getConfirmed({ userId: 'u1', limit: 10 });
  assert.equal(confirmed.length, 1);
  assert.equal(confirmed[0].key, 'user_name');
});

test('long-term memory: a weaker inference never clobbers a confirmed fact — it parks as pending', async () => {
  const { memoryManager } = freshMemory();
  const id = await memoryManager.longTerm.upsertByKey({
    userId: 'u1', key: 'user_role', value: 'The user is a backend engineer.', source: 'explicit', confidence: 1,
  });
  // A low-confidence model guess arrives later for the same key.
  await memoryManager.longTerm.upsertByKey({
    userId: 'u1', key: 'user_role', value: 'The user is a designer.', source: 'inferred', confidence: 0.4,
  });
  const fact = await memoryManager.longTerm.get(id);
  assert.equal(fact.value, 'The user is a backend engineer.', 'confirmed value untouched');
  assert.equal(fact.requiresConfirmation, true);
  assert.equal(fact.pendingValue, 'The user is a designer.');

  const confirmed = await memoryManager.longTerm.confirmPending(id);
  assert.equal(confirmed.value, 'The user is a designer.', 'explicit confirm promotes the pending value');
  assert.equal(confirmed.requiresConfirmation, false);
});

test('session memory: turns are recorded and recalled oldest -> newest', async () => {
  const { memoryManager } = freshMemory();
  await memoryManager.recordTurn({ sessionId: 's1', userId: 'u1', role: 'user', content: 'first' });
  await memoryManager.recordTurn({ sessionId: 's1', userId: 'u1', role: 'assistant', content: 'second' });

  const turns = await memoryManager.session.getHistory('s1');
  assert.deepEqual(turns.map((t) => t.content), ['first', 'second']);

  const history = await memoryManager.getConversationHistory('s1');
  assert.deepEqual(history.map((h) => h.role), ['user', 'assistant']);
});

test('semantic memory: offline embedding retrieves the closest fact', async () => {
  const { memoryManager } = freshMemory();
  await memoryManager.semantic.remember({ userId: 'u1', text: 'The user prefers TypeScript over JavaScript.' });
  await memoryManager.semantic.remember({ userId: 'u1', text: 'The user lives in Tehran.' });
  await memoryManager.semantic.rebuildIndex();

  // The deterministic offline embedding is a token-hash bag of words, so an
  // exact-token query cleanly beats an unrelated fact.
  const hits = await memoryManager.semantic.retrieve('TypeScript', { userId: 'u1', k: 1 });
  assert.equal(hits.length, 1);
  assert.match(hits[0].text, /TypeScript/);

  const tehran = await memoryManager.semantic.retrieve('Tehran', { userId: 'u1', k: 1 });
  assert.match(tehran[0].text, /Tehran/);
});

test('semantic memory: minScore filters weak matches; cross-user scoping holds', async () => {
  const { memoryManager } = freshMemory();
  await memoryManager.semantic.remember({ userId: 'alice', text: 'Alice likes hiking.' });
  await memoryManager.semantic.rebuildIndex();

  const forBob = await memoryManager.semantic.retrieve('hiking', { userId: 'bob', k: 5 });
  assert.equal(forBob.length, 0, "bob doesn't see alice's memories");

  const forAlice = await memoryManager.semantic.retrieve('hiking', { userId: 'alice', k: 5 });
  assert.equal(forAlice.length, 1);
});

test('cosineSimilarity: identical vectors score 1, orthogonal score 0', () => {
  assert.equal(cosineSimilarity([1, 0, 0], [1, 0, 0]), 1);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  assert.equal(cosineSimilarity([1, 2, 3], [1, 2, 3]), 1);
  assert.equal(cosineSimilarity([1, 0], [1]), 0, 'mismatched lengths -> 0');
});

test('episodic + tool + project layers record and recall', async () => {
  const { memoryManager } = freshMemory();
  await memoryManager.episodic.recordEpisode({
    userId: 'u1', goal: 'deploy the api', outcome: 'success', summary: 'needed env vars first',
    whatWorked: ['read the docs'], toolsUsed: ['shell'],
  });
  const episodes = await memoryManager.episodic.recall({ userId: 'u1', limit: 5 });
  assert.equal(episodes.length, 1);
  assert.equal(episodes[0].goal, 'deploy the api');

  await memoryManager.tool.recordExecution({ toolName: 'shell', success: true, durationMs: 5 });
  await memoryManager.tool.recordExecution({ toolName: 'shell', success: false, durationMs: 9, error: 'timeout' });
  const stats = await memoryManager.tool.getStats('shell');
  assert.equal(stats.samples, 2);
  assert.equal(stats.successRate, 0.5);
  assert.equal(stats.avgDurationMs, 7);
  assert.equal(stats.lastError, 'timeout');

  await memoryManager.project.setFact('p1', 'stack', 'node');
  const summary = await memoryManager.project.getSummary('p1');
  assert.equal(summary.stack, 'node', 'flat summary maps key -> value');

  const overall = memoryManager.stats();
  assert.deepEqual(overall.layers, ['session', 'workspace', 'episodic', 'semantic', 'longTerm', 'tool', 'project']);
});

test('fact extractor: chit-chat never costs a model call; disclosures are promoted', async () => {
  const { memoryManager, extractor } = freshMemory();

  const chit = await extractor.extractFromTurn({ userId: 'u1', sessionId: 's1', userMessage: 'thanks, ok' });
  assert.equal(chit.checked, false, 'trigger-gated: not even checked');
  assert.equal(chit.factsPromoted, 0);

  const disclosure = await extractor.extractFromTurn({
    userId: 'u1', sessionId: 's1', userMessage: 'by the way my name is Amir',
  });
  assert.equal(disclosure.checked, true);
  assert.equal(disclosure.factsPromoted, 1);
  const facts = await memoryManager.longTerm.getConfirmed({ userId: 'u1', limit: 10 });
  assert.equal(facts[0].key, 'user_name');
  assert.equal(facts[0].value, "The user's name is Amir.");
});

test('memory extractor: low-confidence guesses are never promoted', async () => {
  const lowConfClient = {
    async chat() {
      return {
        type: 'final',
        content: JSON.stringify([
          { key: 'user_pet', value: 'The user might have a cat.', tags: [], importance: 0.3, confidence: 0.2, source: 'assumed' },
        ]),
      };
    },
  };
  const memory = createMemory({ client: lowConfClient });
  const result = await memory.extractor.extractFromTurn({ userId: 'u1', sessionId: 's1', userMessage: 'if my name were X' });
  assert.equal(result.factsPromoted, 0, 'below MIN_PROMOTION_CONFIDENCE -> dropped');
  const facts = await memory.memoryManager.longTerm.getConfirmed({ userId: 'u1', limit: 10 });
  assert.equal(facts.length, 0);
});

test('wireMemory: relevant facts are injected before the turn and turns are recorded after', async () => {
  const memory = freshMemory();
  const { memoryManager, extractor } = memory;

  // Pre-seed a confirmed fact.
  await memoryManager.longTerm.upsertByKey({
    userId: 'u1', key: 'user_name', value: "The user's name is Amir.", source: 'explicit', confidence: 1,
  });

  const tools = new ToolRegistry();
  tools.register({ name: 'noop', description: 'x', handler: async () => 'ok' });
  const context = new ContextWindow({ maxTokens: 8000 });
  const loop = new AgentLoop({ context, tools, reasoner: async () => ({ type: 'final', content: 'noted' }) });
  wireMemory(loop, { memoryManager, extractor, userId: 'u1', sessionId: 's1' });

  const result = await loop.run('my name is Amir, remember it');
  assert.equal(result.status, 'final');

  // The [memory] system message was injected before the turn.
  const memoryMsg = context.messages.find((m) => m.role === 'system' && m.content.includes('[memory]'));
  assert.ok(memoryMsg, 'injected [memory] context message exists');
  assert.match(memoryMsg.content, /user_name|name is Amir/);

  // The turn was recorded into session memory afterwards.
  const turns = await memoryManager.session.getHistory('s1');
  assert.deepEqual(turns.map((t) => t.content), ['my name is Amir, remember it', 'noted']);
});

test('wireMemory: a backend failure degrades the turn instead of breaking it', async () => {
  const tools = new ToolRegistry();
  tools.register({ name: 'noop', description: 'x', handler: async () => 'ok' });
  const loop = new AgentLoop({
    context: new ContextWindow(),
    tools,
    reasoner: async () => ({ type: 'final', content: 'still works' }),
  });

  // A memory manager whose every method explodes must not break agent.run().
  const broken = {
    longTerm: { getConfirmed: async () => { throw new Error('redis down'); } },
    retrieveRelevant: async () => { throw new Error('redis down'); },
    recordTurn: async () => { throw new Error('redis down'); },
  };
  wireMemory(loop, { memoryManager: broken, userId: 'u1', sessionId: 's1' });

  const result = await loop.run('hello');
  assert.equal(result.status, 'final');
  assert.equal(result.content, 'still works');
});

test('SCRAPPYAI_MEMORY_ENABLED=false disables memory entirely', async () => {
  process.env.SCRAPPYAI_MEMORY_ENABLED = 'false';
  try {
    assert.equal(createMemory({ client: fakeClient }), null);
  } finally {
    delete process.env.SCRAPPYAI_MEMORY_ENABLED;
  }
});

test('fact extractor falls back to local patterns when the model call fails or returns nothing', async () => {
  const brokenClient = {
    async chat() {
      throw new Error('model unreachable');
    },
  };
  const memory = createMemory({ client: brokenClient });
  const result = await memory.extractor.extractFromTurn({
    userId: 'u1', sessionId: 's1', userMessage: 'by the way, my name is Sara and I live in Tehran',
  });
  assert.equal(result.checked, true);
  assert.equal(result.factsPromoted, 2, 'name + city recovered without any model call');
  const facts = await memory.memoryManager.longTerm.getConfirmed({ userId: 'u1', limit: 10 });
  const byKey = Object.fromEntries(facts.map((f) => [f.key, f.value]));
  assert.match(byKey.user_name, /Sara/);
  assert.match(byKey.user_city, /Tehran/);
  assert.equal(facts.every((f) => f.source === 'explicit' && f.confidence === 1), true, 'local facts are explicit, confidence 1');
});

test('memory between turns: injected [memory] reaches the model via the reasoner (turn-memory fix)', async () => {
  const memory = freshMemory();
  const { memoryManager, extractor } = memory;
  await memoryManager.longTerm.upsertByKey({
    userId: 'u1', key: 'user_name', value: "The user's name is Amir.", source: 'explicit', confidence: 1,
  });

  // The REAL createReasoner — this is what the agent ships with. The bug
  // being fixed: wireMemory injected the [memory] system message into the
  // ContextWindow, but the reasoner's native history never carried it to
  // the provider, so "memory between turns" silently did nothing.
  const seen = [];
  const client = {
    async chat({ messages }) {
      seen.push(messages);
      return { type: 'final', content: 'got it' };
    },
  };
  const { createReasoner } = await import('../src/core/reasoner.js');
  const reasoner = createReasoner({ client, systemPrompt: 'sys' });
  const tools = new ToolRegistry();
  tools.register({ name: 'noop', description: 'x', handler: async () => 'ok' });
  const context = new ContextWindow({ maxTokens: 8000 });
  const loop = new AgentLoop({ context, tools, reasoner });
  wireMemory(loop, { memoryManager, extractor, userId: 'u1', sessionId: 's1' });

  await loop.run('what do you remember about me?');

  const lastRequest = seen[seen.length - 1];
  const memoryMsg = lastRequest.find((m) => m.role === 'system' && m.content.includes('[memory]'));
  assert.ok(memoryMsg, '[memory] block reached the provider request');
  assert.match(memoryMsg.content, /user_name|name is Amir/);
});
