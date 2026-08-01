/**
 * tools/middleware.js — ToolRunner middleware primitives
 * --------------------------------------------------------
 * Middleware has the small Koa-style contract:
 *
 *   async function loggingMiddleware(execution, next) {
 *     // execution.name, execution.input, execution.context
 *     const result = await next(execution);
 *     return result;
 *   }
 *
 * Middleware is intentionally independent from AgentLoop and plugins. A
 * runner can add logging, metrics, retry, cache, audit, or custom policy
 * without changing a single Tool implementation.
 *
 * Pure JavaScript (ES modules).
 */

import { ToolError, ToolErrorCode } from './errors.js';
import { ToolResult } from './result.js';

/**
 * Normalize function/object middleware into a callable while retaining a name
 * for diagnostics.
 */
export class Middleware {
  constructor(handler, name = 'middleware') {
    if (typeof handler !== 'function') throw new TypeError('Middleware requires a handler function.');
    this.name = name || handler.name || 'middleware';
    this._handler = handler;
  }

  handle(execution, next) {
    return this._handler(execution, next);
  }
}

export function createMiddleware(handler, name) {
  return new Middleware(handler, name);
}

export function normalizeMiddleware(middleware) {
  if (typeof middleware === 'function') {
    return { name: middleware.name || 'anonymous', handle: middleware };
  }
  if (middleware && typeof middleware.handle === 'function') {
    return { name: middleware.name || middleware.handle.name || 'middleware', handle: middleware.handle.bind(middleware) };
  }
  if (middleware && typeof middleware.execute === 'function') {
    return { name: middleware.name || middleware.execute.name || 'middleware', handle: middleware.execute.bind(middleware) };
  }
  throw new TypeError('Tool middleware must be a function or an object with handle(execution, next).');
}

/**
 * Compose middleware around a terminal handler.
 * @param {Array<Function|Object>} middlewares
 * @param {Function} terminal
 */
export function composeMiddleware(middlewares, terminal) {
  const stack = middlewares.map(normalizeMiddleware);
  return async function run(initialExecution) {
    async function dispatch(index, execution) {
      if (index >= stack.length) return terminal(execution);
      const current = stack[index];
      let called = false;
      const next = async (nextExecution = execution) => {
        if (called) throw new ToolError(`Middleware "${current.name}" called next() more than once.`, ToolErrorCode.FAILED);
        called = true;
        return dispatch(index + 1, nextExecution);
      };
      return current.handle(execution, next);
    }
    return dispatch(0, initialExecution);
  };
}

/** Central validation middleware. It prevents execute() from being reached. */
export const validationMiddleware = {
  name: 'validation',
  async handle(execution, next) {
    const validation = execution.runner.validate(execution.name, execution.input);
    if (!validation.ok) {
      return ToolResult.failure(
        ToolErrorCode.INVALID_INPUT,
        `Invalid input for "${execution.name}": ${validation.errors.join('; ')}`,
        {},
        { errors: validation.errors }
      );
    }
    return next(execution);
  },
};

/** Central capability/permission middleware. */
export const permissionMiddleware = {
  name: 'permission',
  async handle(execution, next) {
    const check = execution.runner.checkToolPermissions(execution.name, execution.options);
    if (!check.ok) {
      return ToolResult.failure(
        ToolErrorCode.PERMISSION_DENIED,
        check.error,
        {},
        { denied: check.denied }
      );
    }
    execution.grantedPermissions = check.permissions;
    if (execution.context) execution.context.permissions = check.permissions;

    const approvalState = execution.runner.approvalState(execution.name, execution.options);
    if (approvalState === 'denied') {
      return ToolResult.failure(
        'SESSION_DENIED',
        `Tool "${execution.name}" is denied for this session.`
      );
    }
    return next(execution);
  },
};

/**
 * Timeout/abort middleware. ToolRunner creates a linked AbortSignal before
 * entering the pipeline; this middleware turns timeout/abort into a bounded
 * Promise as well as notifying cooperative tools through context.signal.
 */
export const timeoutMiddleware = {
  name: 'timeout',
  async handle(execution, next) {
    const timeoutMs = execution.timeoutMs;
    const operation = Promise.resolve().then(() => next(execution));
    const races = [operation];

    let timer = null;
    let timedOut = false;
    if (Number.isFinite(timeoutMs) && timeoutMs >= 0) {
      races.push(new Promise((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          const err = new ToolError(
            `Tool "${execution.name}" timed out after ${timeoutMs}ms.`,
            ToolErrorCode.TIMEOUT
          );
          execution.timedOut = true;
          execution.controller?.abort(err);
          reject(err);
        }, timeoutMs);
      }));
    }

    if (execution.abortPromise) races.push(execution.abortPromise);

    try {
      return await Promise.race(races);
    } catch (err) {
      if (timedOut || execution.timedOut) throw err;
      if (execution.externalSignal?.aborted || execution.aborted) {
        throw new ToolError('Tool execution aborted.', ToolErrorCode.ABORTED);
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  },
};

/** A tiny reusable logger middleware (opt-in; hosts may provide their logger). */
export function createLoggingMiddleware(logger = console) {
  return {
    name: 'logging',
    async handle(execution, next) {
      const startedAt = Date.now();
      logger?.debug?.('tool:start', { name: execution.name });
      try {
        const result = await next(execution);
        logger?.debug?.('tool:done', { name: execution.name, ok: result?.ok, durationMs: Date.now() - startedAt });
        return result;
      } catch (err) {
        logger?.error?.('tool:failed', { name: execution.name, error: err?.message });
        throw err;
      }
    },
  };
}

export default {
  Middleware,
  createMiddleware,
  normalizeMiddleware,
  composeMiddleware,
  validationMiddleware,
  permissionMiddleware,
  timeoutMiddleware,
  createLoggingMiddleware,
};
