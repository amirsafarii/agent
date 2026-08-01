/**
 * src/planning.js — Planning Engine for ScrappyAi
 * ------------------------------------------------
 * Manages structured multi-step plans and subtask tracking for agent runs.
 *
 * Each task has:
 *   id: string (e.g. "1", "1.1", "task-1")
 *   title: string
 *   description?: string
 *   status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped'
 *   deps?: string[] (task ids that must be completed first)
 *   notes?: string
 *
 * Pure JavaScript (ES modules).
 */

import { randomUUID } from 'node:crypto';
import { createLogger } from './logger.js';

const log = createLogger('planning');

export class PlanningEngine {
  constructor() {
    /** @type {Map<string, Object>} */
    this.plans = new Map();
    this.activePlanId = null;
  }

  /**
   * Create a new plan.
   * @param {Object} params
   * @param {string} params.title
   * @param {string} [params.description]
   * @param {Array<Object>} [params.tasks]
   * @returns {Object} plan summary
   */
  createPlan({ title, description = '', tasks = [] }) {
    if (!title || typeof title !== 'string') {
      throw new Error('Plan title is required.');
    }

    const planId = `plan_${Date.now()}_${randomUUID().slice(0, 6)}`;
    const formattedTasks = tasks.map((t, idx) => ({
      id: String(t.id || idx + 1),
      title: String(t.title || `Task ${idx + 1}`),
      description: t.description ? String(t.description) : '',
      status: ['pending', 'in_progress', 'completed', 'failed', 'skipped'].includes(t.status)
        ? t.status
        : 'pending',
      deps: Array.isArray(t.deps) ? t.deps.map(String) : [],
      notes: t.notes ? String(t.notes) : '',
    }));

    const plan = {
      id: planId,
      title: title.trim(),
      description: description.trim(),
      tasks: formattedTasks,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.plans.set(planId, plan);
    this.activePlanId = planId;

    log.info('createPlan', { planId, title: plan.title, taskCount: formattedTasks.length });
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
   * Get calculated summary of a plan with progress stats and actionable tasks.
   * @param {string} [planId]
   * @returns {Object}
   */
  getPlanSummary(planId) {
    const plan = this.getPlan(planId);
    if (!plan) return { error: 'No active plan found.' };

    const total = plan.tasks.length;
    const completed = plan.tasks.filter((t) => t.status === 'completed').length;
    const failed = plan.tasks.filter((t) => t.status === 'failed').length;
    const skipped = plan.tasks.filter((t) => t.status === 'skipped').length;
    const inProgress = plan.tasks.filter((t) => t.status === 'in_progress').length;
    const pending = plan.tasks.filter((t) => t.status === 'pending').length;

    const completedIds = new Set(
      plan.tasks.filter((t) => ['completed', 'skipped'].includes(t.status)).map((t) => t.id)
    );

    // Tasks ready to execute (pending, and all dependencies completed or skipped)
    const nextTasks = plan.tasks.filter((t) => {
      if (t.status !== 'pending') return false;
      if (!t.deps || t.deps.length === 0) return true;
      return t.deps.every((depId) => completedIds.has(depId));
    });

    const percentage = total > 0 ? Math.round(((completed + skipped) / total) * 100) : 0;

    return {
      planId: plan.id,
      title: plan.title,
      description: plan.description,
      progress: {
        total,
        completed,
        failed,
        skipped,
        inProgress,
        pending,
        percentage,
      },
      nextActionableTasks: nextTasks,
      tasks: plan.tasks,
      createdAt: plan.createdAt,
      updatedAt: plan.updatedAt,
    };
  }

  /**
   * Update task status or notes in a plan.
   * @param {Object} params
   * @param {string} params.taskId
   * @param {string} [params.status] 'pending'|'in_progress'|'completed'|'failed'|'skipped'
   * @param {string} [params.notes]
   * @param {string} [params.title]
   * @param {string} [params.planId]
   * @returns {Object} summary
   */
  updateTask({ taskId, status, notes, title, planId }) {
    const plan = this.getPlan(planId);
    if (!plan) throw new Error('Plan not found.');

    const task = plan.tasks.find((t) => String(t.id) === String(taskId));
    if (!task) throw new Error(`Task "${taskId}" not found in plan "${plan.id}".`);

    if (status) {
      const validStatuses = ['pending', 'in_progress', 'completed', 'failed', 'skipped'];
      if (!validStatuses.includes(status)) {
        throw new Error(`Invalid status "${status}". Must be one of: ${validStatuses.join(', ')}`);
      }
      task.status = status;
    }

    if (typeof notes === 'string') task.notes = notes;
    if (typeof title === 'string' && title.trim()) task.title = title.trim();

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

    const newFormattedTasks = tasks.map((t, idx) => ({
      id: String(t.id || `task_${plan.tasks.length + idx + 1}`),
      title: String(t.title || `New Task ${idx + 1}`),
      description: t.description ? String(t.description) : '',
      status: ['pending', 'in_progress', 'completed', 'failed', 'skipped'].includes(t.status)
        ? t.status
        : 'pending',
      deps: Array.isArray(t.deps) ? t.deps.map(String) : [],
      notes: t.notes ? String(t.notes) : '',
    }));

    plan.tasks.push(...newFormattedTasks);
    plan.updatedAt = new Date().toISOString();

    log.info('addTasks', { planId: plan.id, addedCount: newFormattedTasks.length });
    return this.getPlanSummary(plan.id);
  }

  /** Reset all plans. */
  reset() {
    this.plans.clear();
    this.activePlanId = null;
  }
}

/** Global default planning engine instance */
export const defaultPlanningEngine = new PlanningEngine();
