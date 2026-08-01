/**
 * src/planning/dag-executor.js — Executor for DAG Task Execution
 * ----------------------------------------------------------------
 * Coordinates the execution of tasks in a DAG based on topological dependency order.
 *
 * Pure JavaScript (ES modules).
 */

import { createLogger } from '../logger.js';

const log = createLogger('planning:executor');

export class DAGExecutor {
  /**
   * @param {Object} [opts]
   * @param {import('./dag.js').DAG} opts.dag
   * @param {Function} [opts.taskRunner] async (node) => result
   */
  constructor(opts = {}) {
    this.dag = opts.dag;
    this.taskRunner = opts.taskRunner || (async (node) => ({ ok: true, node }));
    this.completed = new Set();
    this.failed = new Set();
    this.results = new Map();
  }

  /**
   * Execute all pending ready tasks until completion or failure.
   * @returns {Promise<Object>} execution summary
   */
  async executeAll() {
    if (!this.dag) throw new Error('DAG is required for DAGExecutor.');

    let progressMade = true;

    while (progressMade) {
      const readyNodes = this.dag.getReadyNodes(this.completed);
      const executableNodes = readyNodes.filter((n) => !this.failed.has(n.id));

      if (executableNodes.length === 0) {
        progressMade = false;
        break;
      }

      for (const node of executableNodes) {
        log.info('executeTask:start', { taskId: node.id, title: node.data.title });
        try {
          const result = await this.taskRunner(node);
          this.results.set(node.id, result);
          if (result && result.ok !== false) {
            this.completed.add(node.id);
            log.info('executeTask:done', { taskId: node.id });
          } else {
            this.failed.add(node.id);
            log.warn('executeTask:failed', { taskId: node.id, error: result?.error });
          }
        } catch (err) {
          this.failed.add(node.id);
          this.results.set(node.id, { ok: false, error: err.message });
          log.error('executeTask:exception', { taskId: node.id, error: err.message });
        }
      }
    }

    const totalNodes = this.dag.nodes.size;
    const isSuccess = this.completed.size === totalNodes;

    return {
      ok: isSuccess,
      total: totalNodes,
      completedCount: this.completed.size,
      failedCount: this.failed.size,
      completedIds: Array.from(this.completed),
      failedIds: Array.from(this.failed),
      results: Object.fromEntries(this.results),
    };
  }
}
