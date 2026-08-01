/**
 * tools/runner.js — ToolRunner
 * -----------------------------
 * ToolRegistry owns discovery and metadata. ToolRunner owns execution. The
 * runner is the only place where the common execution pipeline lives:
 *
 *   validation → permission → middleware → timeout/abort → execute → normalize
 *
 * It has no dependency on AgentLoop, Router, or any built-in tool module.
 *
 * Pure JavaScript (ES modules).
 */

import { createLogger } from '../core/logger.js';
import { EXECUTABLE_LIFECYCLES, ToolLifecycle, recordExecutionMetrics } from './lifecycle.js';
import { ToolContext } from './context.js';
import { ToolError, ToolErrorCode } from './errors.js';
import { ToolResult, normalizeToolResult } from './result.js';
import {
  composeMiddleware,
  validationMiddleware,
  permissionMiddleware,
  timeoutMiddleware,
} from './middleware.js';
import { validateInput } from './schema.js';
import {
  checkPermissions,
  normalizePermissions,
} from '../security/permissions.js';

const DEFAULT_TIMEOUT_MS = 15_000;

export class ToolRunner {
  /**
   * @param {Object} opts
   * @param {Object} opts.registry object implementing get(name), profile, sandbox, approvals
   * @param {number} [opts.defaultTimeoutMs=15000]
   * @param {Object} [opts.config]
   * @param {Object} [opts.memory]
   * @param {Array<Function|Object>} [opts.middleware]
   */
  constructor(opts = {}) {
    // Accept both `new ToolRunner({ registry })` and the convenient
    // `new ToolRunner(registry)` form.
    if (opts && typeof opts.get === 'function' && !opts.registry && !opts.tools) opts = { registry: opts };
    this.registry = opts.registry || opts.tools || null;
    this.defaultTimeoutMs = Number.isFinite(opts.defaultTimeoutMs) ? opts.defaultTimeoutMs : DEFAULT_TIMEOUT_MS;
    this.config = opts.config || {};
    this.memory = opts.memory ?? null;
    this._middlewares = [];

    // These are ordinary middleware, not hidden Tool-specific branches. Hosts
    // can inspect/extend the pipeline with runner.use().
    this.use(validationMiddleware);
    this.use(permissionMiddleware);
    this.use(timeoutMiddleware);
    for (const middleware of opts.middleware || opts.middlewares || []) this.use(middleware);
  }

  /** Add a middleware to the end of the pipeline. */
  use(middleware) {
    // Normalize lazily in composeMiddleware so object middleware keeps its
    // method receiver; retaining the original also makes listMiddleware useful.
    this._middlewares.push(middleware);
    return this;
  }

  /** Remove a middleware by object identity or name. */
  removeMiddleware(middlewareOrName) {
    const before = this._middlewares.length;
    this._middlewares = this._middlewares.filter((middleware) => {
      if (middleware === middlewareOrName) return false;
      const name = typeof middleware === 'function' ? middleware.name : middleware?.name;
      return name !== middlewareOrName;
    });
    return this._middlewares.length !== before;
  }

  listMiddleware() {
    return this._middlewares.map((middleware) => (
      typeof middleware === 'function' ? middleware.name || 'anonymous' : middleware?.name || 'middleware'
    ));
  }

  get middlewares() {
    return this._middlewares.slice();
  }

  /**
   * Run a tool and return the standard ToolResult contract.
   *
   * @param {string} name
   * @param {Object} [input]
   * @param {Object} [options]
   * @param {number} [options.timeout] per-call timeout in milliseconds
   * @param {number} [options.timeoutMs] alias for timeout
   * @param {AbortSignal} [options.signal]
   * @param {Object} [options.context] agent ContextWindow (not AgentLoop)
   * @param {Object} [options.config]
   * @param {Object} [options.memory]
   * @param {Object} [options.permissions] per-call granted permissions
   * @param {Object} [options.capabilities]
   * @returns {Promise<{ok:true,data:any,meta:Object}|{ok:false,error:{code:string,message:string},meta:Object}>}
   */
  async run(name, input = {}, options = {}) {
    const startedAt = Date.now();
    const tool = this.get(name);
    const inputValue = input === undefined ? {} : input;
    const fail = (code, message, extra = {}) => this._failure(code, message, startedAt, { source: name, ...extra });

    if (!tool) {
      return fail(ToolErrorCode.NOT_FOUND, `Tool "${name}" was not found.`);
    }
    if (tool.enabled === false || tool.disabled === true) {
      return fail(ToolErrorCode.DISABLED, tool.disabledReason || `Tool "${name}" is disabled.`);
    }
    if (!EXECUTABLE_LIFECYCLES.includes(tool.lifecycle)) {
      return fail('TOOL_NOT_ACTIVE', `Tool "${name}" is not executable in lifecycle state "${tool.lifecycle}".`);
    }

    const timeoutMs = resolveTimeout(options, tool.timeoutMs, this.defaultTimeoutMs);
    const controller = new AbortController();
    const externalSignal = options.signal;
    let onExternalAbort = null;
    let abortReject = null;
    const abortPromise = externalSignal
      ? new Promise((_, reject) => { abortReject = reject; })
      : null;

    const execution = {
      name,
      input: inputValue,
      tool,
      options,
      runner: this,
      controller,
      externalSignal,
      signal: controller.signal,
      timeoutMs,
      startedAt,
      abortPromise,
      context: null,
      grantedPermissions: null,
      invoked: false,
      timedOut: false,
      aborted: false,
    };

    if (externalSignal) {
      onExternalAbort = () => {
        execution.aborted = true;
        const reason = externalSignal.reason instanceof Error
          ? externalSignal.reason
          : new ToolError('Tool execution aborted.', ToolErrorCode.ABORTED);
        controller.abort(reason);
        abortReject?.(new ToolError(reason.message || 'Tool execution aborted.', ToolErrorCode.ABORTED));
      };
      if (externalSignal.aborted) {
        onExternalAbort();
      } else {
        externalSignal.addEventListener('abort', onExternalAbort, { once: true });
      }
    }

    const granted = options.permissions
      ? normalizePermissions(options.permissions)
      : this.profilePermissions();
    execution.context = new ToolContext({
      signal: controller.signal,
      logger: options.logger || createLogger(`tools:${name}`),
      config: options.config ?? this.registry?.config ?? this.config ?? {},
      memory: options.memory ?? this.memory ?? this.registry?.memory ?? null,
      capabilities: options.capabilities || this.registry?.capabilities || {},
      permissions: granted,
      sandbox: options.sandbox || this.registry?.sandbox || null,
      context: options.context || this.registry?.context || null,
      task: options.task || null,
      run: options.run || null,
      registry: this.registry,
      tool: publicToolInfo(tool),
    });

    try {
      if (externalSignal?.aborted) {
        return fail(ToolErrorCode.ABORTED, 'Tool execution aborted.');
      }

      const pipeline = composeMiddleware(
        this._middlewares,
        (currentExecution) => this._invoke(currentExecution)
      );
      const raw = await pipeline(execution);
      const result = normalizeToolResult(raw, {
        durationMs: Date.now() - startedAt,
        source: name,
        plugin: tool.pluginName || tool.metadata?.plugin || undefined,
        truncated: !!(raw && raw.data && typeof raw.data === 'object' && raw.data.truncated === true),
      });
      if (execution.invoked) recordExecutionMetrics(tool, result);
      return result;
    } catch (err) {
      const code = err?.code || ToolErrorCode.FAILED;
      const message = err?.message || String(err);
      const result = fail(code, message, {
        details: err?.details,
        denied: err?.denied,
      });
      if (execution.invoked) recordExecutionMetrics(tool, result);
      return result;
    } finally {
      if (externalSignal && onExternalAbort) externalSignal.removeEventListener('abort', onExternalAbort);
    }
  }

  /** Validate a registered tool's canonical input schema. */
  validate(name, input) {
    const tool = this.get(name);
    if (!tool) return { ok: false, errors: [`Unknown tool "${name}".`] };
    return validateInput(tool.inputSchema, input);
  }

  /** Check permissions without executing business logic. */
  checkToolPermissions(name, options = {}) {
    const tool = this.get(name);
    if (!tool) return { ok: false, code: ToolErrorCode.NOT_FOUND, error: `Tool "${name}" was not found.` };
    const granted = options.permissions
      ? normalizePermissions(options.permissions)
      : this.profilePermissions();
    const check = checkPermissions(tool.permissions, granted);
    return check.ok
      ? { ok: true, permissions: granted, denied: [] }
      : { ...check, permissions: granted };
  }

  approvalState(name, _options = {}) {
    const approvals = this.registry?.approvals;
    return approvals?.lookup?.({ tool: name }) || 'unknown';
  }

  get(name) {
    return this.registry?.get?.(name) || null;
  }

  profilePermissions() {
    return this.registry?.profile?.permissions || normalizePermissions({});
  }

  async _invoke(execution) {
    execution.invoked = true;
    const tool = execution.tool;
    const execute = tool.execute || tool.handler;
    if (typeof execute !== 'function') {
      throw new ToolError(`Tool "${execution.name}" has no executable function.`, ToolErrorCode.FAILED);
    }
    const raw = await execute.call(tool, execution.input || {}, execution.context);
    // Normalize at the terminal boundary as well as at run()'s final boundary
    // so post-execution middleware observes the same ToolResult contract.
    return normalizeToolResult(raw);
  }

  _failure(code, message, startedAt, extra = {}) {
    const meta = {
      durationMs: Date.now() - startedAt,
      source: extra.source,
      ...(extra.meta || {}),
    };
    const result = ToolResult.failure(code, message, meta);
    if (extra.denied) result.denied = extra.denied;
    if (extra.details) result.details = extra.details;
    return result;
  }
}

function resolveTimeout(options, toolTimeout, defaultTimeout) {
  const requested = options.timeout ?? options.timeoutMs;
  if (requested === Infinity) return Infinity;
  if (Number.isFinite(requested)) return Math.max(0, requested);
  if (Number.isFinite(toolTimeout)) return Math.max(0, toolTimeout);
  return defaultTimeout;
}

function publicToolInfo(tool) {
  return {
    name: tool.name,
    description: tool.description,
    version: tool.metadata?.version,
    lifecycle: tool.lifecycle,
    permissions: tool.permissions,
    risk: tool.risk,
    metadata: tool.metadata,
  };
}

export default ToolRunner;
