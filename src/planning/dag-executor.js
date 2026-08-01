/**
 * src/planning/dag-executor.js — Executor for DAG Task Execution
 * ----------------------------------------------------------------
 * Coordinates the execution of tasks in a DAG based on topological
 * dependency order, running independent ready nodes in PARALLEL.
 *
 *        ┌── A ──┐
 *   DAG ─┼── B ──┼── merge → next wave
 *        └── C ──┘
 *
 * Supports concurrency limit, AbortSignal cancellation, per-task
 * timeout, partial-failure policy, and retry.
 *
 * Pure JavaScript (ES modules).
 */

import { createLogger } from '../core/logger.js';
import { ParallelExecutor } from './parallel-executor.js';
import { Task, TaskStatus } from './task.js';

const log = createLogger('planning:executor');

export class DAGExecutor {
  /**
   * @param {Object} [opts]
   * @param {import('./dag.js').DAG} opts.dag
   * @param {Function} [opts.taskRunner] async (node, ctx) => result
   * @param {number} [opts.concurrency=4]
   * @param {'fail-fast'|'continue'|'collect'} [opts.onError='continue']
   * @param {Object} [opts.retry]
   * @param {number} [opts.taskTimeoutMs]
   */
  constructor(opts = {}) {
    this.dag = opts.dag;
    this.taskRunner = opts.taskRunner || (async (node) => ({ ok: true, node }));
    this.concurrency = Number.isFinite(opts.concurrency) ? opts.concurrency : 4;
    this.onError = opts.onError || 'continue';
    this.retry = opts.retry || { retries: 0 };
    this.taskTimeoutMs = opts.taskTimeoutMs || null;
    this.completed = new Set();
    this.failed = new Set();
    this.skipped = new Set();
    this.cancelled = new Set();
    this.results = new Map();
    this._parallel = new ParallelExecutor({
      concurrency: this.concurrency,
      onError: this.onError === 'fail-fast' ? 'fail-fast' : 'collect',
      retry: this.retry,
    });
  }

  /**
   * Execute all pending ready tasks wave-by-wave until completion, failure,
   * or cancellation.
   * @param {Object} [opts]
   * @param {AbortSignal} [opts.signal]
   * @param {number} [opts.timeoutMs] overall timeout
   * @returns {Promise<Object>} execution summary
   */
  async executeAll(opts = {}) {
    if (!this.dag) throw new Error('DAG is required for DAGExecutor.');

    const signal = opts.signal;
    const startedAt = Date.now();
    let wave = 0;

    while (true) {
      if (signal && signal.aborted) {
        this._cancelRemaining('aborted');
        break;
      }

      const readyNodes = this.dag
        .getReadyNodes(this.completed)
        .filter((n) => !this.failed.has(n.id) && !this.skipped.has(n.id) && !this.cancelled.has(n.id) && !this.completed.has(n.id));

      if (readyNodes.length === 0) break;

      wave += 1;
      log.info('executeWave:start', { wave, ready: readyNodes.map((n) => n.id) });

      // Build Task wrappers so ParallelExecutor can track attempts/status.
      const workItems = readyNodes.map((node) => {
        const data = node.data || {};
        const task = data instanceof Task
          ? data
          : new Task({
              id: node.id,
              goal: data.goal || data.title || node.id,
              title: data.title || node.id,
              description: data.description || '',
              status: TaskStatus.PENDING,
              timeoutMs: data.timeoutMs || this.taskTimeoutMs,
              inputs: data.inputs || {},
              metadata: { node },
            });

        return {
          ...task.toJSON(),
          id: task.id,
          goal: task.goal,
          timeoutMs: task.timeoutMs,
          // Custom runner closes over the DAG node.
          run: async (taskObj, ctx) => {
            const result = await this.taskRunner(node, {
              signal: ctx.signal,
              attempt: ctx.attempt,
              task: taskObj,
              logger: log,
            });
            // Convention: result.ok === false means logical failure.
            if (result && result.ok === false) {
              const err = new Error(result.error || `Task "${node.id}" failed`);
              err.code = result.code || 'TASK_FAILED';
              err.taskResult = result;
              throw err;
            }
            return result;
          },
        };
      });

      const waveResult = await this._parallel.parallel(workItems, {
        concurrency: this.concurrency,
        signal,
        onError: this.onError === 'fail-fast' ? 'fail-fast' : 'collect',
        retry: this.retry,
        taskTimeoutMs: this.taskTimeoutMs,
      });

      for (const r of waveResult.results) {
        const id = r.task?.id || readyNodes[r.index]?.id;
        this.results.set(id, r.ok ? { ok: true, data: r.data } : { ok: false, error: r.error, code: r.code });

        if (r.ok) {
          this.completed.add(id);
          log.info('executeTask:done', { taskId: id, wave });
        } else if (r.code === 'ABORTED' || r.code === 'CANCELLED' || r.code === 'TASK_TIMEOUT') {
          this.cancelled.add(id);
          log.warn('executeTask:cancelled', { taskId: id, code: r.code, error: r.error });
        } else {
          this.failed.add(id);
          log.warn('executeTask:failed', { taskId: id, error: r.error });
          // Optionally skip dependents on failure when onError === 'continue'
          if (this.onError === 'continue') {
            this._skipDependents(id, `dependency "${id}" failed`);
          }
        }
      }

      if (this.onError === 'fail-fast' && this.failed.size > 0) {
        this._cancelRemaining('fail-fast');
        break;
      }

      // If nothing new completed and nothing is ready, we're stuck (failed deps).
      if (waveResult.completedCount === 0 && readyNodes.length > 0 && this.failed.size + this.cancelled.size >= readyNodes.length) {
        break;
      }
    }

    const totalNodes = this.dag.nodes.size;
    const isSuccess = this.completed.size === totalNodes;

    return {
      ok: isSuccess,
      total: totalNodes,
      completedCount: this.completed.size,
      failedCount: this.failed.size,
      skippedCount: this.skipped.size,
      cancelledCount: this.cancelled.size,
      completedIds: Array.from(this.completed),
      failedIds: Array.from(this.failed),
      skippedIds: Array.from(this.skipped),
      cancelledIds: Array.from(this.cancelled),
      results: Object.fromEntries(this.results),
      durationMs: Date.now() - startedAt,
      waves: wave,
    };
  }

  /** Skip all transitive dependents of a failed node. */
  _skipDependents(failedId, reason) {
    const stack = [String(failedId)];
    const seen = new Set();
    while (stack.length) {
      const cur = stack.pop();
      if (seen.has(cur)) continue;
      seen.add(cur);
      const children = this.dag.outEdges.get(cur);
      if (!children) continue;
      for (const child of children) {
        if (
          this.completed.has(child) ||
          this.failed.has(child) ||
          this.skipped.has(child) ||
          this.cancelled.has(child)
        ) continue;
        this.skipped.add(child);
        this.results.set(child, { ok: false, error: reason, code: 'SKIPPED_DEP' });
        log.info('executeTask:skipped', { taskId: child, reason });
        stack.push(child);
      }
    }
  }

  _cancelRemaining(reason) {
    for (const id of this.dag.nodes.keys()) {
      if (
        this.completed.has(id) ||
        this.failed.has(id) ||
        this.skipped.has(id) ||
        this.cancelled.has(id)
      ) continue;
      this.cancelled.add(id);
      this.results.set(id, { ok: false, error: reason, code: 'CANCELLED' });
    }
  }
}
