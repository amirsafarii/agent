// ── Embeddings ──
// Thin adapter over the provider registry's embed() call, with a
// deterministic offline fallback so semantic memory / RAG is fully
// exercisable (and unit-testable) without any external API key.

const FALLBACK_DIMENSIONS = 256;

/** Deterministic bag-of-hashed-tokens vector — not semantically meaningful
 *  like a real embedding model, but stable and comparison-safe, so cosine
 *  similarity still clusters near-duplicate/overlapping text together. */
function hashEmbed(text) {
  const vector = new Array(FALLBACK_DIMENSIONS).fill(0);
  const tokens = String(text).toLowerCase().match(/[a-z0-9\u0600-\u06FF]+/g) ?? [];
  for (const token of tokens) {
    let hash = 2166136261;
    for (let i = 0; i < token.length; i++) {
      hash ^= token.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    const idx = Math.abs(hash) % FALLBACK_DIMENSIONS;
    vector[idx] += 1;
  }
  const norm = Math.sqrt(vector.reduce((s, v) => s + v * v, 0)) || 1;
  return vector.map(v => v / norm);
}

export class EmbeddingService {
  /**
   * @param {Object} [deps]
   * @param {{ getDefault: () => ({ name?: string, embed?: (text: string) => Promise<{ embeddings: number[][] }> } | undefined) }} [deps.providerRegistry]
   *        Optional LLM provider registry (from the runtime that originally
   *        hosted this memory system). Missing or unembeddable providers
   *        transparently fall back to the deterministic offline embedding.
   */
  constructor({ providerRegistry } = {}) {
    this.providerRegistry = providerRegistry;
  }

  async embed(text) {
    try {
      const provider = this.providerRegistry.getDefault();
      if (provider?.name !== 'mock' && typeof provider.embed === 'function') {
        const result = await provider.embed(text);
        if (result?.embeddings?.[0]) return result.embeddings[0];
      }
    } catch {
      // Fall through to the offline embedding — semantic memory must never
      // hard-fail just because a real embedding model call errored.
    }
    return hashEmbed(text);
  }
}

export function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
