// ── Memory Manager ──
// Facade unifying all seven memory layers behind one object, so the rest
// of the runtime (context engine, agents, API routes) depends on a single
// `MemoryManager` rather than seven separate imports. Also owns
// cross-layer operations: conversation history assembly and promoting a
// session insight into long-term/semantic memory.

import { SessionMemory } from './layers/session-memory.js';
import { WorkspaceMemory } from './layers/workspace-memory.js';
import { EpisodicMemory } from './layers/episodic-memory.js';
import { SemanticMemory } from './layers/semantic-memory.js';
import { LongTermMemory } from './layers/long-term-memory.js';
import { ToolMemory } from './layers/tool-memory.js';
import { ProjectMemory } from './layers/project-memory.js';
import { EmbeddingService } from './embeddings.js';

export class MemoryManager {
  constructor({ redisConnection, providerRegistry, eventBus }) {
    const embeddings = new EmbeddingService({ providerRegistry });

    this.session = new SessionMemory({ redisConnection });
    this.workspace = new WorkspaceMemory({ redisConnection });
    this.episodic = new EpisodicMemory({ redisConnection });
    this.semantic = new SemanticMemory({ redisConnection, embeddings });
    this.longTerm = new LongTermMemory({ redisConnection });
    this.tool = new ToolMemory({ redisConnection });
    this.project = new ProjectMemory({ redisConnection });
    this.embeddings = embeddings;
    this.redisConnection = redisConnection;
    this.eventBus = eventBus;
  }

  isAvailable() {
    return !!this.redisConnection?.isReady();
  }

  /** Conversation continuity for the agent loop, as chat-completion-shaped messages. */
  async getConversationHistory(sessionId, limit = 40) {
    const turns = await this.session.getHistory(sessionId, limit);
    return turns.map(t => ({ role: t.role, content: t.content, tool_calls: t.toolCalls }));
  }

  async recordTurn({ sessionId, userId, role, content, toolCalls }) {
    const id = await this.session.appendTurn({ sessionId, userId, role, content, toolCalls });
    this.eventBus?.emit('memory.turn_recorded', { sessionId, role });
    return id;
  }

  /**
   * Promote a durable-sounding fact learned this session into long-term +
   * semantic memory. `confidence`/`source`/`turnId` flow into long-term
   * memory's conflict-aware upsert (see long-term-memory.js) so a
   * low-confidence or hypothetical extraction can never silently clobber
   * a fact the user explicitly confirmed earlier.
   */
  async promote({ userId, projectId, text, key, tags = [], importance = 0.7, confidence, source, turnId }) {
    // Keyed facts (e.g. "user_name") upsert in place — a real memory
    // updates what it knows about the same fact instead of accumulating
    // duplicate/stale records every time the user restates it.
    const ltId = key ? await this.longTerm.upsertByKey({ userId, key, value: text, tags, importance, confidence, source, turnId }) : null;
    const semId = await this.semantic.remember({ userId, projectId, text, tags, importance });
    this.eventBus?.emit('memory.promoted', { userId, projectId, key });
    return { longTermId: ltId, semanticId: semId };
  }


  /** Cross-layer retrieval used by the Context Engine to build RAG context. */
  async retrieveRelevant({ userId, projectId, query, k = 5 }) {
    const [semantic, episodes] = await Promise.all([
      this.semantic.retrieve(query, { userId, projectId, k }),
      this.episodic.mostSimilarOutcomes(query.split(/\s+/).slice(0, 8), { userId, limit: 3 }),
    ]);
    return { semantic, episodes };
  }

  stats() {
    return {
      available: this.isAvailable(),
      layers: ['session', 'workspace', 'episodic', 'semantic', 'longTerm', 'tool', 'project'],
    };
  }

  /**
   * Forgetting mechanism: memory should not hoard everything forever.
   * - Low-importance semantic facts (the closest proxy this layer has to
   *   "confidence" — a fact promoted with importance < 0.3 was never
   *   asserted as very durable to begin with) are dropped.
   * - Episodic entries older than 30 days that were never once recalled
   *   are pruned — they clearly weren't useful precedent.
   * - Long-term facts still `requiresConfirmation` (a real conflict
   *   between what the user confirmed and a later weaker/conflicting
   *   extraction) are reported, not deleted — a human decision, not an
   *   automatic one.
   * Runs best-effort per layer so one layer's failure doesn't block the
   * others; returns a report of what happened.
   */
  async runMaintenance({ userId, minSemanticImportance = 0.3, staleEpisodeDays = 30 } = {}) {
    const report = { deletedSemanticFacts: 0, deletedStaleEpisodes: 0, conflicts: [], errors: [] };

    try {
      const lowImportance = await this.semantic.store.search({ type: 'fact', userId, minImportance: undefined, limit: Number.MAX_SAFE_INTEGER });
      const toDelete = lowImportance.filter(f => (f.importance ?? 0) < minSemanticImportance);
      for (const f of toDelete) { await this.semantic.forget(f.id); report.deletedSemanticFacts++; }
    } catch (err) { report.errors.push(`semantic: ${err.message}`); }

    try {
      const stale = await this.episodic.findStaleUnused({ olderThanDays: staleEpisodeDays });
      for (const e of stale) { await this.episodic.store.delete(e.id); report.deletedStaleEpisodes++; }
    } catch (err) { report.errors.push(`episodic: ${err.message}`); }

    try {
      report.conflicts = await this.longTerm.listPendingConfirmations({ userId });
      if (report.conflicts.length) this.eventBus?.emit('memory.conflicts_detected', { userId, count: report.conflicts.length, conflicts: report.conflicts });
    } catch (err) { report.errors.push(`longTerm: ${err.message}`); }

    this.eventBus?.emit('memory.maintenance_completed', report);
    return report;
  }

  /**
   * Cross-layer snapshot for `GET /v1/memory/health` — surfaces exactly
   * the kind of silent decay this layer is otherwise opaque about:
   * corrupted/stale/conflicting facts, index freshness, per-layer counts.
   */
  async health({ userId } = {}) {
    const [sessions, longTermItems, pendingConfirmations, semanticItems] = await Promise.all([
      this.session.listSessions({ limit: 500 }),
      this.longTerm.list({ userId, limit: 1000 }),
      this.longTerm.listPendingConfirmations({ userId, limit: 1000 }),
      this.semantic.store.search({ type: 'fact', limit: Number.MAX_SAFE_INTEGER }),
    ]);

    const staleCutoff = Date.now() - 180 * 86400000; // 6 months
    const staleFacts = longTermItems.filter(f => new Date(f.updatedAt ?? f.createdAt).getTime() < staleCutoff).length;
    const corruptedFacts = longTermItems.filter(f => typeof f.confidence === 'number' && f.confidence < 0.3).length;

    return {
      session: { count: sessions.length },
      longTerm: {
        count: longTermItems.length,
        corruptedFacts,
        staleFacts,
        conflictingFacts: pendingConfirmations.length,
      },
      semantic: {
        indexSize: this.semantic.index.size(),
        indexedFacts: semanticItems.length,
        indexReady: this.semantic._indexReady,
      },
    };
  }
}
