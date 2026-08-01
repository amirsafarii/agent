// ── Generic Pulse-Backed Store ──
// This is THE persistence primitive for the whole runtime: every memory
// layer (session/workspace/episodic/semantic/long-term/tool/project) and
// every execution-state store (checkpoints, task records, workflow runs)
// is an instance of this class, distinguished only by namespace, default
// TTL, and whether its items persist (survive TTL expiry) or not. There is
// deliberately no separate database — Redis via PulseJS is the only
// storage engine, per the runtime's memory mandate.
//
// Degrades to an in-process Map automatically when Redis is unreachable,
// so the OS stays usable (single-process, non-durable) in a bare sandbox
// with no Redis running, and recovers transparently once Redis comes back.

import { cacheWorker } from './pulse.js';
import { generateId } from './kernel/ids.js';
import { childLogger } from './kernel/logger.js';

const log = childLogger('pulse-store');

class EphemeralFallback {
  constructor() { this.data = new Map(); }

  async store(item) {
    const id = item.id ?? generateId();
    const now = new Date().toISOString();
    this.data.set(id, { ...item, id, createdAt: item.createdAt ?? now, updatedAt: now });
    return id;
  }

  async retrieve(id) { return this.data.get(id) ?? null; }

  async search(query = {}) {
    let items = [...this.data.values()];
    items = items.filter(item => matchesQuery(item, query));
    items.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return items.slice(0, query.limit ?? 20);
  }

  async delete(id) { return this.data.delete(id); }

  async update(id, updates) {
    const existing = this.data.get(id);
    if (!existing) return null;
    const updated = { ...existing, ...updates, id, updatedAt: new Date().toISOString() };
    this.data.set(id, updated);
    return updated;
  }

  async clear() { this.data.clear(); }
}

function matchesQuery(item, query) {
  if (query.namespaceKey && item.namespaceKey !== query.namespaceKey) return false;
  if (query.type && item.type !== query.type) return false;
  if (query.types && !query.types.includes(item.type)) return false;
  if (query.userId && item.userId !== query.userId) return false;
  if (query.sessionId && item.sessionId !== query.sessionId) return false;
  if (query.projectId && item.projectId !== query.projectId) return false;
  if (query.runId && item.runId !== query.runId) return false;
  if (query.nodeId && item.nodeId !== query.nodeId) return false;
  if (query.module !== undefined && (item.module ?? null) !== query.module) return false;
  if (query.tags && !query.tags.some(t => item.tags?.includes(t))) return false;
  if (query.minImportance !== undefined && (item.importance ?? 0) < query.minImportance) return false;
  return true;
}

export class PulseStore {
  /**
   * @param {{ redisConnection: ReturnType<import('./redis-connection.js').createRedisConnection>, namespace: string, defaultTtl?: number, persist?: boolean }} opts
   */
  constructor({ redisConnection, namespace, defaultTtl = 7 * 24 * 3600, persist = false }) {
    this.namespace = namespace;
    this.defaultTtl = defaultTtl;
    this.persist = persist;
    this.redisConnection = redisConnection;
    this.fallback = new EphemeralFallback();
    this.pulse = redisConnection
      ? cacheWorker({
          redis: redisConnection.client,
          namespace,
          defaultTtl,
          logger: log,
          allowColonInKey: true,
        })
      : null;
  }

  isAvailable() {
    return !!this.redisConnection?.isReady() && !!this.pulse;
  }

  _tagsFor(item) {
    const tags = [`type_${item.type ?? 'generic'}`];
    if (item.namespaceKey) tags.push(`key_${item.namespaceKey}`);
    if (item.sessionId) tags.push(`session_${item.sessionId}`);
    if (item.projectId) tags.push(`project_${item.projectId}`);
    if (item.userId) tags.push(`user_${item.userId}`);
    if (Array.isArray(item.tags)) tags.push(...item.tags.map(t => `tag_${t}`));
    return tags;
  }

  async store(item) {
    if (!this.isAvailable()) return this.fallback.store(item);

    const id = item.id ?? generateId();
    const now = new Date().toISOString();
    const fullItem = { ...item, id, createdAt: item.createdAt ?? now, updatedAt: now };
    const ttl = item.ttl ?? this.defaultTtl;

    try {
      await this.pulse.setCache(`item:${id}`, fullItem, ttl, this._tagsFor(fullItem), this.persist || item.persist === true);
      return id;
    } catch (err) {
      log.warn({ err: String(err), namespace: this.namespace }, 'Pulse write failed — falling back to in-process store');
      return this.fallback.store(item);
    }
  }

  async retrieve(id) {
    if (!this.isAvailable()) return this.fallback.retrieve(id);
    try {
      return (await this.pulse.getCache(`item:${id}`)) ?? null;
    } catch (err) {
      log.warn({ err: String(err) }, 'Pulse read failed');
      return null;
    }
  }

  async update(id, updates) {
    const existing = await this.retrieve(id);
    if (!existing) return null;
    const updated = { ...existing, ...updates, id, updatedAt: new Date().toISOString() };
    if (!this.isAvailable()) return this.fallback.update(id, updates);
    try {
      await this.pulse.setCache(`item:${id}`, updated, updates.ttl ?? existing.ttl ?? this.defaultTtl, this._tagsFor(updated), this.persist || updated.persist === true);
      return updated;
    } catch (err) {
      log.warn({ err: String(err) }, 'Pulse update failed');
      return this.fallback.update(id, updates);
    }
  }

  async delete(id) {
    if (!this.isAvailable()) return this.fallback.delete(id);
    try {
      return (await this.pulse.deleteCache(`item:${id}`)) > 0;
    } catch {
      return false;
    }
  }

  /**
   * Scans the namespace. Fine for the working-set sizes this runtime deals
   * with (a session's memory, a project's memory); for very large corpora
   * the semantic layer's embedding index should be consulted first to
   * narrow candidates before this is used to hydrate full records.
   */
  async search(query = {}) {
    if (!this.isAvailable()) return this.fallback.search(query);

    const results = [];
    let cursor = '0';
    const pattern = `${this.namespace}:item:*`;

    try {
      const client = this.pulse.client;
      do {
        const [nextCursor, keys] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
        cursor = nextCursor;
        if (keys.length > 0) {
          const values = await client.mget(...keys);
          for (const val of values) {
            if (!val) continue;
            try {
              const item = JSON.parse(val);
              if (matchesQuery(item, query)) results.push(item);
            } catch { /* skip corrupt entry */ }
          }
        }
      } while (cursor !== '0');
    } catch (err) {
      log.warn({ err: String(err) }, 'Pulse scan failed during search');
      return [];
    }

    results.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return results.slice(0, query.limit ?? 20);
  }

  async count() {
    const items = await this.search({ limit: Number.MAX_SAFE_INTEGER });
    return items.length;
  }

  /**
   * Direct multi-get by id — O(k) key reads instead of a namespace SCAN,
   * the real sub-linear IO path an ANN candidate set needs (vs. the
   * search()'s full-namespace scan, which is fine for hydrating a small
   * working set but defeats the point of narrowing candidates first).
   */
  async retrieveMany(ids) {
    if (!ids || ids.length === 0) return [];
    if (!this.isAvailable()) {
      return (await Promise.all(ids.map(id => this.fallback.retrieve(id)))).filter(Boolean);
    }
    try {
      const client = this.pulse.client;
      const keys = ids.map(id => `${this.namespace}:item:${id}`);
      const values = await client.mget(...keys);
      return values.filter(Boolean).map(v => { try { return JSON.parse(v); } catch { return null; } }).filter(Boolean);
    } catch (err) {
      log.warn({ err: String(err) }, 'Pulse retrieveMany failed');
      return [];
    }
  }
}
