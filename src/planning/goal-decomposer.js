/**
 * src/planning/goal-decomposer.js — High-level Goal Decomposer
 * -------------------------------------------------------------
 * Decomposes complex user goals into structured subgoals, task trees, and DAGs.
 *
 * Pure JavaScript (ES modules).
 */

import { DAG } from './dag.js';
import { TaskTree } from './task-tree.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('planning:decomposer');

export class GoalDecomposer {
  /**
   * Decompose a goal string or structured object into a DAG and TaskTree.
   * @param {Object|string} goal
   * @returns {{ goalTitle: string, dag: DAG, taskTree: TaskTree, tasks: Array }}
   */
  decompose(goal) {
    const goalTitle = typeof goal === 'string' ? goal.trim() : (goal && goal.title ? goal.title : 'Goal');
    const rawTasks = (goal && Array.isArray(goal.tasks)) ? goal.tasks : [];

    const dag = new DAG();
    const taskTree = new TaskTree(goalTitle);

    if (rawTasks.length === 0) {
      // Create a default root task
      const defaultTaskId = 'task-1';
      dag.addNode(defaultTaskId, { title: goalTitle, status: 'pending' });
      taskTree.addTask({ id: defaultTaskId, title: goalTitle });
    } else {
      for (const t of rawTasks) {
        const taskId = String(t.id || `task-${dag.nodes.size + 1}`);
        const taskData = {
          id: taskId,
          title: String(t.title || taskId),
          description: t.description ? String(t.description) : '',
          status: t.status || 'pending',
          parentId: t.parentId ? String(t.parentId) : null,
        };

        dag.addNode(taskId, taskData);
        taskTree.addTask(taskData, t.parentId);

        if (Array.isArray(t.deps)) {
          for (const dep of t.deps) {
            dag.addEdge(String(dep), taskId);
          }
        }
      }
    }

    log.info('decompose:done', { goalTitle, totalTasks: dag.nodes.size });

    return {
      goalTitle,
      dag,
      taskTree,
      tasks: Array.from(dag.nodes.values()).map((n) => ({ ...n.data, deps: Array.from(dag.inEdges.get(n.id)) })),
    };
  }
}
