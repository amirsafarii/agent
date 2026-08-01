/**
 * planning/parallel-executor.js — concurrent task execution
 * ----------------------------------------------------------
 * Independent tasks (no mutual deps) should run together:
 *
 *        ┌── A ──┐
 *   Task ─┼── B ──┼── merge
 *        └── C ──┘
 *
 *   await executor.parallel([taskA, taskB, taskC]);
 *
 * Features:
 *   - concurrency limit
 *   - cancellation (AbortSignal, end-to-end)
 *   - per-task + overall timeout
 *   - partial failure policies: fail-fast | continue | collect
 *   - retry policy per task / global default
 *
 * Pure JavaScript (ES modules).
 */

import { createLogger } from '../core/logger.js';
import { Task, TaskStatus } from './task.js';

const log = createLogger('planning:parallel');

/**
 * @typedef {Object} RetryPolicy
 * @property {number} [retries=0]  extra attempts after the first
 * @property {number} [backoffMs=100]
 * @property {number} [factor=2]
 * @property {Function} [retryOn]  (error, attempt) => boolean
 */

/**
 * @typedef {Object} ParallelOptions
 * @property {number} [concurrency=Infinity]
 * @property {AbortSignal} [signal]
 * @property {number} [timeoutMs] overall wall-clock timeout
 * @property {number} [taskTimeoutMs] default per-task timeout
 * @property {'fail-fast'|'continue'|'collect'} [onError='collect']
 * @property {RetryPolicy} [retry]
 * @property {Function} [onTaskStart] (task, index) => void
 * @property {Function} [onTaskDone] (task, result, index) => void
 * @property {Function} [onTaskError] (task, error, index) => void
 */

/**
 * Parallel task executor.
 *
 * `taskRunner` signature:
 *   async (task, ctx) => result
 * where ctx = { signal, attempt, index, logger }
 */
export class ParallelExecutor {
  /**
   * @param {Object} [opts]
   * @param {Function} [opts.taskRunner]
   * @param {number} [opts.concurrency=4]
   * @param {RetryPolicy} [opts.retry]
   * @param {'fail-fast'|'continue'|'collect'} [opts.onError='collect']
   */
  constructor(opts = {}) {
    this.taskRunner = opts.taskRunner || defaultTaskRunner;
    this.defaultConcurrency = Number.isFinite(opts.concurrency) ? opts.concurrency : 4;
    this.defaultRetry = opts.retry || { retries: 0, backoffMs: 100, factor: 2 };
    this.defaultOnError = opts.onError || 'collect';
  }

  /**
   * Run many tasks concurrently (respecting concurrency limit).
   * Accepts Task instances, plain task-shaped objects, or bare async functions.
   *
   * @param {Array<Task|Object|Function>} tasks
   * @param {ParallelOptions} [opts]
   * @returns {Promise<ParallelResult>}
   */
  async parallel(tasks, opts = {}) {
    if (!Array.isArray(tasks)) {
      throw new Error('parallel() expects an array of tasks.');
    }

    const concurrency = Number.isFinite(opts.concurrency) ? Math.max(1, opts.concurrency) : this.defaultConcurrency;
    const onError = opts.onError || this.defaultOnError;
    const retryPolicy = { ...this.defaultRetry, ...(opts.retry || {}) };
    const parentSignal = opts.signal;
    const overallTimeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : null;
    const taskTimeoutMs = Number.isFinite(opts.taskTimeoutMs) ? opts.taskTimeoutMs : null;

    // Combined abort controller: parent signal OR overall timeout OR fail-fast.
    const controller = new AbortController();
    const onParentAbort = () => controller.abort(parentSignal.reason || new Error('aborted'));
    if (parentSignal) {
      if (parentSignal.aborted) {
        controller.abort(parentSignal.reason || new Error('aborted'));
      } else {
        parentSignal.addEventListener('abort', onParentAbort, { once: true });
      }
    }

    let overallTimer = null;
    if (overallTimeoutMs != null) {
      overallTimer = setTimeout(() => {
        controller.abort(Object.assign(new Error(`parallel() timed out after ${overallTimeoutMs}ms`), { code: 'PARALLEL_TIMEOUT' }));
      }, overallTimeoutMs);
      if (typeof overallTimer.unref === 'function') overallTimer.unref();
    }

    const startedAt = Date.now();
    /** @type {Array<{ ok: boolean, index: number, task: Task, data?: any, error?: string, code?: string, attempts: number, durationMs: number }>} */
    const results = new Array(tasks.length);
    let completedCount = 0;
    let failedCount = 0;
    let cancelledCount = 0;
    let failFastTriggered = false;

    // Normalize inputs into Task instances + runner closures.
    const work = tasks.map((t, index) => normalizeWorkItem(t, index, taskTimeoutMs));

    try {
      await runPool(work, concurrency, async (item) => {
        if (controller.signal.aborted || failFastTriggered) {
          item.task.cancel(abortMessage(controller.signal));
          results[item.index] = {
            ok: false,
            index: item.index,
            task: item.task,
            error: item.task.error,
            code: 'CANCELLED',
            attempts: item.task.attemptCount,
            durationMs: 0,
          };
          cancelledCount += 1;
          return;
        }

        const result = await this._runOne(item, {
          signal: controller.signal,
          retryPolicy,
          onTaskStart: opts.onTaskStart,
          onTaskDone: opts.onTaskDone,
          onTaskError: opts.onTaskError,
        });

        results[item.index] = result;
        if (result.ok) {
          completedCount += 1;
        } else if (result.code === 'CANCELLED' || result.code === 'ABORTED') {
          cancelledCount += 1;
        } else {
          failedCount += 1;
          if (onError === 'fail-fast' && !failFastTriggered) {
            failFastTriggered = true;
            controller.abort(Object.assign(new Error(`fail-fast: task[${item.index}] failed: ${result.error}`), {
              code: 'FAIL_FAST',
            }));
          }
        }
      });
    } finally {
      if (overallTimer) clearTimeout(overallTimer);
      if (parentSignal) parentSignal.removeEventListener('abort', onParentAbort);
    }

    // Fill any holes left by a mid-flight abort (shouldn't happen with runPool, but be safe).
    for (let i = 0; i < results.length; i += 1) {
      if (!results[i]) {
        work[i].task.cancel('not started');
        results[i] = {
          ok: false,
          index: i,
          task: work[i].task,
          error: 'not started',
          code: 'CANCELLED',
          attempts: 0,
          durationMs: 0,
        };
        cancelledCount += 1;
      }
    }

    const ok =
      failedCount === 0 &&
      cancelledCount === 0 &&
      !controller.signal.aborted;

    const summary = {
      ok,
      total: tasks.length,
      completedCount,
      failedCount,
      cancelledCount,
      durationMs: Date.now() - startedAt,
      aborted: !!controller.signal.aborted,
      abortReason: controller.signal.aborted ? abortMessage(controller.signal) : null,
      results,
      // Convenience: successful data in order (undefined for failures)
      data: results.map((r) => (r.ok ? r.data : undefined)),
      // Partial-failure helpers
      successes: results.filter((r) => r.ok),
      failures: results.filter((r) => !r.ok),
    };

    log.info('parallel:done', {
      total: summary.total,
      completedCount,
      failedCount,
      cancelledCount,
      durationMs: summary.durationMs,
      ok,
    });

    if (onError === 'fail-fast' && !ok && failFastTriggered) {
      const err = new Error(summary.abortReason || 'parallel() fail-fast');
      err.code = 'FAIL_FAST';
      err.partial = summary;
      // Still return summary (don't throw) — callers can inspect .ok / .failures.
      // Throwing would break the "never throw out of executor" convention used elsewhere.
    }

    return summary;
  }

  /**
   * Run a single work item with retry + per-task timeout + signal.
   * @private
   */
  async _runOne(item, { signal, retryPolicy, onTaskStart, onTaskDone, onTaskError }) {
    const { task, runner, index, timeoutMs } = item;
    let attempt = 0;
    let lastError = null;
    const maxAttempts = 1 + (retryPolicy.retries || 0);
    const taskStartedAt = Date.now();

    while (attempt < maxAttempts) {
      if (signal.aborted) {
        task.cancel(abortMessage(signal));
        return {
          ok: false,
          index,
          task,
          error: task.error,
          code: 'ABORTED',
          attempts: attempt,
          durationMs: Date.now() - taskStartedAt,
        };
      }

      attempt += 1;
      task.start({ n: attempt });

      try {
        if (typeof onTaskStart === 'function') onTaskStart(task, index);
      } catch (_err) { /* hooks never break execution */ }

      // Per-attempt abort = parent signal OR per-task timeout
      const attemptController = new AbortController();
      const onParent = () => attemptController.abort(signal.reason || new Error('aborted'));
      if (signal.aborted) {
        attemptController.abort(signal.reason || new Error('aborted'));
      } else {
        signal.addEventListener('abort', onParent, { once: true });
      }

      let attemptTimer = null;
      if (timeoutMs != null) {
        attemptTimer = setTimeout(() => {
          attemptController.abort(Object.assign(
            new Error(`Task "${task.id}" timed out after ${timeoutMs}ms`),
            { code: 'TASK_TIMEOUT' }
          ));
        }, timeoutMs);
        if (typeof attemptTimer.unref === 'function') attemptTimer.unref();
      }

      try {
        const data = await runner(task, {
          signal: attemptController.signal,
          attempt,
          index,
          logger: log,
        });

        // If aborted during run, treat as cancel even if runner returned.
        if (attemptController.signal.aborted) {
          throw abortToError(attemptController.signal);
        }

        task.complete(typeof data === 'object' && data !== null && !Array.isArray(data) ? data : { value: data });
        const result = {
          ok: true,
          index,
          task,
          data,
          attempts: attempt,
          durationMs: Date.now() - taskStartedAt,
        };
        try {
          if (typeof onTaskDone === 'function') onTaskDone(task, result, index);
        } catch (_err) { /* noop */ }
        return result;
      } catch (err) {
        lastError = err;
        const code = (err && err.code) || 'TASK_ERROR';
        const message = err && err.message ? err.message : String(err);

        try {
          if (typeof onTaskError === 'function') onTaskError(task, err, index);
        } catch (_err) { /* noop */ }

        const isAbort = code === 'ABORTED' || code === 'TASK_TIMEOUT' || signal.aborted || attemptController.signal.aborted;
        const retryOn = typeof retryPolicy.retryOn === 'function'
          ? retryPolicy.retryOn(err, attempt)
          : !isAbort;

        if (isAbort) {
          task.cancel(message);
          return {
            ok: false,
            index,
            task,
            error: message,
            code: code === 'TASK_TIMEOUT' ? 'TASK_TIMEOUT' : 'ABORTED',
            attempts: attempt,
            durationMs: Date.now() - taskStartedAt,
          };
        }

        const willRetry = attempt < maxAttempts && retryOn;
        task.fail(err, { retryable: willRetry });

        if (!willRetry) {
          return {
            ok: false,
            index,
            task,
            error: message,
            code,
            attempts: attempt,
            durationMs: Date.now() - taskStartedAt,
          };
        }

        const backoff = (retryPolicy.backoffMs || 0) * Math.pow(retryPolicy.factor || 2, attempt - 1);
        if (backoff > 0) await sleep(backoff, signal);
      } finally {
        if (attemptTimer) clearTimeout(attemptTimer);
        signal.removeEventListener('abort', onParent);
      }
    }

    return {
      ok: false,
      index,
      task,
      error: lastError && lastError.message ? lastError.message : 'unknown',
      code: (lastError && lastError.code) || 'TASK_ERROR',
      attempts: attempt,
      durationMs: Date.now() - taskStartedAt,
    };
  }
}

/**
 * Convenience function — one-shot parallel without constructing an executor.
 * @param {Array} tasks
 * @param {ParallelOptions & { taskRunner?: Function }} [opts]
 */
export async function parallel(tasks, opts = {}) {
  const executor = new ParallelExecutor({
    taskRunner: opts.taskRunner,
    concurrency: opts.concurrency,
    retry: opts.retry,
    onError: opts.onError,
  });
  return executor.parallel(tasks, opts);
}

// --- helpers ---------------------------------------------------------------

function defaultTaskRunner(task) {
  // If the task carries a metadata.fn, call it; otherwise no-op success.
  if (typeof task.metadata?.fn === 'function') {
    return task.metadata.fn(task);
  }
  return { ok: true, id: task.id };
}

function normalizeWorkItem(t, index, defaultTimeoutMs) {
  if (typeof t === 'function') {
    const task = new Task({ id: `fn_${index}`, goal: t.name || `function[${index}]` });
    return {
      index,
      task,
      timeoutMs: defaultTimeoutMs,
      runner: async (_task, ctx) => t(ctx),
    };
  }

  const task = t instanceof Task ? t : new Task(t && typeof t === 'object' ? t : { goal: String(t) });
  const timeoutMs = Number.isFinite(task.timeoutMs) ? task.timeoutMs : defaultTimeoutMs;

  // Prefer explicit runner on the item, then metadata.fn, then default.
  let runner;
  if (typeof t?.run === 'function') {
    runner = (taskObj, ctx) => t.run(taskObj, ctx);
  } else if (typeof t?.fn === 'function') {
    runner = (taskObj, ctx) => t.fn(taskObj, ctx);
  } else if (typeof t?.metadata?.fn === 'function') {
    runner = (taskObj, ctx) => t.metadata.fn(taskObj, ctx);
  } else {
    runner = defaultTaskRunner;
  }

  return { index, task, timeoutMs, runner };
}

/**
 * Simple async pool. Runs `worker(item)` over `items` with at most
 * `concurrency` in flight. Resolves when all settle (does not reject).
 */
async function runPool(items, concurrency, worker) {
  if (items.length === 0) return;
  const limit = Math.min(concurrency, items.length);
  let cursor = 0;

  async function workerLoop() {
    while (cursor < items.length) {
      const i = cursor;
      cursor += 1;
      try {
        await worker(items[i]);
      } catch (err) {
        // worker is expected to handle its own errors; log and continue
        log.error('parallel:worker_unhandled', { index: i, error: err && err.message });
      }
    }
  }

  const starters = [];
  for (let i = 0; i < limit; i += 1) starters.push(workerLoop());
  await Promise.all(starters);
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(abortToError(signal));
      return;
    }
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortToError(signal));
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

function abortMessage(signal) {
  if (!signal) return 'aborted';
  if (signal.reason && signal.reason.message) return signal.reason.message;
  if (typeof signal.reason === 'string') return signal.reason;
  return 'aborted';
}

function abortToError(signal) {
  if (signal && signal.reason instanceof Error) return signal.reason;
  const err = new Error(abortMessage(signal));
  err.code = (signal && signal.reason && signal.reason.code) || 'ABORTED';
  return err;
}

export default ParallelExecutor;
