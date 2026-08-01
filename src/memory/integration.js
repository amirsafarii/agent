/**
 * memory/integration.js — wires the Pulse memory system into a built AgentLoop
 * -----------------------------------------------
 * Kept out of core/loop on purpose: the loop's think -> act -> observe cycle
 * is provider/storage-agnostic by design (see its own header comment) and
 * already fully unit-tested against that contract. This file wraps an
 * already-built agent's `.run()` so every turn:
 *
 *   1. (before "think") pulls this user's confirmed long-term facts plus
 *      the top-k semantically relevant memories/episodes for this input
 *      and injects them as one system message into ContextWindow — so the
 *      reasoner sees them without loop.js knowing memory exists at all.
 *   2. (after the turn resolves) records the user+assistant turn into
 *      session memory, and fires the trigger-gated fact extractor (it only
 *      spends a model call when a local regex thinks the message plausibly
 *      discloses a durable fact — see memory/memory-extractor.js), so
 *      "my name is X" / "یادت باشه ..." survive across sessions with no
 *      extra plumbing from the caller.
 *
 * Best-effort throughout: any memory failure is swallowed (never re-thrown)
 * so a Redis/network hiccup degrades a turn's context, it never breaks it.
 */

import { createLogger } from '../core/logger.js';

const log = createLogger('memory-integration');

export function wireMemory(agent, { memoryManager, extractor, userId = 'local', sessionId, projectId = null, onEvent } = {}) {
  if (!agent || typeof agent.run !== 'function') {
    throw new TypeError('wireMemory requires an agent with a .run(input) method.');
  }
  if (!memoryManager) return agent; // memory disabled — agent behaves exactly as it did before

  const resolvedSessionId = sessionId || `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const originalRun = agent.run.bind(agent);
  const originalResume = typeof agent.resume === 'function' ? agent.resume.bind(agent) : null;
  const originalResumeWithApproval = typeof agent.resumeWithApproval === 'function' ? agent.resumeWithApproval.bind(agent) : null;

  // Emit memory observability through the agent's CURRENT onEvent — which may
  // have been wrapped after buildAgent (e.g. by attachSessionLogger) — so
  // memory_inject/memory_learned/memory_error land in the same session log as
  // every loop event instead of bypassing it.
  const emitEvent = (event, payload) => emit(agent.onEvent || onEvent, event, payload);

  agent.run = async (userInput, runOpts) => {
    await injectRelevantMemory({ agent, memoryManager, userId, sessionId: resolvedSessionId, projectId, query: userInput, onEvent: emitEvent });

    const outcome = await originalRun(userInput, runOpts);

    await recordTurn({ memoryManager, extractor, userId, sessionId: resolvedSessionId, projectId, userInput, outcome, onEvent: emitEvent });

    return outcome;
  };

  // Paused/approval runs go through resume()/resumeWithApproval(), not run().
  // Wrap those too so an approved continuation still gets memory injection
  // before and turn recording after — otherwise a /approve in the REPL would
  // silently skip memory for the rest of the run.
  if (originalResume) {
    agent.resume = async (checkpointObj, runOpts = {}) => {
      const query = runOpts.additionalInput || null;
      if (query) {
        await injectRelevantMemory({ agent, memoryManager, userId, sessionId: resolvedSessionId, projectId, query, onEvent: emitEvent });
      }
      const outcome = await originalResume(checkpointObj, runOpts);
      if (query) {
        await recordTurn({ memoryManager, extractor, userId, sessionId: resolvedSessionId, projectId, userInput: query, outcome, onEvent: emitEvent });
      }
      return outcome;
    };
  }
  if (originalResumeWithApproval) {
    agent.resumeWithApproval = async (checkpointObj, approved, runOpts = {}) => {
      const query = runOpts.additionalInput || null;
      if (query) {
        await injectRelevantMemory({ agent, memoryManager, userId, sessionId: resolvedSessionId, projectId, query, onEvent: emitEvent });
      }
      const outcome = await originalResumeWithApproval(checkpointObj, approved, runOpts);
      if (query) {
        await recordTurn({ memoryManager, extractor, userId, sessionId: resolvedSessionId, projectId, userInput: query, outcome, onEvent: emitEvent });
      }
      return outcome;
    };
  }

  agent.memory = { memoryManager, extractor, userId, sessionId: resolvedSessionId, projectId };
  return agent;
}

async function injectRelevantMemory({ agent, memoryManager, userId, sessionId, projectId, query, onEvent }) {
  try {
    const [confirmedFacts, related] = await Promise.all([
      memoryManager.longTerm.getConfirmed({ userId, limit: 20 }),
      memoryManager.retrieveRelevant({ userId, projectId, query, k: 5 }),
    ]);

    const lines = [];
    if (confirmedFacts.length) {
      lines.push('Known, user-confirmed facts:');
      for (const f of confirmedFacts) lines.push(`- ${f.value}`);
    }
    if (related.semantic?.length) {
      lines.push('Relevant memories for this message:');
      for (const m of related.semantic) lines.push(`- ${m.text}`);
    }
    if (related.episodes?.length) {
      lines.push('Similar past episodes:');
      for (const e of related.episodes) {
        lines.push(`- goal: ${e.goal} -> ${e.outcome}${e.summary ? ` (${e.summary})` : ''}`);
      }
    }
    if (lines.length) {
      await agent.context.append({ role: 'system', content: `[memory]\n${lines.join('\n')}` });
    }
    const injected = { sessionId, userId, query, facts: confirmedFacts.length, semantic: related.semantic?.length || 0, episodes: related.episodes?.length || 0 };
    log.info('inject:done', injected);
    emit(onEvent, 'memory_inject', injected);
  } catch (err) {
    log.warn('inject:failed', { sessionId, userId, error: err.message });
    emit(onEvent, 'memory_error', { phase: 'inject', error: err.message });
  }
}

async function recordTurn({ memoryManager, extractor, userId, sessionId, projectId, userInput, outcome, onEvent }) {
  try {
    const turnId = await memoryManager.recordTurn({ sessionId, userId, role: 'user', content: userInput });
    if (outcome.status === 'final') {
      await memoryManager.recordTurn({ sessionId, userId, role: 'assistant', content: outcome.content });
    }

    if (extractor) {
      const result = await extractor.extractFromTurn({ userId, sessionId, projectId, turnId, userMessage: userInput });
      if (result.factsPromoted) {
        log.info('record:facts_promoted', { sessionId, userId, count: result.factsPromoted });
        emit(onEvent, 'memory_learned', { sessionId, count: result.factsPromoted });
      }
    }
    log.debug('record:done', { sessionId, userId, turnId, outcomeStatus: outcome.status });
  } catch (err) {
    log.warn('record:failed', { sessionId, userId, error: err.message });
    emit(onEvent, 'memory_error', { phase: 'record', error: err.message });
  }
}

function emit(onEvent, event, payload) {
  if (typeof onEvent !== 'function') return;
  try {
    onEvent(event, payload);
  } catch (_err) {
    // observability must never break memory, and memory must never break the loop
  }
}

export default wireMemory;
