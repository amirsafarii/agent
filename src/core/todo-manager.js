/**
 * core/todo-manager.js — TODO.md Task Checklist Manager
 * ---------------------------------------------------
 * Enforces the iron-clad rule: the agent may NOT finish (final answer /
 * termination) until every item on its TODO checklist is ticked [x], verified,
 * and tested. The TODO lives as a real TODO.md file in the workspace so the
 * user can inspect it at any time, AND as an in-memory model the loop can
 * query on every step.
 *
 * Format (one checklist item per line):
 *   - [ ] 1.3 Wire TODO gate into AgentLoop: block FINAL until all items are [x] + tested
 *   - [x] 1.1 Create todo-manager.js
 *
 * Each item additionally tracks:
 *   - id           short stable id (e.g. "1.3" or "phase1:step2")
 *   - text         description
 *   - status       pending | in_progress | completed | skipped
 *   - verified     has a verification step been recorded?
 *   - testPassed   have the relevant tests been confirmed to pass?
 *   - notes        free-form progress notes
 *
 * The loop's stop-condition engine consults `canFinish()` whenever the
 * reasoner emits a {type:'final'} action: if any required item is pending,
 * the final is REJECTED and a system message redirects the reasoner back to
 * the next actionable task. This is the core anti-laziness guard.
 *
 * Pure JavaScript (ES modules). No external deps.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createLogger } from './logger.js';

const log = createLogger('todo');

export const TodoStatus = Object.freeze({
  PENDING: 'pending',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  SKIPPED: 'skipped',
});

/**
 * Regex matching a markdown checklist line. Captures:
 *   1. leading spaces (indentation, for future nested-list support)
 *   2. 'x' / 'X' / ' ' (checkbox state)
 *   3. text after the bracket
 * Accepts both "- [ ] text" and "* [ ] text" bullets.
 */
const CHECKBOX_RE = /^(\s*)[-*]\s+\[([ xX])\]\s+(.*)$/;

/**
 * Extract an item id from the start of a task description.
 * Accepts forms like:
 *   "1.3 Wire TODO gate ..."
 *   "Phase1: Wire TODO gate ..."
 *   "[FOO-123] Wire ..."
 * Falls back to a generated id based on index.
 */
function extractId(text, idx) {
  const m = text.match(/^(?:(\d+(?:\.\d+)*)\s+|([A-Za-z][\w-]*:\s*)|(?:\[([A-Z]+-\d+)\]\s*))/);
  if (m) return (m[1] || m[2]?.trim().replace(/:$/, '') || m[3]);
  return `task_${idx + 1}`;
}

export class TodoManager {
  /**
   * @param {Object} [opts]
   * @param {string} [opts.filePath='TODO.md'] path (relative to workspace root)
   * @param {string} [opts.rootDir] sandbox root / workspace dir for resolution
   * @param {boolean} [opts.autoSave=true] persist to disk on every mutation
   */
  constructor(opts = {}) {
    this.rootDir = opts.rootDir || process.cwd();
    this.filePath = opts.filePath || 'TODO.md';
    this.autoSave = opts.autoSave !== false;
    this.items = [];
    this._header = ''; // free-form header text before the first checklist item
    this._loaded = false;
  }

  /** Absolute path to the TODO file on disk. */
  get absolutePath() {
    return path.isAbsolute(this.filePath) ? this.filePath : path.resolve(this.rootDir, this.filePath);
  }

  /** Parse a TODO.md string into items + header. */
  parse(content) {
    const lines = String(content || '').split(/\r?\n/);
    const items = [];
    const headerLines = [];
    let headerDone = false;

    for (const line of lines) {
      const m = line.match(CHECKBOX_RE);
      if (m) {
        headerDone = true;
        const checked = m[2].toLowerCase() === 'x';
        const text = m[3].trim();
        items.push({
          id: extractId(text, items.length),
          text,
          status: checked ? TodoStatus.COMPLETED : TodoStatus.PENDING,
          verified: false,
          testPassed: false,
          notes: '',
        });
      } else if (!headerDone) {
        headerLines.push(line);
      }
    }

    // If file exists but has zero checkbox items, treat the whole body as
    // the header (the tools will populate items immediately).
    return {
      header: headerLines.join('\n').trimEnd(),
      items,
    };
  }

  /** Serialize items back to TODO.md markdown. */
  serialize() {
    const lines = [];
    if (this._header) lines.push(this._header, '');
    for (const it of this.items) {
      const mark = it.status === TodoStatus.COMPLETED ? 'x' : ' ';
      const tag = it.verified && it.testPassed ? ' ✅' : (it.verified ? ' 🔍' : '');
      const skip = it.status === TodoStatus.SKIPPED ? ' _(skipped)_' : '';
      lines.push(`- [${mark}] ${it.text}${tag}${skip}`);
    }
    return lines.join('\n') + '\n';
  }

  /** Load TODO.md from disk. Idempotent — safe to call multiple times.
   *  Note: auto-loading from disk is opt-in via `{autoLoad: true}` — by
   *  default a fresh TodoManager starts empty (so an unrelated TODO.md
   *  left in the workspace from a prior session does not block a new run).
   *  The todo_create tool overwrites the file explicitly when the agent
   *  starts a new checklist.
   */
  async load({ force = false } = {}) {
    // Never auto-load into a manager that already has in-memory items from
    // this session — that would overwrite work in progress.
    if (this._loaded && this.items.length > 0 && !force) {
      return this.summary();
    }
    try {
      const raw = await fs.readFile(this.absolutePath, 'utf8');
      const { header, items } = this.parse(raw);
      // If the file on disk looks like a prior session's TODO (no items
      // matching our current session), start fresh rather than loading
      // unrelated items. We use a simple heuristic: load only if the
      // caller explicitly forces it. The todo_status tool will force a
      // load if no items exist in memory, so the user can resume a TODO.
      if (!force && items.length > 0) {
        // Don't auto-inherit a prior TODO.md; start fresh. Callers that
        // want to resume must pass force:true or call todo_create to overwrite.
        this._header = `# TODO — ${new Date().toISOString().slice(0, 10)}\n\nTasks for this session. The agent will NOT finish until every item is ticked [x], verified, and tested.`;
        this.items = [];
        this._loaded = true;
        log.info('todo:load_skip_existing', { path: this.absolutePath, existingItems: items.length });
        return this.summary();
      }
      this._header = header || `# TODO — ${new Date().toISOString().slice(0, 10)}`;
      // Preserve existing verified/testPassed flags when reloading, by id.
      const prev = new Map(this.items.map((i) => [i.id, i]));
      this.items = items.map((i) => ({
        ...i,
        verified: prev.get(i.id)?.verified ?? false,
        testPassed: prev.get(i.id)?.testPassed ?? false,
        notes: prev.get(i.id)?.notes ?? '',
      }));
      this._loaded = true;
      log.info('todo:load', { path: this.absolutePath, items: this.items.length });
    } catch (err) {
      if (err.code === 'ENOENT') {
        this._header = `# TODO — ${new Date().toISOString().slice(0, 10)}\n\nTasks for this session. The agent will NOT finish until every item is ticked [x], verified, and tested.`;
        this.items = [];
        this._loaded = true;
        log.info('todo:load_empty', { path: this.absolutePath });
      } else {
        log.warn('todo:load_failed', { error: err.message });
        throw err;
      }
    }
    return this.summary();
  }

  /** Save to disk (unless autoSave is disabled). */
  async save() {
    const body = this.serialize();
    await fs.mkdir(path.dirname(this.absolutePath), { recursive: true });
    await fs.writeFile(this.absolutePath, body, 'utf8');
    log.info('todo:save', { path: this.absolutePath, items: this.items.length });
    return body;
  }

  /**
   * Create a fresh TODO list (overwriting any existing one). Used for the
   * mandatory first step.
   * @param {string} title session / goal title
   * @param {Array<{id?:string, text:string, status?:string}>} items
   */
  async create(title, items = []) {
    this._header = `# TODO — ${title || 'Session tasks'}\n\nThe agent will NOT produce a final answer until every item below is ticked [x], verified (file/command/syntax checks ran), and tested.`;
    this.items = items.map((it, idx) => ({
      id: String(it.id || extractId(it.text, idx)),
      text: String(it.text),
      status: TodoStatus.PENDING,
      verified: false,
      testPassed: false,
      notes: '',
    }));
    if (this.autoSave) await this.save();
    log.info('todo:create', { title, items: this.items.length });
    return this.summary();
  }

  /** Find an item by id (case-insensitive) or by index. */
  _find(idOrIndex) {
    const key = String(idOrIndex).trim();
    let item = this.items.find((i) => String(i.id).toLowerCase() === key.toLowerCase());
    if (!item) {
      const n = Number(key);
      if (Number.isInteger(n) && n > 0 && n <= this.items.length) item = this.items[n - 1];
    }
    return item || null;
  }

  /** Tick a task as complete (+ optionally verify / mark tests passed). */
  async tick(idOrIndex, { verified, testPassed, notes } = {}) {
    const item = this._find(idOrIndex);
    if (!item) throw new Error(`TODO item not found: "${idOrIndex}"`);
    item.status = TodoStatus.COMPLETED;
    if (verified === true) item.verified = true;
    if (testPassed === true) item.testPassed = true;
    if (notes) item.notes = notes;
    if (this.autoSave) await this.save();
    return this.summary();
  }

  /** Mark a task as started (in-progress). */
  async start(idOrIndex, { notes } = {}) {
    const item = this._find(idOrIndex);
    if (!item) throw new Error(`TODO item not found: "${idOrIndex}"`);
    item.status = TodoStatus.IN_PROGRESS;
    if (notes) item.notes = notes;
    if (this.autoSave) await this.save();
    return this.summary();
  }

  /** Mark item verified (deterministic check ran and passed). */
  async markVerified(idOrIndex) {
    const item = this._find(idOrIndex);
    if (!item) throw new Error(`TODO item not found: "${idOrIndex}"`);
    item.verified = true;
    if (this.autoSave) await this.save();
    return this.summary();
  }

  /** Mark item tested (relevant tests passed). */
  async markTested(idOrIndex) {
    const item = this._find(idOrIndex);
    if (!item) throw new Error(`TODO item not found: "${idOrIndex}"`);
    item.testPassed = true;
    if (this.autoSave) await this.save();
    return this.summary();
  }

  /** Un-tick a task (return to pending). */
  async untick(idOrIndex, { reason } = {}) {
    const item = this._find(idOrIndex);
    if (!item) throw new Error(`TODO item not found: "${idOrIndex}"`);
    item.status = TodoStatus.PENDING;
    item.verified = false;
    item.testPassed = false;
    if (reason) item.notes = (item.notes ? item.notes + ' | ' : '') + `reopened: ${reason}`;
    if (this.autoSave) await this.save();
    return this.summary();
  }

  /** Skip a task. */
  async skip(idOrIndex, { reason } = {}) {
    const item = this._find(idOrIndex);
    if (!item) throw new Error(`TODO item not found: "${idOrIndex}"`);
    item.status = TodoStatus.SKIPPED;
    if (reason) item.notes = reason;
    if (this.autoSave) await this.save();
    return this.summary();
  }

  /** Append new tasks to the checklist (for dynamically-discovered work). */
  async add(items) {
    const list = Array.isArray(items) ? items : [items];
    const added = list.map((it, idx) => ({
      id: String(it.id || extractId(it.text || String(it), this.items.length + idx)),
      text: String(it.text || it),
      status: TodoStatus.PENDING,
      verified: false,
      testPassed: false,
      notes: '',
    }));
    this.items.push(...added);
    if (this.autoSave) await this.save();
    return this.summary();
  }

  /**
   * THE GATE: can the agent emit a final answer right now?
   * Returns {ok: true} if every non-skipped item is completed+verified+tested,
   * otherwise {ok: false, blocking:[...], nextActionable:[...]} describing
   * exactly what still needs to be done — injected as a system message to
   * redirect the reasoner.
   */
  canFinish() {
    const blocking = [];
    const nextActionable = [];
    for (const it of this.items) {
      if (it.status === TodoStatus.SKIPPED) continue;
      if (it.status !== TodoStatus.COMPLETED) {
        blocking.push({ id: it.id, text: it.text, reason: 'not completed', status: it.status });
        if (it.status === TodoStatus.PENDING || it.status === TodoStatus.IN_PROGRESS) {
          nextActionable.push({ id: it.id, text: it.text, status: it.status });
        }
        continue;
      }
      if (!it.verified) {
        blocking.push({ id: it.id, text: it.text, reason: 'completed but not verified (no verify_* check passed yet)' });
        nextActionable.push({ id: it.id, text: it.text, action: 'verify' });
      } else if (!it.testPassed) {
        // Code / implementation tasks should be tested; docs-only tasks can
        // opt out by marking testPassed themselves via tick(testPassed:true).
        // We only block when the task text looks like implementation work.
        const looksLikeCode = /\b(file|code|implement|function|module|class|api|route|test|build|feature|tool)\b/i.test(it.text);
        if (looksLikeCode) {
          blocking.push({ id: it.id, text: it.text, reason: 'completed and verified but no passing test recorded' });
          nextActionable.push({ id: it.id, text: it.text, action: 'test' });
        }
      }
    }
    if (blocking.length === 0) return { ok: true };
    return {
      ok: false,
      blockingCount: blocking.length,
      blocking,
      nextActionable: nextActionable.slice(0, 5),
      message: [
        `[TODO gate] Cannot finish yet: ${blocking.length} item(s) still pending.`,
        ...nextActionable.slice(0, 5).map((a) => `  → ${a.id}: ${a.text}${a.action ? ` [${a.action}]` : ''}`),
        'You must execute, verify, and test these before producing a final answer.',
      ].join('\n'),
    };
  }

  /** Is there any checklist at all? (Used to decide if first-step bootstrapping is needed.) */
  isEmpty() {
    return this.items.length === 0;
  }

  /**
   * Current progress summary (returned by every mutation and by status()).
   * IMPORTANT: `canFinish` here MUST agree with the canFinish() method — both
   * use the same `looksLikeCode` heuristic to decide if a completed+verified
   * item needs tests. This prevents contradictory signals to the reasoner.
   */
  summary() {
    const total = this.items.length;
    const completed = this.items.filter((i) => i.status === TodoStatus.COMPLETED).length;
    const skipped = this.items.filter((i) => i.status === TodoStatus.SKIPPED).length;
    const inProgress = this.items.filter((i) => i.status === TodoStatus.IN_PROGRESS).length;
    const pending = this.items.filter((i) => i.status === TodoStatus.PENDING).length;
    const unverified = this.items.filter((i) => i.status === TodoStatus.COMPLETED && !i.verified).length;
    // Only count code-like tasks as "untested" to match canFinish() behavior.
    const untested = this.items.filter((i) => {
      if (i.status !== TodoStatus.COMPLETED || !i.verified || i.testPassed) return false;
      return /\b(file|code|implement|function|module|class|api|route|test|build|feature|tool)\b/i.test(i.text);
    }).length;
    const pct = total > 0 ? Math.round(((completed + skipped) / total) * 100) : 0;
    // Use the actual canFinish() method to ensure consistency.
    const canFinishResult = this.canFinish();
    return {
      path: this.absolutePath,
      total,
      completed,
      skipped,
      inProgress,
      pending,
      unverified,
      untested,
      percentage: pct,
      canFinish: canFinishResult.ok,
      nextActionable: this._nextActionable().slice(0, 5),
      items: this.items.map((i) => ({ ...i })),
    };
  }

  _nextActionable() {
    const out = [];
    for (const it of this.items) {
      if (it.status === TodoStatus.COMPLETED) {
        if (!it.verified) { out.push({ id: it.id, text: it.text, action: 'verify' }); continue; }
        const looksLikeCode = /\b(file|code|implement|function|module|class|api|route|test|build|feature|tool)\b/i.test(it.text);
        if (looksLikeCode && !it.testPassed) out.push({ id: it.id, text: it.text, action: 'test' });
      } else if (it.status === TodoStatus.PENDING || it.status === TodoStatus.IN_PROGRESS) {
        out.push({ id: it.id, text: it.text, action: it.status });
      }
    }
    return out;
  }
}

/** Module-level default instance (shared across the process). */
let _default = null;
export function getDefaultTodoManager(rootDir) {
  if (!_default) _default = new TodoManager({ rootDir: rootDir || process.cwd() });
  return _default;
}
export function resetDefaultTodoManager() { _default = null; }

export default TodoManager;
