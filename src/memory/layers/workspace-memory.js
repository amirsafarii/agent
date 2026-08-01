// ── Workspace Memory ──
// The current run's scratch space: files touched, intermediate artifacts,
// open questions — everything a long-running task needs to remember about
// its own progress *right now*.
//
// Node-isolated by design: when the DAG runs steps in parallel, two
// sibling nodes writing "current_file" into one shared `runId` bucket at
// the same time is a real race — whichever write lands last silently wins
// and the other node's own scratch state is gone. Every write here is
// scoped to `(runId, nodeId)` so concurrent nodes physically cannot
// collide, and the merged, run-wide view (`getWorkspace`) only ever
// reflects nodes that have actually finished and been merged in by the
// orchestrator via `mergeNode()` — no other caller writes to the merged
// view directly, so there is exactly one place a race could happen and
// it only runs after a node is done, never concurrently with another
// node's writes.

import { PulseStore } from '../pulse-store.js';

const WORKSPACE_TTL = 24 * 3600; // 24 hours

function nodeNamespaceKey(runId, nodeId) {
  return `${runId}:node:${nodeId}`;
}

function mergedNamespaceKey(runId) {
  return `${runId}:merged`;
}

export class WorkspaceMemory {
  constructor({ redisConnection }) {
    this.store = new PulseStore({ redisConnection, namespace: 'mem:workspace', defaultTtl: WORKSPACE_TTL, persist: false });
  }

  /** Write into ONE node's own scratch space — never visible to sibling nodes until merged. */
  async record(runId, nodeId, entry) {
    if (!nodeId) throw new Error('WorkspaceMemory.record requires a nodeId — use "root" for non-DAG single-agent runs, never a shared bucket for concurrent work');
    return this.store.store({ type: entry.type ?? 'note', runId, nodeId, namespaceKey: nodeNamespaceKey(runId, nodeId), ...entry });
  }

  async touchFile(runId, nodeId, path, action) {
    return this.record(runId, nodeId, { type: 'file_touch', path, action });
  }

  /** A single node's own in-flight scratch state (before it has merged). */
  async getNodeWorkspace(runId, nodeId, limit = 200) {
    return this.store.search({ namespaceKey: nodeNamespaceKey(runId, nodeId), limit });
  }

  /**
   * The run-wide, cross-node-visible workspace state. Only ever populated
   * by `mergeNode()` — reflects nodes that have *finished*, so reading
   * this mid-run never races a sibling node's in-progress writes.
   */
  async getWorkspace(runId, limit = 200) {
    return this.store.search({ namespaceKey: mergedNamespaceKey(runId), limit });
  }

  /**
   * Folds one finished node's scratch entries into the run-wide merged
   * view. Only the orchestrator should call this, and only after the
   * node's `runNode()` has actually completed — merging a still-running
   * node's entries would defeat the whole point of the isolation.
   * Idempotent: re-merging the same node overwrites the same ids instead
   * of duplicating entries.
   */
  async mergeNode(runId, nodeId) {
    const entries = await this.getNodeWorkspace(runId, nodeId, 10000);
    for (const entry of entries) {
      await this.store.store({ ...entry, id: entry.id, namespaceKey: mergedNamespaceKey(runId), mergedFromNodeId: nodeId });
    }
    return entries.length;
  }

  async clear(runId) {
    const merged = await this.getWorkspace(runId, 10000);
    await Promise.all(merged.map(i => this.store.delete(i.id)));
    return merged.length;
  }

  async clearNode(runId, nodeId) {
    const items = await this.getNodeWorkspace(runId, nodeId, 10000);
    await Promise.all(items.map(i => this.store.delete(i.id)));
    return items.length;
  }
}
