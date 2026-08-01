/**
 * tools/planning.js — planning and subtask management tools
 * ---------------------------------------------------------------------------
 * Tools for creating, updating, viewing, and expanding multi-step execution
 * plans for ScrappyAi.
 *
 *   plan_create      initialize a structured multi-step task plan
 *   plan_update_task update status (pending/in_progress/completed/failed/skipped)
 *                    or add progress notes to a specific task
 *   plan_get         retrieve plan status, progress %, and next ready tasks
 *   plan_add_tasks   append new subtasks to an existing plan
 *
 * Pure JavaScript (ES modules).
 */

import { PlanningEngine, defaultPlanningEngine } from '../planning/index.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('tools:planning');

/**
 * @param {Object} [opts]
 * @param {PlanningEngine} [opts.engine]
 * @returns {Array<import('./registry.js').ToolDefinition>}
 */
export function createPlanningTools(opts = {}) {
  const engine = opts.engine || defaultPlanningEngine;

  return [
    {
      name: 'plan_create',
      description: 'Create a structured execution plan with subtasks and dependencies to track complex multi-step work.',
      parameters: {
        title: { type: 'string', description: 'Overall goal or title of the plan', required: true },
        description: { type: 'string', description: 'Detailed objective or background context' },
        tasks: {
          type: 'array',
          description: 'Array of task objects with fields: id, title, description, deps (array of dependency task ids)',
          required: true,
        },
      },
      handler: async ({ title, description, tasks }) => {
        log.info('plan_create', { title, taskCount: Array.isArray(tasks) ? tasks.length : 0 });
        const summary = engine.createPlan({ title, description, tasks });
        return summary;
      },
    },
    {
      name: 'plan_update_task',
      description: 'Update the status or notes of a task in the active execution plan.',
      parameters: {
        taskId: { type: 'string', description: 'ID of the task to update', required: true },
        status: {
          type: 'string',
          description: 'New task status',
          enum: ['pending', 'in_progress', 'completed', 'failed', 'skipped'],
        },
        notes: { type: 'string', description: 'Progress notes or execution details' },
        title: { type: 'string', description: 'Updated title for the task' },
        planId: { type: 'string', description: 'Optional plan ID (defaults to current active plan)' },
      },
      handler: async ({ taskId, status, notes, title, planId }) => {
        log.info('plan_update_task', { taskId, status });
        const summary = engine.updateTask({ taskId, status, notes, title, planId });
        return summary;
      },
    },
    {
      name: 'plan_get',
      description: 'View the active plan details, completion percentage, and next ready actionable tasks.',
      parameters: {
        planId: { type: 'string', description: 'Optional plan ID (defaults to current active plan)' },
      },
      handler: async ({ planId }) => {
        log.info('plan_get', { planId });
        const summary = engine.getPlanSummary(planId);
        return summary;
      },
    },
    {
      name: 'plan_add_tasks',
      description: 'Add additional subtasks to an existing execution plan as requirements evolve.',
      parameters: {
        tasks: {
          type: 'array',
          description: 'Array of new task objects to append (fields: id, title, description, deps)',
          required: true,
        },
        planId: { type: 'string', description: 'Optional plan ID (defaults to current active plan)' },
      },
      handler: async ({ tasks, planId }) => {
        log.info('plan_add_tasks', { addedCount: Array.isArray(tasks) ? tasks.length : 0 });
        const summary = engine.addTasks({ tasks, planId });
        return summary;
      },
    },
  ];
}
