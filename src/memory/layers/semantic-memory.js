// ── Semantic Memory ──
// Embedded facts/knowledge for Retrieval-Augmented Generation. Every item
// carries an embedding vector (real, from the configured provider, or a
// deterministic offline fallback — see embeddings.js) so retrieval is
// similarity-based rather than keyword-based.
//
// Retrieval path: an in-process LSH ANN index (vector-index.js) narrows
// the candidate set once the corpus grows past a small exact-scan
// threshold, so retrieve() no longer silently truncates at an arbitrary
// item cap the way a naive full scan does at scale. The index is a
// derived structure only — Pulse/Redis remains the sole source of truth,
// and `rebuildIndex()` reconstructs it from persisted vectors on boot.

import { PulseStore } from '../pulse-store.js';
import { cosineSimilarity } from '../embeddings.js';
import { LSHVectorIndex } from '../vector-index.js';

const SEMANTIC_TTL = 90 * 24 * 3600; // 90 days
const INDEX_DIMENSIONS = 256; // must match embeddings.js FALLBACK_DIMENSIONS / provider dims

// Temporal decay: a fact loses relevance the older it gets, so a
// six-month-old note no longer competes on equal footing with something
// learned an hour ago just because the cosine similarity happens to
// match. -0.01/day ~= half-relevance around 70 days, negligible at 90+
// (which is also the layer's own TTL, so decayed-to-near-zero facts are
// naturally aging out of the store around the same time anyway).
const DECAY_RATE_PER_DAY = 0.01;
// Usage boost: a fact retrieved often is evidently useful — nudge it up
// without letting it dominate a genuinely irrelevant query (log-scaled,
// small weight).
const USAGE_BOOST_WEIGHT = 0.1;

/** Exported so context-engine / health checks can reuse the exact same scoring the retrieval path uses. */
export function getRelevanceScore(item, queryVector) {
  const semanticScore = cosineSimilarity(queryVector, item.vector);
  const ageInDays = Math.max(0, (Date.now() - new Date(item.createdAt).getTime()) / 86400000);
  const decayFactor = Math.exp(-DECAY_RATE_PER_DAY * ageInDays);
  const usageBoost = Math.log(1 + (item.accessCount ?? 0)) * USAGE_BOOST_WEIGHT;
  return semanticScore * decayFactor + usageBoost;
}

export class SemanticMemory {
  constructor({ redisConnection, embeddings, vectorIndex }) {
    this.store = new PulseStore({ redisConnection, namespace: 'mem:semantic', defaultTtl: SEMANTIC_TTL, persist: true });
    this.embeddings = embeddings;
    this.index = vectorIndex ?? new LSHVectorIndex({ dimensions: INDEX_DIMENSIONS });
    this._indexReady = false;
  }

  async remember({ userId, projectId, text, tags = [], importance = 0.5 }) {
    const vector = await this.embeddings.embed(text);
    const id = await this.store.store({ type: 'fact', userId, projectId, text, tags, importance, vector });
    if (vector?.length === this.index.dimensions) this.index.add(id, vector);
    return id;
  }

  /** Rebuilds the ANN index from persisted vectors — call on boot and after crash recovery. */
  async rebuildIndex() {
    this.index.clear();
    const items = await this.store.search({ type: 'fact', limit: Number.MAX_SAFE_INTEGER });
    for (const item of items) {
      if (item.vector?.length === this.index.dimensions) this.index.add(item.id, item.vector);
    }
    this._indexReady = true;
    return items.length;
  }

  /**
   * Retrieval-Augmented Generation query: top-k most similar facts,
   * ranked by relevance = semantic similarity * temporal decay + usage
   * boost (see getRelevanceScore above), not raw cosine similarity alone
   * — a stale six-month-old fact no longer outranks a fresher, equally
   * similar one just by coincidence of wording. `minScore` (0..1, applied
   * to the raw cosine similarity, before decay/boost) lets a caller like
   * the Context Engine's "relevant" tier demand a real semantic match
   * rather than noise.
   */
  async retrieve(query, { userId, projectId, k = 5, minScore = 0 } = {}) {
    const queryVector = await this.embeddings.embed(query);

    // Lazily hydrate the index on first use if it was never rebuilt (e.g.
    // a fresh process that only ever calls retrieve()).
    if (!this._indexReady && this.index.size() === 0) await this.rebuildIndex();

    const candidateIds = this.index.candidates(queryVector);
    let candidates;
    if (candidateIds.size > 0 && this.index.size() > this.index.exactThreshold) {
      // Sub-linear path: direct multi-get on only the ANN candidate ids,
      // then filter by userId/projectId in memory (cheap — candidate set
      // is already small relative to the full corpus).
      const hydrated = await this.store.retrieveMany([...candidateIds]);
      candidates = hydrated.filter(item =>
        (!userId || item.userId === userId) && (!projectId || item.projectId === projectId)
      );
    } else {
      // Small corpus: exact full scan is cheap and guarantees correctness.
      candidates = await this.store.search({ type: 'fact', userId, projectId, limit: Number.MAX_SAFE_INTEGER });
    }

    const scored = candidates
      .map(item => ({ item, rawScore: cosineSimilarity(queryVector, item.vector), score: getRelevanceScore(item, queryVector) }))
      .filter(({ rawScore }) => rawScore >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, k);

    // Usage boost feeds back: a fact that keeps getting retrieved is
    // evidently useful, so bump its accessCount for next time. Best-effort
    // — never let bookkeeping failure break the actual retrieval result.
    await Promise.all(scored.map(({ item }) =>
      this.store.update(item.id, { accessCount: (item.accessCount ?? 0) + 1 }).catch(() => null)
    ));

    return scored.map(({ item, rawScore, score }) => ({ text: item.text, tags: item.tags, importance: item.importance, score, rawScore, id: item.id }));
  }

  async forget(id) {
    this.index.remove(id);
    return this.store.delete(id);
  }
}
