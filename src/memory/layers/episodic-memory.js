// ── Episodic Memory ──
// "What happened": discrete past events with an outcome — a completed
// task, a workflow run, a notable failure and how it was resolved. Used by
// the Reflection/Verification subsystem and by agents that benefit from
// "have we tried this before, and how did it go".

import { PulseStore } from '../pulse-store.js';

const EPISODE_TTL = 30 * 24 * 3600; // 30 days

export class EpisodicMemory {
  constructor({ redisConnection }) {
    this.store = new PulseStore({ redisConnection, namespace: 'mem:episodic', defaultTtl: EPISODE_TTL, persist: false });
  }

  /**
   * `what_worked` / `what_failed` / `tools_used` / `agents_involved` /
   * `duration_ms` / `model_tier_used` / `reusable_pattern` capture the
   * "why" and "how", not just success/fail — so a future similar goal can
   * actually learn something ("bcrypt needed installing first") instead
   * of only knowing "we tried something like this and it worked".
   */
  async recordEpisode({
    userId, projectId, goal, outcome, summary, tags = [], importance = 0.5,
    whatWorked = [], whatFailed = [], toolsUsed = [], agentsInvolved = [],
    durationMs = null, modelTierUsed = null, reusablePattern = null,
  }) {
    return this.store.store({
      type: 'episode', userId, projectId, goal, outcome, summary, tags, importance,
      whatWorked, whatFailed, toolsUsed, agentsInvolved, durationMs, modelTierUsed, reusablePattern,
      accessCount: 0,
    });
  }

  async recall({ userId, projectId, tags, limit = 10 } = {}) {
    return this.store.search({ type: 'episode', userId, projectId, tags, limit });
  }

  async mostSimilarOutcomes(goalKeywords, { userId, limit = 5 } = {}) {
    const episodes = await this.recall({ userId, limit: 200 });
    const scored = episodes.map(e => ({
      episode: e,
      score: keywordOverlap(goalKeywords, `${e.goal} ${e.summary}`),
    }));
    const top = scored.filter(s => s.score > 0).sort((a, b) => b.score - a.score).slice(0, limit).map(s => s.episode);
    await Promise.all(top.map(e => this.store.update(e.id, { accessCount: (e.accessCount ?? 0) + 1 }).catch(() => null)));
    return top;
  }

  /** Episodes older than `olderThanDays` that were never once recalled — candidates for the forgetting sweep. */
  async findStaleUnused({ olderThanDays = 30, limit = 500 } = {}) {
    const episodes = await this.store.search({ type: 'episode', limit: Number.MAX_SAFE_INTEGER });
    const cutoff = Date.now() - olderThanDays * 86400000;
    return episodes.filter(e => new Date(e.createdAt).getTime() < cutoff && (e.accessCount ?? 0) === 0).slice(0, limit);
  }
}

function keywordOverlap(keywords, text) {
  const lower = text.toLowerCase();
  return keywords.reduce((acc, kw) => acc + (lower.includes(kw.toLowerCase()) ? 1 : 0), 0);
}
