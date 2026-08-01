/**
 * planning/spec.js — PRD / Spec document model for the Planner stage
 * -----------------------------------------------------------------
 * Implements the Planner half of the Planner-Executor pattern:
 *
 *   PLANNER (reasoner step 1): reads user request -> writes SPEC.md
 *       Components, files, data model, API surface, tests, dependencies.
 *   EXECUTOR (reasoner steps 2..N): reads SPEC.md -> implements file-by-file,
 *       updating TODO.md and verifying as it goes.
 *
 * The Spec object mirrors a real PRD:
 *   - goal           one-paragraph restatement of the user's request
 *   - components     list of logical components/modules
 *   - files          concrete file list with purpose, inputs, outputs, status
 *   - dataModel      schema for any DB / storage / config
 *   - api            endpoints / function signatures
 *   - tests          test plan per component
 *   - dependencies   external packages / env vars required
 *   - acceptance     pass/fail criteria for "done"
 *
 * The spec is serialized to SPEC.md in the workspace so the user can read
 * or edit it. The Executor is required (by the system prompt + TODO gate)
 * to follow it file-by-file.
 *
 * Pure JavaScript (ES modules).
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createLogger } from '../core/logger.js';

const log = createLogger('spec');

export const SpecStatus = Object.freeze({
  PLANNED: 'planned',
  IN_PROGRESS: 'in_progress',
  IMPLEMENTED: 'implemented',
  VERIFIED: 'verified',
  SKIPPED: 'skipped',
});

export class Spec {
  /**
   * @param {Object} [opts]
   * @param {string} [opts.filePath='SPEC.md']
   * @param {string} [opts.rootDir] workspace root
   * @param {boolean} [opts.autoSave=true]
   */
  constructor(opts = {}) {
    this.rootDir = opts.rootDir || process.cwd();
    this.filePath = opts.filePath || 'SPEC.md';
    this.autoSave = opts.autoSave !== false;
    this._loaded = false;
    this._reset();
  }

  _reset() {
    this.goal = '';
    this.components = [];   // [{id,name,description,status}]
    this.files = [];        // [{id,path,purpose,exports,dependsOn,status}]
    this.dataModel = [];    // [{name,shape,notes}]
    this.api = [];          // [{name,signature,description,file}]
    this.tests = [];        // [{id,target,type,command,status}]
    this.dependencies = []; // [{name,version?,purpose}]
    this.envVars = [];      // [{name,purpose,default?,required?}]
    this.acceptance = [];   // [string criteria]
    this.notes = '';
    this.createdAt = null;
    this.updatedAt = null;
    this.plannerComplete = false;
  }

  get absolutePath() {
    return path.isAbsolute(this.filePath) ? this.filePath : path.resolve(this.rootDir, this.filePath);
  }

  /**
   * Create a fresh spec from the Planner's output. Called after the Planner
   * agent decomposes the user request.
   * @param {Object} data
   */
  async create(data = {}) {
    this._reset();
    this.goal = String(data.goal || '');
    this.components = (data.components || []).map((c, i) => ({
      id: String(c.id || `comp_${i + 1}`),
      name: String(c.name || c.title || `Component ${i + 1}`),
      description: String(c.description || ''),
      status: SpecStatus.PLANNED,
    }));
    this.files = (data.files || []).map((f, i) => ({
      id: String(f.id || `file_${i + 1}`),
      path: String(f.path || ''),
      purpose: String(f.purpose || ''),
      exports: Array.isArray(f.exports) ? f.exports : (f.exports ? [String(f.exports)] : []),
      dependsOn: Array.isArray(f.dependsOn) ? f.dependsOn : [],
      status: SpecStatus.PLANNED,
    }));
    this.dataModel = (data.dataModel || []).map((m, i) => ({
      id: String(m.id || `model_${i + 1}`),
      name: String(m.name || `Model ${i + 1}`),
      shape: String(m.shape || ''),
      notes: String(m.notes || ''),
    }));
    this.api = (data.api || []).map((a, i) => ({
      id: String(a.id || `api_${i + 1}`),
      name: String(a.name || a.endpoint || `API ${i + 1}`),
      signature: String(a.signature || ''),
      description: String(a.description || ''),
      file: String(a.file || ''),
      status: SpecStatus.PLANNED,
    }));
    this.tests = (data.tests || []).map((t, i) => ({
      id: String(t.id || `test_${i + 1}`),
      target: String(t.target || ''),
      type: String(t.type || 'unit'),
      command: String(t.command || ''),
      status: SpecStatus.PLANNED,
    }));
    this.dependencies = (data.dependencies || []).map((d) => ({
      name: String(d.name || d.package || ''),
      version: d.version ? String(d.version) : '',
      purpose: String(d.purpose || ''),
    })).filter((d) => d.name);
    this.envVars = (data.envVars || []).map((e) => ({
      name: String(e.name || ''),
      purpose: String(e.purpose || ''),
      default: e.default != null ? String(e.default) : '',
      required: !!e.required,
    })).filter((e) => e.name);
    this.acceptance = (data.acceptance || []).map((a) => String(a));
    this.notes = String(data.notes || '');
    this.createdAt = new Date().toISOString();
    this.updatedAt = this.createdAt;
    this.plannerComplete = true;
    this._loaded = true;
    if (this.autoSave) await this.save();
    log.info('spec:create', { goal: this.goal.slice(0, 80), files: this.files.length, components: this.components.length });
    return this.summary();
  }

  /** Mark the Planner stage done (if spec was built incrementally). */
  async finalizePlanner() {
    this.plannerComplete = true;
    this.updatedAt = new Date().toISOString();
    if (this.autoSave) await this.save();
    return this.summary();
  }

  _findFile(predicate) {
    const key = String(predicate);
    return this.files.find((f) => f.id === key || f.path === key) || null;
  }

  /** Update a file entry (status, notes, etc.). */
  async updateFile(fileIdOrPath, patch = {}) {
    const f = this._findFile(fileIdOrPath);
    if (!f) throw new Error(`Spec file not found: "${fileIdOrPath}"`);
    if (patch.status && Object.values(SpecStatus).includes(patch.status)) f.status = patch.status;
    if (patch.purpose) f.purpose = String(patch.purpose);
    if (Array.isArray(patch.exports)) f.exports = patch.exports;
    this.updatedAt = new Date().toISOString();
    if (this.autoSave) await this.save();
    return this.summary();
  }

  /** Get next file(s) the Executor should implement (planned + deps satisfied). */
  nextFiles() {
    const done = new Set(this.files.filter((f) => f.status === SpecStatus.IMPLEMENTED || f.status === SpecStatus.VERIFIED || f.status === SpecStatus.SKIPPED).map((f) => f.id));
    return this.files.filter((f) => {
      if (f.status !== SpecStatus.PLANNED && f.status !== SpecStatus.IN_PROGRESS) return false;
      return (f.dependsOn || []).every((d) => done.has(String(d)));
    });
  }

  /** Can we call the task done? Every non-skipped file implemented+verified, tests ran. */
  canFinish() {
    const undoneFiles = this.files.filter((f) => f.status !== SpecStatus.IMPLEMENTED && f.status !== SpecStatus.VERIFIED && f.status !== SpecStatus.SKIPPED);
    const undoneTests = this.tests.filter((t) => t.status !== SpecStatus.VERIFIED && t.status !== SpecStatus.SKIPPED);
    if (undoneFiles.length === 0 && undoneTests.length === 0) return { ok: true };
    return {
      ok: false,
      undoneFiles: undoneFiles.map((f) => ({ id: f.id, path: f.path, status: f.status })),
      undoneTests: undoneTests.map((t) => ({ id: t.id, target: t.target, command: t.command })),
      nextFiles: this.nextFiles().slice(0, 5).map((f) => ({ id: f.id, path: f.path })),
    };
  }

  /** Human-readable summary for tool responses / injection into context. */
  summary() {
    const totalFiles = this.files.length;
    const doneFiles = this.files.filter((f) => f.status === SpecStatus.IMPLEMENTED || f.status === SpecStatus.VERIFIED).length;
    const verifiedFiles = this.files.filter((f) => f.status === SpecStatus.VERIFIED).length;
    const totalTests = this.tests.length;
    const doneTests = this.tests.filter((t) => t.status === SpecStatus.VERIFIED).length;
    const pct = totalFiles > 0 ? Math.round((doneFiles / totalFiles) * 100) : 0;
    return {
      path: this.absolutePath,
      goal: this.goal,
      plannerComplete: this.plannerComplete,
      counts: {
        components: this.components.length,
        files: totalFiles,
        filesDone: doneFiles,
        filesVerified: verifiedFiles,
        tests: totalTests,
        testsPassing: doneTests,
        dependencies: this.dependencies.length,
        acceptanceCriteria: this.acceptance.length,
      },
      progressPct: pct,
      nextFiles: this.nextFiles().slice(0, 5),
      canFinish: this.canFinish().ok,
      files: this.files.map((f) => ({ ...f })),
      components: this.components.map((c) => ({ ...c })),
      tests: this.tests.map((t) => ({ ...t })),
    };
  }

  /** Has a spec been created yet? */
  exists() {
    return this._loaded && !!this.goal && this.files.length > 0;
  }

  // --- Serialization to / from SPEC.md --------------------------------------

  /** Serialize to markdown (SPEC.md). */
  serialize() {
    const L = [];
    L.push(`# SPEC — ${this.goal.split('\n')[0].slice(0, 80) || 'Project'}`);
    L.push('');
    if (this.notes) { L.push(`> ${this.notes.replace(/\n/g, '\n> ')}`); L.push(''); }
    L.push(`_Created: ${this.createdAt || '-'} · Updated: ${this.updatedAt || '-'}_`);
    L.push('');

    L.push('## Goal');
    L.push(this.goal || '_not set_');
    L.push('');

    L.push('## Components');
    if (this.components.length === 0) {
      L.push('_none defined_');
    } else {
      for (const c of this.components) L.push(`- **[${c.id}] ${c.name}** — ${c.description} _(${c.status})_`);
    }
    L.push('');

    L.push('## Files');
    if (this.files.length === 0) {
      L.push('_none defined_');
    } else {
      L.push('| ID | Path | Purpose | Exports | Depends on | Status |');
      L.push('|----|------|---------|---------|------------|--------|');
      for (const f of this.files) {
        L.push(`| ${f.id} | \`${f.path}\` | ${(f.purpose || '').slice(0, 60)} | ${(f.exports || []).join(', ') || '-'} | ${(f.dependsOn || []).join(', ') || '-'} | ${f.status} |`);
      }
    }
    L.push('');

    if (this.dataModel.length) {
      L.push('## Data Model');
      for (const m of this.dataModel) L.push(`- **${m.name}** — ${m.shape}${m.notes ? ` _(${m.notes})_` : ''}`);
      L.push('');
    }

    if (this.api.length) {
      L.push('## API');
      for (const a of this.api) L.push(`- **${a.name}** \`${a.signature}\` — ${a.description}${a.file ? ` _(in ${a.file})_` : ''}`);
      L.push('');
    }

    L.push('## Tests');
    if (this.tests.length === 0) {
      L.push('_none defined_');
    } else {
      for (const t of this.tests) L.push(`- **[${t.id}]** \`${t.command || t.type}\` → ${t.target} _(${t.status})_`);
    }
    L.push('');

    if (this.dependencies.length) {
      L.push('## Dependencies');
      for (const d of this.dependencies) L.push(`- \`${d.name}${d.version ? '@' + d.version : ''}\` — ${d.purpose}`);
      L.push('');
    }

    if (this.envVars.length) {
      L.push('## Environment Variables');
      for (const e of this.envVars) L.push(`- \`${e.name}\`${e.required ? ' **(required)**' : ''} — ${e.purpose}${e.default ? ` _(default: ${e.default})_` : ''}`);
      L.push('');
    }

    if (this.acceptance.length) {
      L.push('## Acceptance Criteria');
      for (const a of this.acceptance) L.push(`- [ ] ${a}`);
      L.push('');
    }

    return L.join('\n') + '\n';
  }

  async save() {
    await fs.mkdir(path.dirname(this.absolutePath), { recursive: true });
    await fs.writeFile(this.absolutePath, this.serialize(), 'utf8');
    log.info('spec:save', { path: this.absolutePath });
  }

  // Minimal parser — we intentionally don't round-trip every field from
  // markdown because the in-memory model is the source of truth while the
  // agent is running; load() is just for cross-process resume / user edits.
  async load() {
    try {
      const raw = await fs.readFile(this.absolutePath, 'utf8');
      // Best-effort: just check if a spec exists; don't fully parse. The
      // agent will see it on disk via read_file if it needs to re-read.
      this._loaded = true;
      if (!this.goal) {
        const firstH1 = raw.match(/^#\s+SPEC\s*[—-]\s*(.+)$/m);
        if (firstH1) this.goal = firstH1[1].trim();
        this.plannerComplete = /^## Files/m.test(raw);
      }
    } catch (err) {
      if (err.code !== 'ENOENT') log.warn('spec:load_failed', { error: err.message });
      this._loaded = true;
    }
    return this.summary();
  }
}

let _default = null;
export function getDefaultSpec(rootDir) {
  if (!_default) _default = new Spec({ rootDir: rootDir || process.cwd() });
  return _default;
}
export function resetDefaultSpec() { _default = null; }

export default Spec;
