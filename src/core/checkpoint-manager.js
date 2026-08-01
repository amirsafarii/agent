/**
 * checkpoint-manager.js — Checkpoint Manager
 * -----------------------------------------------
 * AgentLoop.checkpoint() used to just hand you a snapshot object and forget
 * about it — you had to store it yourself. CheckpointManager is the missing
 * piece: it keeps every snapshot taken during a session addressable by id,
 * in memory always and on disk when a directory is given, so a supervisor
 * (Slack bot, cron job, crash recovery script) can list what's resumable and
 * grab an exact one later — not just "the last one".
 *
 * Pure JavaScript (ES modules). No dependency: disk persistence is plain
 * fs/promises, one JSON file per checkpoint.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from './logger.js';

const log = createLogger('checkpoint');

export class CheckpointManager {
  /**
   * @param {Object} [opts]
   * @param {string} [opts.dir] Directory to persist checkpoints to (one JSON file per checkpoint).
   *        Omit to keep checkpoints in-memory only (lost on process exit).
   * @param {number} [opts.maxInMemory=50] Oldest checkpoints beyond this count are evicted from
   *        the in-memory index (their files, if any, are left on disk).
   */
  constructor({ dir, maxInMemory = 50 } = {}) {
    this.dir = dir || null;
    this.maxInMemory = maxInMemory;
    /** @type {Map<string, {id:string, savedAt:number, meta:object, snapshot:object}>} */
    this._index = new Map();
    this._ready = this.dir ? mkdir(this.dir, { recursive: true }).catch((err) => {
      log.warn('init:mkdir_failed', { dir: this.dir, error: err.message });
    }) : Promise.resolve();
  }

  /**
   * Store a checkpoint snapshot (from AgentLoop.checkpoint()) under a fresh id.
   * @param {object} snapshot - see docs/LOOP.md → Checkpoint.
   * @param {object} [meta] - free-form tag, e.g. { label: 'before-risky-tool', step: snapshot.step }.
   * @returns {Promise<string>} the generated checkpoint id
   */
  async save(snapshot, meta = {}) {
    await this._ready;
    const id = randomUUID();
    const record = { id, savedAt: Date.now(), meta, snapshot };
    this._index.set(id, record);
    this._evictIfNeeded();

    if (this.dir) {
      try {
        await writeFile(join(this.dir, `${id}.json`), JSON.stringify(record, null, 2), 'utf8');
      } catch (err) {
        log.warn('save:write_failed', { id, error: err.message });
      }
    }
    log.info('save', { id, step: snapshot.step, state: snapshot.state, persisted: !!this.dir });
    return id;
  }

  /** In-memory lookup by id. Falls back to disk (if configured) when not resident. */
  async get(id) {
    if (this._index.has(id)) return this._index.get(id);
    if (!this.dir) return null;
    try {
      const raw = await readFile(join(this.dir, `${id}.json`), 'utf8');
      const record = JSON.parse(raw);
      this._index.set(id, record);
      return record;
    } catch (_err) {
      return null;
    }
  }

  /** Lightweight index of every known checkpoint (no full snapshot payload). */
  list() {
    return Array.from(this._index.values())
      .map((r) => ({ id: r.id, savedAt: r.savedAt, meta: r.meta, step: r.snapshot.step, state: r.snapshot.state }))
      .sort((a, b) => a.savedAt - b.savedAt);
  }

  /** Most recently saved checkpoint record, or null. */
  latest() {
    const all = this.list();
    if (!all.length) return null;
    return this._index.get(all[all.length - 1].id);
  }

  /** Load every *.json checkpoint file from `dir` into the in-memory index (e.g. after a process restart). */
  async loadFromDisk() {
    if (!this.dir) return 0;
    await this._ready;
    let files;
    try {
      files = (await readdir(this.dir)).filter((f) => f.endsWith('.json'));
    } catch (_err) {
      return 0;
    }
    let loaded = 0;
    for (const file of files) {
      try {
        const raw = await readFile(join(this.dir, file), 'utf8');
        const record = JSON.parse(raw);
        if (record && record.id) {
          this._index.set(record.id, record);
          loaded += 1;
        }
      } catch (err) {
        log.warn('loadFromDisk:parse_failed', { file, error: err.message });
      }
    }
    log.info('loadFromDisk', { dir: this.dir, loaded });
    return loaded;
  }

  /** Remove a checkpoint from memory and (if persisted) disk. */
  async delete(id) {
    this._index.delete(id);
    if (this.dir) {
      try {
        await rm(join(this.dir, `${id}.json`), { force: true });
      } catch (_err) {
        // best-effort
      }
    }
  }

  _evictIfNeeded() {
    if (this._index.size <= this.maxInMemory) return;
    const oldestFirst = this.list();
    const toEvict = oldestFirst.slice(0, this._index.size - this.maxInMemory);
    for (const { id } of toEvict) this._index.delete(id); // disk copy, if any, is left alone
  }
}

export default CheckpointManager;
