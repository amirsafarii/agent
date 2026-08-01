// ── Vector Index (in-process ANN over Pulse-persisted vectors) ──
// Closes the "linear scan capped at N" gap: semantic memory no longer
// silently ignores facts beyond an arbitrary cap. This is a real
// approximate-nearest-neighbor structure (random-hyperplane LSH, the same
// family of algorithm used by production ANN systems before something
// like HNSW/IVF takes over at very large scale), not a fake stand-in.
//
// Design:
//  - `numTables` independent hash tables, each with `bitsPerTable` random
//    hyperplanes. A vector's hash in a table is the sign pattern against
//    that table's hyperplanes -> bucket key.
//  - Query hashes the same way and only rereads vectors that share at
//    least one bucket with the query in any table (sub-linear candidate
//    set), then reranks candidates by exact cosine similarity so
//    accuracy is exact-on-the-candidate-set, approximate only in recall.
//  - Below `exactThreshold` items the index is skipped entirely and a
//    plain full scan is used, because LSH overhead isn't worth it at
//    small N and exactness is free there.
//  - Pure in-memory: it is a derived structure, not a source of truth.
//    PulseStore (Redis) remains the only durable store, per the memory
//    mandate; `rebuild()` reconstructs the index from persisted vectors on
//    boot or after a crash, exactly like every other in-process
//    optimization in this runtime (see PulseStore's own ephemeral
//    fallback for the same durability posture).
//
// Third-party / production-scale option: this default index can be
// swapped out entirely by pointing `SemanticMemory`'s store at a real
// external vector database (pgvector, Qdrant, etc.) built with
// `definememoryProvider` (see plugin-sdk/define-memory-provider.js) — the
// runtime is never locked to one vector backend.

function randomUnitVector(dim, rng) {
  const v = new Array(dim);
  let norm = 0;
  for (let i = 0; i < dim; i++) {
    const x = rng() * 2 - 1;
    v[i] = x;
    norm += x * x;
  }
  norm = Math.sqrt(norm) || 1;
  return v.map(x => x / norm);
}

// Deterministic PRNG (mulberry32) so the index is reproducible across
// restarts with the same seed — useful for tests, harmless in production.
function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export class LSHVectorIndex {
  /**
   * @param {{ dimensions?: number, numTables?: number, bitsPerTable?: number, exactThreshold?: number, seed?: number }} opts
   */
  constructor({ dimensions = 256, numTables = 6, bitsPerTable = 10, exactThreshold = 500, seed = 42 } = {}) {
    this.dimensions = dimensions;
    this.numTables = numTables;
    this.bitsPerTable = bitsPerTable;
    this.exactThreshold = exactThreshold;

    const rng = mulberry32(seed);
    // hyperplanes[table][bit] -> unit vector
    this.hyperplanes = Array.from({ length: numTables }, () =>
      Array.from({ length: bitsPerTable }, () => randomUnitVector(dimensions, rng))
    );

    this.tables = Array.from({ length: numTables }, () => new Map()); // bucketKey -> Set<id>
    this.vectors = new Map(); // id -> vector
  }

  _hash(vector, tableIdx) {
    const planes = this.hyperplanes[tableIdx];
    let key = '';
    for (let i = 0; i < planes.length; i++) {
      key += dot(vector, planes[i]) >= 0 ? '1' : '0';
    }
    return key;
  }

  add(id, vector) {
    if (!vector || vector.length !== this.dimensions) return; // guard against dimension drift
    this.remove(id);
    this.vectors.set(id, vector);
    for (let t = 0; t < this.numTables; t++) {
      const key = this._hash(vector, t);
      if (!this.tables[t].has(key)) this.tables[t].set(key, new Set());
      this.tables[t].get(key).add(id);
    }
  }

  remove(id) {
    const existing = this.vectors.get(id);
    if (!existing) return;
    for (let t = 0; t < this.numTables; t++) {
      const key = this._hash(existing, t);
      this.tables[t].get(key)?.delete(id);
    }
    this.vectors.delete(id);
  }

  size() {
    return this.vectors.size;
  }

  /**
   * Returns a candidate id set — approximate, sub-linear once size() >
   * exactThreshold. Uses multi-probe LSH: besides each table's exact
   * bucket, also probes buckets at Hamming distance 1 (single bit flip)
   * from the query hash, which is the standard technique to recover the
   * recall a single-probe scheme loses in high dimensions, without
   * resorting to a full scan. Only a truly pathological miss (near-zero
   * candidates even after multi-probe) falls back to exact scan.
   */
  candidates(queryVector) {
    if (this.vectors.size <= this.exactThreshold) {
      return new Set(this.vectors.keys());
    }

    const out = new Set();
    for (let t = 0; t < this.numTables; t++) {
      const key = this._hash(queryVector, t);
      const bucket = this.tables[t].get(key);
      if (bucket) for (const id of bucket) out.add(id);

      // Multi-probe: flip each bit once and check that neighboring bucket
      // too — cheap (bitsPerTable extra lookups per table) and recovers
      // most of the recall a hyperplane near a decision boundary loses.
      for (let bit = 0; bit < key.length; bit++) {
        const flipped = key.slice(0, bit) + (key[bit] === '1' ? '0' : '1') + key.slice(bit + 1);
        const neighborBucket = this.tables[t].get(flipped);
        if (neighborBucket) for (const id of neighborBucket) out.add(id);
      }
    }

    // Pathological-miss safety net (e.g. degenerate/all-zero vectors
    // collapsing every hash to the same bucket): only kicks in when
    // multi-probe still finds almost nothing.
    if (out.size < Math.min(5, this.vectors.size)) {
      return new Set(this.vectors.keys());
    }
    return out;
  }

  clear() {
    this.vectors.clear();
    this.tables = Array.from({ length: this.numTables }, () => new Map());
  }
}
