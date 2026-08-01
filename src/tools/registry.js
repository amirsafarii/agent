/**
 * tools/registry.js — Tool Registry
 * -----------------------------------------------
 * Register tools with a JSON-schema-ish contract, execute them with real
 * argument validation, a per-tool timeout, permission checks, lifecycle
 * gating, and error handling that never throws out of the loop — every call
 * resolves to a plain result object so the reasoner can decide whether to
 * retry, pick another tool, or give up.
 *
 * Lifecycle (see tools/lifecycle.js):
 *   DISCOVERED → DRAFT → VALIDATING → TESTING → APPROVED
 *     → REGISTERED → ACTIVE → DEPRECATED → REMOVED
 *
 * Handler context (end-to-end cancellation + structured services):
 *   handler(args, { signal, context, logger, task, permissions, sandbox, tool })
 *
 * Pure JavaScript (ES modules). No TypeScript, no build step.
 */

import { createLogger } from '../core/logger.js';
import {
  ToolLifecycle,
  createToolMetadata,
  transitionLifecycle,
  promoteToActive,
  recordExecutionMetrics,
  EXECUTABLE_LIFECYCLES,
  SCHEMA_LIFECYCLES,
  canTransitionLifecycle,
} from './lifecycle.js';
import {
  resolveToolPermissions,
  resolveToolRisk,
  checkPermissions,
  resolveProfile,
  shouldRequireApproval,
  ApprovalManager,
  normalizePermissions,
} from '../security/permissions.js';
import { createSandbox, levelFromPermissions } from '../security/sandbox.js';

const log = createLogger('tools');

export class ToolError extends Error {
  constructor(message, code = 'TOOL_ERROR') {
    super(message);
    this.name = 'ToolError';
    this.code = code;
  }
}

/**
 * @typedef {Object} ToolParamSchema
 * @property {string} type - 'string' | 'number' | 'boolean' | 'object' | 'array'
 * @property {boolean} [required]
 * @property {any[]} [enum]
 * @property {string} [description]
 *
 * @typedef {Object} ToolDefinition
 * @property {string} name
 * @property {string} description
 * @property {Object<string, ToolParamSchema>} [parameters]
 * @property {Function} handler - async (args, ctx) => any
 * @property {number} [timeoutMs=15000]
 * @property {boolean} [requiresApproval=false]
 * @property {Object} [permissions]
 * @property {string} [risk]
 * @property {Object} [metadata]
 * @property {string} [lifecycle] initial lifecycle (default: promoted to ACTIVE)
 * @property {boolean} [autoActivate=true] walk lifecycle to ACTIVE on register
 */

const DEFAULT_TIMEOUT_MS = 15000;

export class ToolRegistry {
  /**
   * @param {Object} [opts]
   * @param {string|Object} [opts.profile='developer'] permission profile
   * @param {import('../security/sandbox.js').Sandbox} [opts.sandbox]
   * @param {string} [opts.filesRoot] used when constructing a default sandbox
   * @param {ApprovalManager} [opts.approvals]
   * @param {Object} [opts.context] ambient agent context forwarded to handlers
   */
  constructor(opts = {}) {
    /** @type {Map<string, Object>} */
    this._tools = new Map();
    this.profile = resolveProfile(opts.profile || process.env.SCRAPPYAI_PERMISSION_PROFILE || 'developer');
    this.sandbox = opts.sandbox || createSandbox({
      rootDir: opts.filesRoot || process.env.SCRAPPYAI_FILES_ROOT || process.cwd(),
      level: levelFromPermissions(this.profile.permissions),
      allowSymlinksOutside: this.profile.permissions.filesystem === 'host',
    });
    this.approvals = opts.approvals || new ApprovalManager();
    this.context = opts.context || null;
    /** @type {Map<string, Object>} discovered-but-not-registered tool drafts */
    this._discovered = new Map();
  }

  /**
   * Discover a tool without activating it — starts at DISCOVERED / DRAFT.
   * Use promote()/activate() to walk it through the lifecycle.
   * @param {ToolDefinition} def
   */
  discover(def) {
    if (!def || typeof def !== 'object') {
      throw new ToolError('discover() requires a tool definition object.');
    }
    if (typeof def.name !== 'string' || !def.name.trim()) {
      throw new ToolError('Tool definition requires a non-empty string "name".');
    }
    if (this._tools.has(def.name) || this._discovered.has(def.name)) {
      throw new ToolError(`Tool "${def.name}" is already known.`);
    }
    const record = this._buildRecord(def, { lifecycle: ToolLifecycle.DISCOVERED, autoActivate: false });
    transitionLifecycle(record, ToolLifecycle.DRAFT);
    this._discovered.set(def.name, record);
    log.info('discover', { name: def.name, lifecycle: record.lifecycle });
    return this;
  }

  /**
   * Register a tool. By default walks the full lifecycle to ACTIVE so existing
   * call sites keep working. Pass `autoActivate:false` (or a specific
   * `lifecycle`) to stop earlier.
   * @param {ToolDefinition} def
   */
  register(def) {
    if (!def || typeof def !== 'object') {
      throw new ToolError('register() requires a tool definition object.');
    }
    if (typeof def.name !== 'string' || !def.name.trim()) {
      throw new ToolError('Tool definition requires a non-empty string "name".');
    }
    if (typeof def.handler !== 'function') {
      throw new ToolError(`Tool "${def.name}" requires a "handler" function.`);
    }
    if (this._tools.has(def.name)) {
      throw new ToolError(`Tool "${def.name}" is already registered.`);
    }

    // Promote from discovered draft if present.
    let record;
    if (this._discovered.has(def.name)) {
      record = this._discovered.get(def.name);
      this._discovered.delete(def.name);
      // Merge handler / fresher fields from def
      Object.assign(record, this._buildRecord({ ...record, ...def }, { lifecycle: record.lifecycle, autoActivate: false }));
    } else {
      record = this._buildRecord(def, {
        lifecycle: def.lifecycle || ToolLifecycle.DISCOVERED,
        autoActivate: def.autoActivate !== false && !def.lifecycle,
      });
    }

    if (def.autoActivate !== false && !def.lifecycle) {
      promoteToActive(record, { approvedBy: def.metadata?.approvedBy || 'system' });
    } else if (def.lifecycle) {
      record.lifecycle = def.lifecycle;
    } else {
      // autoActivate:false — leave at DRAFT / current, but mark REGISTERED if already approved
      if (record.lifecycle === ToolLifecycle.APPROVED) {
        transitionLifecycle(record, ToolLifecycle.REGISTERED);
      } else if (
        record.lifecycle === ToolLifecycle.DISCOVERED ||
        record.lifecycle === ToolLifecycle.DRAFT
      ) {
        // Ensure at least REGISTERED so it sits in the map; execution still gated by lifecycle.
        if (record.lifecycle === ToolLifecycle.DISCOVERED) transitionLifecycle(record, ToolLifecycle.DRAFT);
      }
    }

    // Always land in the main map once register() is called.
    if (
      record.lifecycle === ToolLifecycle.APPROVED ||
      record.lifecycle === ToolLifecycle.DRAFT ||
      record.lifecycle === ToolLifecycle.VALIDATING ||
      record.lifecycle === ToolLifecycle.TESTING
    ) {
      // Move to REGISTERED if approved; otherwise keep and store.
      if (record.lifecycle === ToolLifecycle.APPROVED) {
        transitionLifecycle(record, ToolLifecycle.REGISTERED);
      }
    }

    this._tools.set(def.name, record);
    log.info('register', {
      name: def.name,
      parameters: Object.keys(def.parameters || {}),
      timeoutMs: record.timeoutMs,
      requiresApproval: record.requiresApproval,
      lifecycle: record.lifecycle,
      risk: record.risk,
      permissions: record.permissions,
      totalTools: this._tools.size,
    });
    return this;
  }

  /**
   * Walk a registered (or discovered) tool to a new lifecycle state.
   * @param {string} name
   * @param {string} to
   * @param {Object} [meta]
   */
  setLifecycle(name, to, meta = {}) {
    const tool = this._tools.get(name) || this._discovered.get(name);
    if (!tool) throw new ToolError(`Unknown tool "${name}".`, 'UNKNOWN_TOOL');
    transitionLifecycle(tool, to, meta);
    // If moved to REMOVED, drop from active map.
    if (to === ToolLifecycle.REMOVED) {
      this._tools.delete(name);
      this._discovered.delete(name);
    } else if (this._discovered.has(name) && (to === ToolLifecycle.REGISTERED || to === ToolLifecycle.ACTIVE)) {
      this._discovered.delete(name);
      this._tools.set(name, tool);
    }
    return tool;
  }

  /** Activate a registered tool (REGISTERED → ACTIVE). */
  activate(name) {
    const tool = this._tools.get(name);
    if (!tool) throw new ToolError(`Unknown tool "${name}".`, 'UNKNOWN_TOOL');
    if (tool.lifecycle === ToolLifecycle.ACTIVE) return tool;
    if (tool.lifecycle === ToolLifecycle.REGISTERED) {
      return this.setLifecycle(name, ToolLifecycle.ACTIVE);
    }
    // Allow re-activation from DEPRECATED.
    if (tool.lifecycle === ToolLifecycle.DEPRECATED) {
      return this.setLifecycle(name, ToolLifecycle.ACTIVE);
    }
    // Full promote path for drafts.
    promoteToActive(tool);
    return tool;
  }

  /** Deprecate a tool (still executable, warned). */
  deprecate(name, reason = null, replacedBy = null) {
    return this.setLifecycle(name, ToolLifecycle.DEPRECATED, { reason, replacedBy });
  }

  /** Remove a tool permanently. */
  remove(name) {
    return this.setLifecycle(name, ToolLifecycle.REMOVED);
  }

  /** Remove a registered tool. Returns true if it existed. (legacy alias) */
  unregister(name) {
    const existed = this._tools.delete(name) || this._discovered.delete(name);
    log.info('unregister', { name, existed, totalTools: this._tools.size });
    return existed;
  }

  has(name) {
    return this._tools.has(name);
  }

  get(name) {
    return this._tools.get(name);
  }

  /**
   * List tools. By default only non-removed registered tools.
   * @param {Object} [opts]
   * @param {string[]} [opts.lifecycle] filter by lifecycle states
   * @param {boolean} [opts.includeDiscovered=false]
   */
  list(opts = {}) {
    const out = Array.from(this._tools.values());
    if (opts.includeDiscovered) out.push(...this._discovered.values());
    if (Array.isArray(opts.lifecycle) && opts.lifecycle.length) {
      return out.filter((t) => opts.lifecycle.includes(t.lifecycle));
    }
    return out;
  }

  /**
   * Render tool definitions into a plain schema array suitable for feeding a
   * reasoner/LLM. Only ACTIVE tools are advertised by default.
   */
  toSchema(opts = {}) {
    const lifecycles = opts.lifecycle || SCHEMA_LIFECYCLES;
    return this.list({ lifecycle: lifecycles }).map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      // Extra metadata the model may find useful (harmless if ignored)
      risk: t.risk,
      requiresApproval: t.requiresApproval,
    }));
  }

  /**
   * Full metadata dump for operator UIs / debugging.
   */
  toMetadata() {
    return this.list({ includeDiscovered: true }).map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      timeoutMs: t.timeoutMs,
      requiresApproval: t.requiresApproval,
      lifecycle: t.lifecycle,
      risk: t.risk,
      permissions: t.permissions,
      metadata: t.metadata,
    }));
  }

  /**
   * Validate args against a tool's parameter schema.
   * @returns {{ok:true}|{ok:false,errors:string[]}}
   */
  validate(name, args) {
    const tool = this._tools.get(name);
    if (!tool) return { ok: false, errors: [`Unknown tool "${name}".`] };

    const errors = [];
    const schema = tool.parameters || {};
    const input = args && typeof args === 'object' ? args : {};

    for (const [key, spec] of Object.entries(schema)) {
      const present = Object.prototype.hasOwnProperty.call(input, key);
      if (spec.required && !present) {
        errors.push(`Missing required argument "${key}".`);
        continue;
      }
      if (!present) continue;

      const value = input[key];
      if (spec.type && !matchesType(value, spec.type)) {
        errors.push(`Argument "${key}" must be of type "${spec.type}", got "${typeOf(value)}".`);
        continue;
      }
      if (Array.isArray(spec.enum) && !spec.enum.includes(value)) {
        errors.push(`Argument "${key}" must be one of [${spec.enum.join(', ')}], got "${value}".`);
      }
    }

    return errors.length ? { ok: false, errors } : { ok: true, errors: [] };
  }

  /**
   * Check whether the current profile allows executing this tool.
   * @param {string} name
   * @returns {{ok:true}|{ok:false,error:string,code:string,denied?:any[]}}
   */
  checkToolPermissions(name) {
    const tool = this._tools.get(name);
    if (!tool) return { ok: false, error: `Unknown tool "${name}".`, code: 'UNKNOWN_TOOL' };
    return checkPermissions(tool.permissions, this.profile.permissions);
  }

  /**
   * Whether a tool call should pause for approval under the current profile
   * and session grants.
   * @param {string} name
   * @param {Object} [request]
   * @returns {boolean}
   */
  requiresApproval(name, request = {}) {
    const tool = this._tools.get(name);
    if (!tool) return false;

    const session = this.approvals.lookup({ tool: name, ...request });
    if (session === 'granted') return false;
    if (session === 'denied') return true;

    if (tool.requiresApproval) return true;
    return shouldRequireApproval(tool, this.profile);
  }

  /**
   * Swap the active permission profile (e.g. escalate to admin mid-session).
   * @param {string|Object} profile
   */
  setProfile(profile) {
    this.profile = resolveProfile(profile);
    log.info('profile:set', { name: this.profile.name, permissions: this.profile.permissions });
    return this.profile;
  }

  /**
   * Execute a tool by name with validation, permission check, lifecycle gate,
   * timeout, and safe error capture. Never throws — always resolves to a
   * result object.
   *
   * @param {string} name
   * @param {object} args
   * @param {Object} [runCtx]
   * @param {AbortSignal} [runCtx.signal]
   * @param {Object} [runCtx.context] ambient agent context
   * @param {Object} [runCtx.task] current Task (if any)
   * @param {Object} [runCtx.logger] override logger
   * @param {Object} [runCtx.permissions] override granted permissions for this call
   * @returns {Promise<{ok:boolean, data?:any, error?:string, code?:string, durationMs:number}>}
   */
  async execute(name, args, runCtx = {}) {
    const startedAt = Date.now();
    const tool = this._tools.get(name);
    log.debug('execute:start', { name, args });

    if (!tool) {
      return this._fail(name, args, startedAt, `Unknown tool "${name}".`, 'UNKNOWN_TOOL');
    }

    // Lifecycle gate — only ACTIVE / DEPRECATED may run.
    if (!EXECUTABLE_LIFECYCLES.includes(tool.lifecycle)) {
      return this._fail(
        name,
        args,
        startedAt,
        `Tool "${name}" is not executable in lifecycle state "${tool.lifecycle}".`,
        'TOOL_NOT_ACTIVE'
      );
    }

    if (tool.lifecycle === ToolLifecycle.DEPRECATED) {
      log.warn('execute:deprecated', {
        name,
        replacedBy: tool.metadata?.replacedBy,
        reason: tool.metadata?.deprecatedReason,
      });
    }

    // Permission gate
    const granted = runCtx.permissions
      ? normalizePermissions(runCtx.permissions)
      : this.profile.permissions;
    const perm = checkPermissions(tool.permissions, granted);
    if (!perm.ok) {
      return this._fail(name, args, startedAt, perm.error, perm.code || 'PERMISSION_DENIED', { denied: perm.denied });
    }

    // Session denial
    if (this.approvals.lookup({ tool: name }) === 'denied') {
      return this._fail(name, args, startedAt, `Tool "${name}" is denied for this session.`, 'SESSION_DENIED');
    }

    // Already-aborted signal
    if (runCtx.signal && runCtx.signal.aborted) {
      return this._fail(name, args, startedAt, abortMessage(runCtx.signal), 'ABORTED');
    }

    const validation = this.validate(name, args);
    if (!validation.ok) {
      return this._fail(
        name,
        args,
        startedAt,
        `Invalid arguments for "${name}": ${validation.errors.join('; ')}`,
        'VALIDATION_ERROR',
        { errors: validation.errors }
      );
    }

    // Build the rich handler context — every tool sees the same shape.
    const handlerCtx = {
      signal: runCtx.signal,
      context: runCtx.context || this.context,
      logger: runCtx.logger || createLogger(`tools:${name}`),
      task: runCtx.task || null,
      permissions: granted,
      sandbox: this.sandbox,
      tool: {
        name: tool.name,
        lifecycle: tool.lifecycle,
        risk: tool.risk,
        permissions: tool.permissions,
        metadata: tool.metadata,
      },
      registry: this,
    };

    try {
      const data = await runWithTimeoutAndSignal(
        () => tool.handler(args || {}, handlerCtx),
        tool.timeoutMs,
        name,
        runCtx.signal
      );
      const durationMs = Date.now() - startedAt;
      const result = { ok: true, data, durationMs };
      recordExecutionMetrics(tool, result);
      log.info('execute:done', { name, args, ok: true, output: data, durationMs, lifecycle: tool.lifecycle });
      return result;
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      const code = (err && err.code) || 'TOOL_EXECUTION_ERROR';
      const result = {
        ok: false,
        error: err && err.message ? err.message : String(err),
        code,
        durationMs,
      };
      recordExecutionMetrics(tool, result);
      log.error('execute:done', {
        name,
        args,
        ok: false,
        code: result.code,
        error: result.error,
        durationMs,
      });
      return result;
    }
  }

  /**
   * Execute many independent tool calls concurrently.
   * @param {Array<{name:string, args?:object}>} calls
   * @param {Object} [runCtx] same as execute(), plus concurrency/onError
   */
  async executeParallel(calls, runCtx = {}) {
    const { parallel } = await import('../planning/parallel-executor.js');
    const { concurrency = 4, onError = 'collect', signal, ...rest } = runCtx;
    const summary = await parallel(
      calls.map((c) => async ({ signal: s }) => {
        const result = await this.execute(c.name, c.args || {}, { ...rest, signal: s });
        if (!result.ok) {
          const err = new Error(result.error || 'tool failed');
          err.code = result.code;
          err.toolResult = result;
          throw err;
        }
        return result;
      }),
      { concurrency, onError, signal }
    );
    // Re-shape: expose tool results directly
    return {
      ...summary,
      results: summary.results.map((r, i) => {
        if (r.ok) return { ...r.data, index: i, name: calls[i].name };
        // Prefer the structured toolResult if the runner threw one
        const tr = r.error && summary.failures; // fallthrough
        return {
          ok: false,
          index: i,
          name: calls[i].name,
          error: r.error,
          code: r.code,
          durationMs: r.durationMs,
          attempts: r.attempts,
        };
      }),
    };
  }

  // --- internals -----------------------------------------------------------

  _buildRecord(def, { lifecycle, autoActivate }) {
    const permissions = resolveToolPermissions(def);
    const risk = resolveToolRisk(def);
    const metadata = createToolMetadata({
      ...(def.metadata || {}),
      permissions,
      requiresApproval: !!def.requiresApproval,
      risk,
      category: def.metadata?.category || def.category || inferCategory(def.name),
      tags: def.metadata?.tags || def.tags,
      version: def.metadata?.version || def.version,
      author: def.metadata?.author || def.author,
      sideEffects: def.metadata?.sideEffects || def.sideEffects,
    });

    return {
      name: def.name,
      description: def.description || '',
      parameters: def.parameters || {},
      handler: def.handler,
      timeoutMs: def.timeoutMs || DEFAULT_TIMEOUT_MS,
      requiresApproval: !!def.requiresApproval || risk === 'critical',
      permissions,
      risk,
      metadata,
      lifecycle: lifecycle || ToolLifecycle.DISCOVERED,
      autoActivate: autoActivate !== false,
    };
  }

  _fail(name, args, startedAt, error, code, extra = {}) {
    const result = {
      ok: false,
      error,
      code,
      durationMs: Date.now() - startedAt,
      ...extra,
    };
    log.warn('execute:done', { name, args, ok: false, code, error, durationMs: result.durationMs });
    return result;
  }
}

/**
 * Run fn() with a timeout AND AbortSignal. Aborting rejects with code ABORTED;
 * timeout rejects with TOOL_TIMEOUT. Both are cooperative for the timer; the
 * signal is also forwarded so the handler can stop in-flight I/O.
 */
function runWithTimeoutAndSignal(fn, timeoutMs, toolName, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const settle = (fnSettle, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fnSettle(value);
    };

    const onAbort = () => {
      settle(reject, Object.assign(new Error(`Tool "${toolName}" aborted.`), { code: 'ABORTED' }));
    };

    const timer = setTimeout(() => {
      settle(
        reject,
        new ToolError(`Tool "${toolName}" timed out after ${timeoutMs}ms.`, 'TOOL_TIMEOUT')
      );
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    };

    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    Promise.resolve()
      .then(fn)
      .then((result) => settle(resolve, result))
      .catch((err) => settle(reject, err));
  });
}

function abortMessage(signal) {
  if (signal && signal.reason && signal.reason.message) return signal.reason.message;
  if (signal && typeof signal.reason === 'string') return signal.reason;
  return 'aborted';
}

function inferCategory(name) {
  if (!name) return 'general';
  if (/^(read|write|edit|list|search_files|make_dir|move|copy|delete)_?file|list_dir|make_dir/.test(name)) return 'filesystem';
  if (/^shell/.test(name)) return 'shell';
  if (/^code_/.test(name)) return 'code';
  if (/^(npm|package_)/.test(name)) return 'package';
  if (/^plan_/.test(name)) return 'planning';
  if (/^verify_/.test(name)) return 'verification';
  if (/search|web_/.test(name)) return 'web';
  return 'general';
}

function typeOf(value) {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
}

function matchesType(value, type) {
  switch (type) {
    case 'array':
      return Array.isArray(value);
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && !Number.isNaN(value);
    case 'boolean':
      return typeof value === 'boolean';
    default:
      return true;
  }
}

// Re-export lifecycle symbols so consumers can `import { ToolLifecycle } from './registry.js'`.
export {
  ToolLifecycle,
  createToolMetadata,
  transitionLifecycle,
  promoteToActive,
  canTransitionLifecycle,
  EXECUTABLE_LIFECYCLES,
  SCHEMA_LIFECYCLES,
};

export default ToolRegistry;
