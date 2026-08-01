// ── Session Memory ──
// Turn-by-turn conversation history for one session. Short-lived by
// default (sliding TTL refreshed on each write) — this is working memory
// for "what did we just say to each other", not durable knowledge.

import { PulseStore } from '../pulse-store.js';
import { generateId } from '../kernel/ids.js';

const SESSION_TTL = 2 * 3600; // 2 hours sliding

function toSessionShape(meta) {
  return {
    id: meta.id,
    status: 'active', // if the registry entry is still readable, the session's sliding TTL hasn't expired
    mode: meta.mode ?? 'chat',
    userId: meta.userId ?? 'default',
    turnCount: meta.turnCount ?? 0,
    createdAt: meta.createdAt,
    updatedAt: meta.lastActiveAt ?? meta.createdAt,
  };
}

export class SessionMemory {
  constructor({ redisConnection }) {
    this.store = new PulseStore({ redisConnection, namespace: 'mem:session', defaultTtl: SESSION_TTL, persist: false });
    // A session itself (id / created-at / last-active / turn count) is a
    // distinct record from its turns — kept in its own namespace so GET
    // /v1/sessions can list sessions without scanning every turn ever
    // recorded. Same sliding TTL as the turns it describes.
    this.registry = new PulseStore({ redisConnection, namespace: 'mem:session-registry', defaultTtl: SESSION_TTL, persist: false });
  }

  async createSession({ userId = 'default', mode = 'chat' } = {}) {
    const id = generateId();
    const now = new Date().toISOString();
    await this.registry.store({ id, type: 'session', userId, mode, createdAt: now, lastActiveAt: now, turnCount: 0 });
    return toSessionShape({ id, userId, mode, createdAt: now, lastActiveAt: now, turnCount: 0 });
  }

  async listSessions({ limit = 50 } = {}) {
    const items = await this.registry.search({ type: 'session', limit });
    return items.map(toSessionShape);
  }

  async getSession(id) {
    const meta = await this.registry.retrieve(id);
    return meta ? toSessionShape(meta) : null;
  }

  async appendTurn({ sessionId, userId, role, content, toolCalls }) {
    const id = await this.store.store({
      type: 'turn', sessionId, userId, role, content, toolCalls,
      namespaceKey: sessionId,
    });
    const meta = await this.registry.retrieve(sessionId);
    if (meta) {
      await this.registry.update(sessionId, { lastActiveAt: new Date().toISOString(), turnCount: (meta.turnCount ?? 0) + 1 });
    } else {
      // A turn arrived for a session no client explicitly created via
      // POST /v1/sessions (e.g. the caller only ever passed a session_id
      // to /v1/agent/run) — register it lazily so it still shows up in
      // GET /v1/sessions instead of silently existing only as orphan turns.
      const now = new Date().toISOString();
      await this.registry.store({ id: sessionId, type: 'session', userId: userId ?? 'default', mode: 'chat', createdAt: now, lastActiveAt: now, turnCount: 1 });
    }
    return id;
  }

  /** Ordered oldest -> newest, capped to `limit` most recent turns. */
  async getHistory(sessionId, limit = 40) {
    const turns = await this.store.search({ sessionId, type: 'turn', limit: 500 });
    return turns
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
      .slice(-limit);
  }

  async clear(sessionId) {
    const turns = await this.store.search({ sessionId, type: 'turn', limit: 10000 });
    await Promise.all(turns.map(t => this.store.delete(t.id)));
    await this.registry.delete(sessionId);
    return turns.length;
  }
}
