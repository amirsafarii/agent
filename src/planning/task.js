/**
 * planning/task.js — first-class Task model (separate from Run)
 * -------------------------------------------------------------
 * A Run is one agent.run() invocation. A Task is a unit of work inside
 * (or across) runs — with its own goal, status, deps, I/O, attempts and
 * artifacts. PlanningEngine, DAG and AgentLoop all speak this shape.
 *
 * Hierarchy:
 *   Run
 *    └── Task
 *         ├── SubTask
 *         ├── SubTask
 *         └── SubTask
 *
 * Pure JavaScript (ES modules).
 */

import { randomUUID } from 'node:crypto';
import { createLogger } from '../core/logger.js';

const log = createLogger('planning:task');

/** Task lifecycle statuses. */
export const TaskStatus = Object.freeze({
  PENDING: 'pending',
  READY: 'ready',
  RUNNING: 'running',
  BLOCKED: 'blocked',
  COMPLETED: 'completed',
  FAILED: 'failed',
  SKIPPED: 'skipped',
  CANCELLED: 'cancelled',
});

const TERMINAL = new Set([
  TaskStatus.COMPLETED,
  TaskStatus.FAILED,
  TaskStatus.SKIPPED,
  TaskStatus.CANCELLED,
]);

/**
 * @typedef {Object} TaskAttempt
 * @property {number} n
 * @property {string} startedAt
 * @property {string} [finishedAt]
 * @property {string} [error]
 * @property {any} [output]
 * @property {number} [durationMs]
 */

/**
 * @typedef {Object} TaskArtifact
 * @property {string} id
 * @property {string} type - 'file' | 'log' | 'data' | 'url' | 'other'
 * @property {string} [path]
 * @property {any} [data]
 * @property {string} [description]
 * @property {string} createdAt
 */

/**
 * First-class Task. Plain-data friendly (toJSON/fromJSON) so it can live
 * inside plans, checkpoints and DAG nodes.
 */
export class Task {
  /**
   * @param {Object} opts
   * @param {string} [opts.id]
   * @param {string} opts.goal - what this task is trying to achieve
   * @param {string} [opts.title] - short label (defaults to goal slice)
   * @param {string} [opts.description]
   * @param {string} [opts.status]
   * @param {string[]} [opts.dependencies] - task ids that must complete first
   * @param {Object} [opts.inputs]
   * @param {Object} [opts.outputs]
   * @param {TaskAttempt[]} [opts.attempts]
   * @param {string} [opts.startedAt]
   * @param {string} [opts.finishedAt]
   * @param {string} [opts.error]
   * @param {TaskArtifact[]} [opts.artifacts]
   * @param {string} [opts.parentId]
   * @param {string} [opts.runId] - owning Run id (separates Task from Run)
   * @param {string} [opts.planId]
   * @param {Object} [opts.metadata]
   * @param {number} [opts.maxAttempts=3]
   * @param {number} [opts.timeoutMs]
   * @param {boolean} [opts.requiresApproval]
   */
  constructor(opts = {}) {
    if (!opts.goal && !opts.title) {
      throw new Error('Task requires a "goal" (or at least a "title").');
    }

    const now = new Date().toISOString();
    this.id = String(opts.id || `task_${randomUUID().slice(0, 8)}`);
    this.goal = String(opts.goal || opts.title);
    this.title = String(opts.title || truncate(this.goal, 80));
    this.description = opts.description ? String(opts.description) : '';
    this.status = Object.values(TaskStatus).includes(opts.status) ? opts.status : TaskStatus.PENDING;
    this.dependencies = Array.isArray(opts.dependencies)
      ? opts.dependencies.map(String)
      : Array.isArray(opts.deps)
        ? opts.deps.map(String)
        : [];
    // Alias kept for PlanningEngine backward-compat
    this.deps = this.dependencies;
    this.inputs = opts.inputs && typeof opts.inputs === 'object' ? { ...opts.inputs } : {};
    this.outputs = opts.outputs && typeof opts.outputs === 'object' ? { ...opts.outputs } : {};
    this.attempts = Array.isArray(opts.attempts) ? opts.attempts.slice() : [];
    this.startedAt = opts.startedAt || null;
    this.finishedAt = opts.finishedAt || null;
    this.error = opts.error || null;
    this.artifacts = Array.isArray(opts.artifacts) ? opts.artifacts.slice() : [];
    this.parentId = opts.parentId ? String(opts.parentId) : null;
    this.runId = opts.runId ? String(opts.runId) : null;
    this.planId = opts.planId ? String(opts.planId) : null;
    this.metadata = opts.metadata && typeof opts.metadata === 'object' ? { ...opts.metadata } : {};
    this.maxAttempts = Number.isFinite(opts.maxAttempts) ? opts.maxAttempts : 3;
    this.timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : null;
    this.requiresApproval = !!opts.requiresApproval;
    this.createdAt = opts.createdAt || now;
    this.updatedAt = opts.updatedAt || now;
    /** @type {Task[]} */
    this.subtasks = Array.isArray(opts.subtasks)
      ? opts.subtasks.map((s) => (s instanceof Task ? s : Task.fromJSON(s)))
      : [];
  }

  get isTerminal() {
    return TERMINAL.has(this.status);
  }

  get attemptCount() {
    return this.attempts.length;
  }

  /** Mark task running and open a new attempt record. */
  start(extra = {}) {
    if (this.isTerminal) {
      throw new Error(`Cannot start task "${this.id}" in terminal status "${this.status}".`);
    }
    this.status = TaskStatus.RUNNING;
    this.startedAt = this.startedAt || new Date().toISOString();
    this.updatedAt = new Date().toISOString();
    this.error = null;
    const attempt = {
      n: this.attempts.length + 1,
      startedAt: this.updatedAt,
      finishedAt: null,
      error: null,
      output: null,
      durationMs: null,
      ...extra,
    };
    this.attempts.push(attempt);
    log.info('task:start', { id: this.id, attempt: attempt.n, goal: this.goal });
    return attempt;
  }

  /** Complete successfully. */
  complete(outputs = {}, artifacts = []) {
    this.status = TaskStatus.COMPLETED;
    this.finishedAt = new Date().toISOString();
    this.updatedAt = this.finishedAt;
    this.outputs = { ...this.outputs, ...outputs };
    if (artifacts.length) this.artifacts.push(...artifacts.map(normalizeArtifact));
    this._closeAttempt({ output: outputs });
    log.info('task:complete', { id: this.id, outputs: Object.keys(this.outputs) });
    return this;
  }

  /** Fail with an error. */
  fail(error, { retryable = true } = {}) {
    const msg = error && error.message ? error.message : String(error || 'unknown error');
    this.error = msg;
    this.updatedAt = new Date().toISOString();
    this._closeAttempt({ error: msg });

    const canRetry = retryable && this.attempts.length < this.maxAttempts;
    if (canRetry) {
      this.status = TaskStatus.PENDING;
      this.finishedAt = null;
      log.warn('task:fail_retryable', { id: this.id, error: msg, attempts: this.attempts.length });
    } else {
      this.status = TaskStatus.FAILED;
      this.finishedAt = this.updatedAt;
      log.error('task:fail', { id: this.id, error: msg, attempts: this.attempts.length });
    }
    return this;
  }

  /** Skip (e.g. dependency failed and policy says skip). */
  skip(reason = null) {
    this.status = TaskStatus.SKIPPED;
    this.finishedAt = new Date().toISOString();
    this.updatedAt = this.finishedAt;
    if (reason) this.error = String(reason);
    log.info('task:skip', { id: this.id, reason });
    return this;
  }

  /** Cancel (AbortSignal / user). */
  cancel(reason = 'cancelled') {
    this.status = TaskStatus.CANCELLED;
    this.finishedAt = new Date().toISOString();
    this.updatedAt = this.finishedAt;
    this.error = String(reason);
    this._closeAttempt({ error: this.error });
    log.info('task:cancel', { id: this.id, reason });
    return this;
  }

  /** Block until dependencies clear. */
  block(reason = null) {
    this.status = TaskStatus.BLOCKED;
    this.updatedAt = new Date().toISOString();
    if (reason) this.metadata.blockReason = String(reason);
    return this;
  }

  /** Mark ready (deps satisfied). */
  ready() {
    if (this.status === TaskStatus.PENDING || this.status === TaskStatus.BLOCKED) {
      this.status = TaskStatus.READY;
      this.updatedAt = new Date().toISOString();
    }
    return this;
  }

  /** Attach an artifact produced by this task. */
  addArtifact(artifact) {
    const a = normalizeArtifact(artifact);
    this.artifacts.push(a);
    this.updatedAt = new Date().toISOString();
    return a;
  }

  /** Add a child subtask. */
  addSubtask(subtaskOpts) {
    const child = subtaskOpts instanceof Task
      ? subtaskOpts
      : new Task({ ...subtaskOpts, parentId: this.id, runId: this.runId, planId: this.planId });
    child.parentId = this.id;
    this.subtasks.push(child);
    this.updatedAt = new Date().toISOString();
    return child;
  }

  /** Set notes (PlanningEngine compat). */
  setNotes(notes) {
    this.metadata.notes = String(notes);
    this.updatedAt = new Date().toISOString();
    return this;
  }

  get notes() {
    return this.metadata.notes || '';
  }

  set notes(v) {
    this.metadata.notes = v == null ? '' : String(v);
  }

  _closeAttempt({ output = null, error = null } = {}) {
    const attempt = this.attempts[this.attempts.length - 1];
    if (!attempt || attempt.finishedAt) return;
    attempt.finishedAt = new Date().toISOString();
    attempt.output = output;
    attempt.error = error;
    attempt.durationMs = Date.parse(attempt.finishedAt) - Date.parse(attempt.startedAt);
  }

  toJSON() {
    return {
      id: this.id,
      goal: this.goal,
      title: this.title,
      description: this.description,
      status: this.status,
      dependencies: this.dependencies.slice(),
      deps: this.dependencies.slice(),
      inputs: { ...this.inputs },
      outputs: { ...this.outputs },
      attempts: this.attempts.map((a) => ({ ...a })),
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      error: this.error,
      artifacts: this.artifacts.map((a) => ({ ...a })),
      parentId: this.parentId,
      runId: this.runId,
      planId: this.planId,
      metadata: { ...this.metadata },
      maxAttempts: this.maxAttempts,
      timeoutMs: this.timeoutMs,
      requiresApproval: this.requiresApproval,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      subtasks: this.subtasks.map((s) => s.toJSON()),
      // PlanningEngine legacy field
      notes: this.notes,
    };
  }

  static fromJSON(data) {
    if (!data || typeof data !== 'object') throw new Error('Task.fromJSON requires an object.');
    return new Task(data);
  }
}

/**
 * A Run is one agent.run() invocation. It owns zero or more Tasks but is
 * intentionally a separate concept — runs have step budgets / signals /
 * context; tasks have goals / deps / artifacts.
 */
export class Run {
  /**
   * @param {Object} [opts]
   * @param {string} [opts.id]
   * @param {string} [opts.input] - original user input
   * @param {string} [opts.sessionId]
   * @param {Object} [opts.metadata]
   */
  constructor(opts = {}) {
    const now = new Date().toISOString();
    this.id = String(opts.id || `run_${randomUUID().slice(0, 8)}`);
    this.input = opts.input != null ? String(opts.input) : null;
    this.sessionId = opts.sessionId || null;
    this.status = opts.status || 'created'; // created|running|completed|failed|aborted|cancelled
    this.startedAt = opts.startedAt || null;
    this.finishedAt = opts.finishedAt || null;
    this.error = opts.error || null;
    this.metadata = opts.metadata && typeof opts.metadata === 'object' ? { ...opts.metadata } : {};
    /** @type {Task[]} top-level tasks belonging to this run */
    this.tasks = Array.isArray(opts.tasks)
      ? opts.tasks.map((t) => (t instanceof Task ? t : Task.fromJSON(t)))
      : [];
    this.createdAt = opts.createdAt || now;
    this.updatedAt = opts.updatedAt || now;
  }

  addTask(taskOpts) {
    const task = taskOpts instanceof Task
      ? taskOpts
      : new Task({ ...taskOpts, runId: this.id });
    task.runId = this.id;
    this.tasks.push(task);
    this.updatedAt = new Date().toISOString();
    return task;
  }

  getTask(id) {
    return this.tasks.find((t) => t.id === String(id)) || null;
  }

  start() {
    this.status = 'running';
    this.startedAt = this.startedAt || new Date().toISOString();
    this.updatedAt = this.startedAt;
    return this;
  }

  complete() {
    this.status = 'completed';
    this.finishedAt = new Date().toISOString();
    this.updatedAt = this.finishedAt;
    return this;
  }

  fail(error) {
    this.status = 'failed';
    this.error = error && error.message ? error.message : String(error || 'unknown');
    this.finishedAt = new Date().toISOString();
    this.updatedAt = this.finishedAt;
    return this;
  }

  abort(reason = 'aborted') {
    this.status = 'aborted';
    this.error = String(reason);
    this.finishedAt = new Date().toISOString();
    this.updatedAt = this.finishedAt;
    for (const t of this.tasks) {
      if (!t.isTerminal) t.cancel(reason);
    }
    return this;
  }

  toJSON() {
    return {
      id: this.id,
      input: this.input,
      sessionId: this.sessionId,
      status: this.status,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      error: this.error,
      metadata: { ...this.metadata },
      tasks: this.tasks.map((t) => t.toJSON()),
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }

  static fromJSON(data) {
    return new Run(data);
  }
}

function normalizeArtifact(a) {
  if (!a || typeof a !== 'object') {
    return {
      id: `art_${randomUUID().slice(0, 6)}`,
      type: 'other',
      data: a,
      createdAt: new Date().toISOString(),
    };
  }
  return {
    id: String(a.id || `art_${randomUUID().slice(0, 6)}`),
    type: a.type || 'other',
    path: a.path || null,
    data: a.data !== undefined ? a.data : null,
    description: a.description || null,
    createdAt: a.createdAt || new Date().toISOString(),
  };
}

function truncate(s, n) {
  const str = String(s);
  return str.length <= n ? str : `${str.slice(0, n - 1)}…`;
}

export default Task;
