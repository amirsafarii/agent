/**
 * artifacts/artifact-manager.js — Artifact system
 * ---------------------------------------------------------------------------
 * A first-class artifact ledger. The agent creates files, runs code, and tests
 * it — so every durable by-product should be tracked with enough metadata to
 * enable checkpoint and rollback without guessing.
 *
 * Artifact types (see ArtifactType):
 *   file, generated_code, test_result, report, patch, command_output,
 *   external_resource
 *
 * Example:
 *   {
 *     id: "artifact_123",
 *     type: "file",
 *     path: "src/weather.js",
 *     taskId: "task_44",
 *     createdBy: "tool",
 *     checksum: "...",   // sha256 of file content (or data)
 *     version: 3,
 *     createdAt, updatedAt
 *   }
 *
 * Every `register()` bumps nothing; every `update()` that changes content
 * increments `version`. `snapshot()` / `rollback()` give a cheap checkpoint /
 * rollback of the ledger (metadata only — the actual file contents live on
 * disk in the sandbox; snapshot records their checksums so rollback can
 * compare / restore-from-content when `content` was captured).
 *
 * Pure JavaScript (ES modules), in-process Map backing.
 */

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { sha256 } from '../evaluation/index.js';

export const ArtifactType = Object.freeze({
  FILE: 'file',
  GENERATED_CODE: 'generated_code',
  TEST_RESULT: 'test_result',
  REPORT: 'report',
  PATCH: 'patch',
  COMMAND_OUTPUT: 'command_output',
  EXTERNAL_RESOURCE: 'external_resource',
});

function nowIso() {
  return new Date().toISOString();
}

export class ArtifactManager {
  /** @param {Object} [opts] @param {string} [opts.rootDir] sandbox root used to read file contents for checksums */
  constructor(opts = {}) {
    this.rootDir = opts.rootDir || process.cwd();
    /** @type {Map<string, Object>} */
    this._artifacts = new Map();
  }

  /**
   * Register a new artifact (version 1).
   * @param {Object} spec
   * @param {string} spec.type - one of ArtifactType
   * @param {string} [spec.path] relative path (for file/code/patch artifacts)
   * @param {string} [spec.taskId]
   * @param {string} [spec.createdBy] 'tool' | 'agent' | ...
   * @param {string} [spec.content] capture inline content (checked into checksum)
   * @param {*} [spec.data] arbitrary structured payload (e.g. test result object)
   * @param {string} [spec.description]
   * @returns {Promise<Object>} the stored artifact
   */
  async register({ type = 'other', path, taskId, createdBy = 'tool', content, data, description } = {}) {
    const checksum = await this._checksum({ path, content, data });
    const id = `artifact_${randomUUID().slice(0, 10)}`;
    const now = nowIso();
    const artifact = {
      id,
      type: type || 'other',
      path: path || null,
      taskId: taskId || null,
      createdBy,
      checksum,
      version: 1,
      content: content != null ? String(content) : null,
      data: data !== undefined ? data : null,
      description: description || null,
      createdAt: now,
      updatedAt: now,
    };
    this._artifacts.set(id, artifact);
    return artifact;
  }

  get(id) {
    return this._artifacts.get(id) || null;
  }

  /** @returns {Object[]} artifacts filtered by optional {taskId, type} */
  list({ taskId, type } = {}) {
    let items = [...this._artifacts.values()];
    if (taskId) items = items.filter((a) => a.taskId === taskId);
    if (type) items = items.filter((a) => a.type === type);
    return items.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /**
   * Update an artifact. If content/checksum changes, `version` increments.
   * @returns {Promise<Object|null>} updated artifact (or null if not found)
   */
  async update(id, updates = {}) {
    const existing = this._artifacts.get(id);
    if (!existing) return null;
    const contentChanged = updates.content !== undefined && updates.content !== existing.content;
    const dataChanged = updates.data !== undefined && JSON.stringify(updates.data) !== JSON.stringify(existing.data);
    let checksum = existing.checksum;
    if (contentChanged || dataChanged) {
      checksum = await this._checksum({
        path: updates.path ?? existing.path,
        content: updates.content !== undefined ? updates.content : existing.content,
        data: updates.data !== undefined ? updates.data : existing.data,
      });
    }
    const updated = {
      ...existing,
      ...updates,
      checksum,
      version: contentChanged || dataChanged ? existing.version + 1 : existing.version,
      updatedAt: nowIso(),
    };
    this._artifacts.set(id, updated);
    return updated;
  }

  /** @returns {Promise<boolean>} */
  async delete(id) {
    return this._artifacts.delete(id);
  }

  /** Immutable ledger snapshot for checkpointing. @returns {Object[]} */
  snapshot() {
    return [...this._artifacts.values()].map((a) => JSON.parse(JSON.stringify(a)));
  }

  /** Restore the ledger to a previous snapshot (replaces all artifacts). */
  async rollback(snapshot = []) {
    this._artifacts.clear();
    for (const a of snapshot) this._artifacts.set(a.id, JSON.parse(JSON.stringify(a)));
    return this._artifacts.size;
  }

  /** Recompute checksums against current disk state for all file-backed artifacts. */
  async reconcile() {
    for (const a of [...this._artifacts.values()]) {
      if (a.path) {
        const checksum = await this._checksum({ path: a.path });
        if (checksum && checksum !== a.checksum) {
          this._artifacts.set(a.id, { ...a, checksum, version: a.version + 1, updatedAt: nowIso() });
        }
      }
    }
    return this._artifacts.size;
  }

  stats() {
    const counts = {};
    for (const a of this._artifacts.values()) counts[a.type] = (counts[a.type] || 0) + 1;
    return { count: this._artifacts.size, byType: counts };
  }

  async _checksum({ path, content, data }) {
    let text = null;
    if (content != null) text = String(content);
    else if (path) {
      try {
        const abs = path.startsWith('/') ? path : `${this.rootDir}/${path}`;
        text = await fs.readFile(abs, 'utf8');
      } catch (_err) {
        // file may not exist yet — checksum data only
      }
    }
    if (text == null && data !== undefined) text = JSON.stringify(data);
    return sha256(text ?? '');
  }
}
