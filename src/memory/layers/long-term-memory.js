// ── Long-Term Memory ──
// Durable user/organization-level knowledge that should survive
// indefinitely: preferences, standing facts, decisions. This is the layer
// the dashboard's "Memory" CRUD screen talks to directly.
//
// Versioned + confidence-aware: a plain CRUD store lets one wrong
// extraction (the model mis-hears "if my name were Ali..." as a real
// disclosure) permanently overwrite a fact with no history and no way
// back. Every write here carries a `confidence` (0..1) and a `source`
// ('explicit' | 'inferred' | 'assumed'). A fact the user stated directly
// is `confirmedByUser: true`; once a key is confirmed, a later write for
// the same key that is NOT explicit and carries lower confidence does not
// silently clobber it — it is queued as `pendingValue` with
// `requiresConfirmation: true` instead, and `current` is left untouched
// until something explicit (a user restatement, or an explicit
// `confirm()`) resolves it. Every accepted value is also appended to
// `versions` so the fact's history is never lost to an overwrite.

import { PulseStore } from '../pulse-store.js';

const VALID_SOURCES = new Set(['explicit', 'inferred', 'assumed']);

function normalizeSource(source) {
  return VALID_SOURCES.has(source) ? source : 'explicit';
}

function clampConfidence(confidence) {
  return typeof confidence === 'number' && Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.7;
}

export class LongTermMemory {
  constructor({ redisConnection }) {
    // persist: true — no TTL. Pulse still lets a caller pass a per-item ttl
    // if something genuinely needs to expire, but the default is forever.
    this.store = new PulseStore({ redisConnection, namespace: 'mem:longterm', defaultTtl: 0, persist: true });
  }

  async create({ userId, key, value, tags = [], importance = 0.7, confidence, source, turnId, confirmedByUser }) {
    const conf = clampConfidence(confidence);
    const src = normalizeSource(source);
    const confirmed = confirmedByUser ?? (src === 'explicit');
    return this.store.store({
      type: 'fact', userId, key, value, tags, importance, persist: true,
      confidence: conf, source: src, confirmedByUser: confirmed, requiresConfirmation: false,
      versions: [{ value, setAt: new Date().toISOString(), setBy: src, confidence: conf, turnId: turnId ?? null }],
    });
  }

  /**
   * Create-or-update by (userId, key): a real durable-memory fact like
   * "user_name" should have exactly one current value per user, not a
   * new record every time the extractor sees it mentioned again. Looks
   * up the existing record for this key first and updates it in place;
   * only creates a new record the first time this key is seen.
   *
   * Conflict rule: if the existing record is `confirmedByUser` and the
   * incoming write is not `explicit` (i.e. it's an inference/assumption)
   * with confidence at or below the existing confidence, the incoming
   * value is parked as `pendingValue` / `requiresConfirmation: true`
   * rather than overwriting `current` — a stray guess from the model can
   * no longer silently replace something the user actually said.
   */
  async upsertByKey({ userId, key, value, tags = [], importance = 0.7, confidence, source, turnId, confirmedByUser }) {
    const conf = clampConfidence(confidence);
    const src = normalizeSource(source);
    const confirmed = confirmedByUser ?? (src === 'explicit');

    if (!key) return this.create({ userId, key, value, tags, importance, confidence: conf, source: src, turnId, confirmedByUser: confirmed });

    const existing = await this.store.search({ userId, type: 'fact', limit: 500 });
    const match = existing.find(item => item.key === key);
    if (!match) return this.create({ userId, key, value, tags, importance, confidence: conf, source: src, turnId, confirmedByUser: confirmed });

    const existingConfirmed = match.confirmedByUser === true;
    const incomingIsWeaker = src !== 'explicit' && conf <= (match.confidence ?? 0.7);

    if (existingConfirmed && incomingIsWeaker && match.value !== value) {
      // Don't clobber a confirmed fact with a weaker guess — surface the
      // conflict instead so a maintenance sweep / dashboard can ask the
      // user, rather than the memory quietly changing underneath them.
      await this.store.update(match.id, {
        requiresConfirmation: true,
        pendingValue: value,
        pendingSource: src,
        pendingConfidence: conf,
        pendingTurnId: turnId ?? null,
      });
      return match.id;
    }

    const versions = [...(match.versions ?? []), { value, setAt: new Date().toISOString(), setBy: src, confidence: conf, turnId: turnId ?? null }].slice(-20);
    await this.store.update(match.id, {
      value, tags, importance, versions,
      confidence: conf, source: src,
      confirmedByUser: confirmed || match.confirmedByUser === true,
      requiresConfirmation: false, pendingValue: undefined, pendingSource: undefined, pendingConfidence: undefined,
    });
    return match.id;
  }

  /** Accept a pending (previously conflicting) value as the new confirmed current value. */
  async confirmPending(id) {
    const item = await this.store.retrieve(id);
    if (!item || !item.requiresConfirmation) return null;
    const versions = [...(item.versions ?? []), { value: item.pendingValue, setAt: new Date().toISOString(), setBy: 'user_confirmed', confidence: 1, turnId: item.pendingTurnId ?? null }].slice(-20);
    return this.store.update(id, {
      value: item.pendingValue, versions, confidence: 1, source: 'explicit', confirmedByUser: true,
      requiresConfirmation: false, pendingValue: undefined, pendingSource: undefined, pendingConfidence: undefined,
    });
  }

  /** Reject a pending value, keeping the current confirmed value and discarding the guess. */
  async rejectPending(id) {
    const item = await this.store.retrieve(id);
    if (!item || !item.requiresConfirmation) return null;
    return this.store.update(id, { requiresConfirmation: false, pendingValue: undefined, pendingSource: undefined, pendingConfidence: undefined });
  }

  async get(id) { return this.store.retrieve(id); }

  async list({ userId, tags, limit = 100 } = {}) {
    return this.store.search({ userId, type: 'fact', tags, limit });
  }

  /** Facts the user has explicitly confirmed — the only tier the Context Engine treats as "critical". */
  async getConfirmed({ userId, limit = 100 } = {}) {
    const items = await this.store.search({ userId, type: 'fact', limit: Math.max(limit, 500) });
    return items.filter(i => i.confirmedByUser === true).slice(0, limit);
  }

  /** Facts currently parked awaiting user confirmation — surfaced by the memory health endpoint. */
  async listPendingConfirmations({ userId, limit = 100 } = {}) {
    const items = await this.store.search({ userId, type: 'fact', limit: Math.max(limit, 500) });
    return items.filter(i => i.requiresConfirmation === true).slice(0, limit);
  }

  async update(id, updates) { return this.store.update(id, updates); }

  async delete(id) { return this.store.delete(id); }
}
