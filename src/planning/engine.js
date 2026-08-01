/**
 * planning/engine.js — Planning Engine for ScrappyAi
 * ------------------------------------------------
 * Manages structured multi-step plans and subtask tracking for agent runs.
 *
 * Task is a first-class model (see task.js), separate from Run:
 *   Run  └── Task  ├── SubTask ...
 *
 * Each task has:
 *   id, goal, title, status, dependencies, inputs, outputs,
 *   attempts, startedAt, finishedAt, error, artifacts
 *
 * Pure JavaScript (ES modules).
 */

import { randomUUID } from 'node:crypto';
import { createLogger } from '../core/logger.js';
import { Task, TaskStatus, Run } from './task.js';
import { DAG } from './dag.js';

export { DAG } from './dag.js';
export { GoalDecomposer } from './goal-decomposer.js';
export { TaskTree } from './task-tree.js';
export { DAGExecutor } from './dag-executor.js';
export { ParallelExecutor, parallel } from './parallel-executor.js';
export { Task, TaskStatus, Run } from './task.js';

const log = createLogger('planning');

/** Map legacy status names onto TaskStatus. */
const STATUS_ALIASES = Object.freeze({
  pending: TaskStatus.PENDING,
  ready: TaskStatus.READY,
  in_progress: TaskStatus.RUNNING,
  running: TaskStatus.RUNNING,
  blocked: TaskStatus.BLOCKED,
  completed: TaskStatus.COMPLETED,
  failed: TaskStatus.FAILED,
  skipped: TaskStatus.SKIPPED,
  cancelled: TaskStatus.CANCELLED,
});

function normalizeStatus(status) {
  if (!status) return TaskStatus.PENDING;
  const key = String(status).toLowerCase();
  if (STATUS_ALIASES[key]) return STATUS_ALIASES[key];
  if (Object.values(TaskStatus).includes(status)) return status;
  return null;
}

export class PlanningEngine {
  constructor() {
    /** @type {Map<string, Object>} */
    this.plans = new Map();
    this.activePlanId = null;
    /** @type {Map<string, Run>} runs keyed by id — separate from tasks */
    this.runs = new Map();
    this.activeRunId = null;
  }

  /**
   * Open a new Run (one agent.run() invocation). Tasks created afterward
   * can be attached to it.
   * @param {Object} [opts]
   * @param {string} [opts.input]
   * @param {string} [opts.sessionId]
   * @param {Object} [opts.metadata]
   * @returns {Run}
   */
  startRun(opts = {}) {
    const run = new Run(opts);
    run.start();
    this.runs.set(run.id, run);
    this.activeRunId = run.id;
    log.info('startRun', { runId: run.id, input: run.input });
    return run;
  }

  /** @param {string} [runId] */
  getRun(runId) {
    const id = runId || this.activeRunId;
    return id ? this.runs.get(id) || null : null;
  }

  /**
   * Create a new plan.
   * @param {Object} params
   * @param {string} params.title
   * @param {string} [params.description]
   * @param {Array<Object>} [params.tasks]
   * @param {string} [params.runId] attach plan's tasks to this Run
   * @param {boolean} [params.requiresApproval] gate the whole plan
   * @returns {Object} plan summary
   */
  createPlan({ title, description = '', tasks = [], runId = null, requiresApproval = false }) {
    if (!title || typeof title !== 'string') {
      throw new Error('Plan title is required.');
    }

    const planId = `plan_${Date.now()}_${randomUUID().slice(0, 6)}`;
    const owningRunId = runId || this.activeRunId || null;

    const formattedTasks = tasks.map((t, idx) => this._toTask(t, idx, { planId, runId: owningRunId }));

    const plan = {
      id: planId,
      title: title.trim(),
      description: description.trim(),
      tasks: formattedTasks,
      runId: owningRunId,
      requiresApproval: !!requiresApproval,
      approvalStatus: requiresApproval ? 'pending' : 'granted', // pending|granted|denied
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.plans.set(planId, plan);
    this.activePlanId = planId;

    // Mirror tasks onto the Run if one is active.
    if (owningRunId && this.runs.has(owningRunId)) {
      const run = this.runs.get(owningRunId);
      for (const task of formattedTasks) run.tasks.push(task);
    }

    log.info('createPlan', { planId, title: plan.title, taskCount: formattedTasks.length, runId: owningRunId });
    return this.getPlanSummary(planId);
  }

  /**
   * Get current or specific plan by ID.
   * @param {string} [planId] defaults to activePlanId
   * @returns {Object|null}
   */
  getPlan(planId) {
    const id = planId || this.activePlanId;
    if (!id || !this.plans.has(id)) return null;
    return this.plans.get(id);
  }

  /**
   * Approve or deny an entire plan (plan-level approval).
   * @param {string} planId
   * @param {boolean} approved
   * @param {string} [reason]
   */
  setPlanApproval(planId, approved, reason = null) {
    const plan = this.getPlan(planId);
    if (!plan) throw new Error('Plan not found.');
    plan.approvalStatus = approved ? 'granted' : 'denied';
    plan.approvalReason = reason;
    plan.updatedAt = new Date().toISOString();
    log.info('setPlanApproval', { planId: plan.id, approved, reason });
    return this.getPlanSummary(plan.id);
  }

  /**
   * Get calculated summary of a plan with progress stats and actionable tasks.
   * @param {string} [planId]
   * @returns {Object}
   */
  getPlanSummary(planId) {
    const plan = this.getPlan(planId);
    if (!plan) return { error: 'No active plan found.' };

    const tasks = plan.tasks.map((t) => (t instanceof Task ? t : Task.fromJSON(t)));
    // Keep plan.tasks as Task instances going forward.
    plan.tasks = tasks;

    const total = tasks.length;
    const completed = tasks.filter((t) => t.status === TaskStatus.COMPLETED).length;
    const failed = tasks.filter((t) => t.status === TaskStatus.FAILED).length;
    const skipped = tasks.filter((t) => t.status === TaskStatus.SKIPPED).length;
    const cancelled = tasks.filter((t) => t.status === TaskStatus.CANCELLED).length;
    const inProgress = tasks.filter((t) => t.status === TaskStatus.RUNNING || t.status === 'in_progress').length;
    const pending = tasks.filter((t) => t.status === TaskStatus.PENDING || t.status === TaskStatus.READY).length;
    const blocked = tasks.filter((t) => t.status === TaskStatus.BLOCKED).length;

    const completedIds = new Set(
      tasks.filter((t) => [TaskStatus.COMPLETED, TaskStatus.SKIPPED].includes(t.status)).map((t) => t.id)
    );

    // Tasks ready to execute (pending/ready, and all dependencies completed or skipped)
    const nextTasks = tasks.filter((t) => {
      if (![TaskStatus.PENDING, TaskStatus.READY, 'pending'].includes(t.status)) return false;
      const deps = t.dependencies || t.deps || [];
      if (!deps.length) return true;
      return deps.every((depId) => completedIds.has(String(depId)));
    });

    // Mark them ready for observability
    for (const t of nextTasks) {
      if (t.status === TaskStatus.PENDING) t.ready();
    }

    const percentage = total > 0 ? Math.round(((completed + skipped) / total) * 100) : 0;

    return {
      planId: plan.id,
      title: plan.title,
      description: plan.description,
      runId: plan.runId,
      requiresApproval: plan.requiresApproval,
      approvalStatus: plan.approvalStatus,
      progress: {
        total,
        completed,
        failed,
        skipped,
        cancelled,
        inProgress,
        pending,
        blocked,
        percentage,
      },
      nextActionableTasks: nextTasks.map((t) => t.toJSON()),
      tasks: tasks.map((t) => t.toJSON()),
      createdAt: plan.createdAt,
      updatedAt: plan.updatedAt,
    };
  }

  /**
   * Update task status or notes in a plan.
   * @param {Object} params
   * @param {string} params.taskId
   * @param {string} [params.status]
   * @param {string} [params.notes]
   * @param {string} [params.title]
   * @param {string} [params.goal]
   * @param {Object} [params.outputs]
   * @param {string} [params.error]
   * @param {Object} [params.artifact]
   * @param {string} [params.planId]
   * @returns {Object} summary
   */
  updateTask({ taskId, status, notes, title, goal, outputs, error, artifact, planId }) {
    const plan = this.getPlan(planId);
    if (!plan) throw new Error('Plan not found.');

    // Ensure Task instances
    plan.tasks = plan.tasks.map((t) => (t instanceof Task ? t : Task.fromJSON(t)));
    const task = plan.tasks.find((t) => String(t.id) === String(taskId));
    if (!task) throw new Error(`Task "${taskId}" not found in plan "${plan.id}".`);

    if (status) {
      const normalized = normalizeStatus(status);
      if (!normalized) {
        throw new Error(
          `Invalid status "${status}". Must be one of: ${Object.values(TaskStatus).join(', ')} (or legacy in_progress)`
        );
      }
      // Use Task helpers for proper attempt/timestamp bookkeeping where it makes sense.
      if (normalized === TaskStatus.RUNNING && task.status !== TaskStatus.RUNNING) {
        task.start();
      } else if (normalized === TaskStatus.COMPLETED) {
        task.complete(outputs || {});
      } else if (normalized === TaskStatus.FAILED) {
        task.fail(error || task.error || 'failed', { retryable: false });
      } else if (normalized === TaskStatus.SKIPPED) {
        task.skip(notes || error);
      } else if (normalized === TaskStatus.CANCELLED) {
        task.cancel(notes || error || 'cancelled');
      } else if (normalized === TaskStatus.READY) {
        task.ready();
      } else if (normalized === TaskStatus.BLOCKED) {
        task.block(notes);
      } else {
        task.status = normalized;
        task.updatedAt = new Date().toISOString();
      }
    }

    if (typeof notes === 'string') task.notes = notes;
    if (typeof title === 'string' && title.trim()) task.title = title.trim();
    if (typeof goal === 'string' && goal.trim()) task.goal = goal.trim();
    if (outputs && typeof outputs === 'object') task.outputs = { ...task.outputs, ...outputs };
    if (typeof error === 'string' && !status) task.error = error;
    if (artifact) task.addArtifact(artifact);

    plan.updatedAt = new Date().toISOString();
    log.info('updateTask', { planId: plan.id, taskId, status: task.status });

    return this.getPlanSummary(plan.id);
  }

  /**
   * Add new tasks to an existing plan.
   * @param {Object} params
   * @param {Array<Object>} params.tasks
   * @param {string} [params.planId]
   * @returns {Object} summary
   */
  addTasks({ tasks = [], planId }) {
    const plan = this.getPlan(planId);
    if (!plan) throw new Error('Plan not found.');

    plan.tasks = plan.tasks.map((t) => (t instanceof Task ? t : Task.fromJSON(t)));

    const newTasks = tasks.map((t, idx) =>
      this._toTask(t, plan.tasks.length + idx, { planId: plan.id, runId: plan.runId })
    );

    plan.tasks.push(...newTasks);
    plan.updatedAt = new Date().toISOString();

    if (plan.runId && this.runs.has(plan.runId)) {
      const run = this.runs.get(plan.runId);
      for (const task of newTasks) run.tasks.push(task);
    }

    log.info('addTasks', { planId: plan.id, addedCount: newTasks.length });
    return this.getPlanSummary(plan.id);
  }

  /**
   * Add a subtask under an existing task (hierarchical).
   * @param {Object} params
   * @param {string} params.parentId
   * @param {Object} params.task
   * @param {string} [params.planId]
   */
  addSubtask({ parentId, task, planId }) {
    const plan = this.getPlan(planId);
    if (!plan) throw new Error('Plan not found.');
    plan.tasks = plan.tasks.map((t) => (t instanceof Task ? t : Task.fromJSON(t)));
    const parent = plan.tasks.find((t) => String(t.id) === String(parentId));
    if (!parent) throw new Error(`Parent task "${parentId}" not found.`);
    const child = parent.addSubtask(task);
    // Also flatten into plan.tasks for dependency scheduling.
    plan.tasks.push(child);
    plan.updatedAt = new Date().toISOString();
    return this.getPlanSummary(plan.id);
  }

  /** Build a DAG from the active (or given) plan. */
  toDAG(planId) {
    const plan = this.getPlan(planId);
    if (!plan) throw new Error('Plan not found.');
    const dag = new DAG();
    for (const t of plan.tasks) {
      const task = t instanceof Task ? t : Task.fromJSON(t);
      dag.addNode(task.id, task);
    }
    for (const t of plan.tasks) {
      const task = t instanceof Task ? t : Task.fromJSON(t);
      for (const dep of task.dependencies || task.deps || []) {
        dag.addEdge(String(dep), task.id);
      }
    }
    return dag;
  }

  /** Reset all plans and runs. */
  reset() {
    this.plans.clear();
    this.activePlanId = null;
    this.runs.clear();
    this.activeRunId = null;
  }

  _toTask(t, idx, { planId, runId }) {
    if (t instanceof Task) {
      t.planId = t.planId || planId;
      t.runId = t.runId || runId;
      return t;
    }
    const status = normalizeStatus(t.status) || TaskStatus.PENDING;
    return new Task({
      id: String(t.id || idx + 1),
      goal: t.goal || t.title || `Task ${idx + 1}`,
      title: t.title || t.goal || `Task ${idx + 1}`,
      description: t.description ? String(t.description) : '',
      status,
      dependencies: Array.isArray(t.dependencies) ? t.dependencies : Array.isArray(t.deps) ? t.deps : [],
      inputs: t.inputs || {},
      outputs: t.outputs || {},
      attempts: t.attempts || [],
      startedAt: t.startedAt || null,
      finishedAt: t.finishedAt || null,
      error: t.error || null,
      artifacts: t.artifacts || [],
      parentId: t.parentId || null,
      runId,
      planId,
      metadata: { ...(t.metadata || {}), notes: t.notes || '' },
      maxAttempts: t.maxAttempts,
      timeoutMs: t.timeoutMs,
      requiresApproval: !!t.requiresApproval,
    });
  }
}

/** Global default planning engine instance */
export const defaultPlanningEngine = new PlanningEngine();
