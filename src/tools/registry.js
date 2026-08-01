/**
 * tools/registry.js — Tool Registry
 * -----------------------------------------------
 * Register tools with a JSON-schema-ish contract, execute them with real
 * argument validation, a per-tool timeout, and error handling that never
 * throws out of the loop — every call resolves to a plain result object so
 * the reasoner can decide whether to retry, pick another tool, or give up.
 *
 * Pure JavaScript (ES modules). No TypeScript, no build step.
 */

import { createLogger } from '../core/logger.js';

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
 * @property {boolean} [requiresApproval=false] - gate every call through AgentLoop's
 *        AWAITING_TOOL_APPROVAL lifecycle state before it executes. See docs/LOOP.md → Tool Approval.
 */

const DEFAULT_TIMEOUT_MS = 15000;

export class ToolRegistry {
  constructor() {
    /** @type {Map<string, ToolDefinition>} */
    this._tools = new Map();
  }

  /**
   * Register a tool.
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
    this._tools.set(def.name, {
      name: def.name,
      description: def.description || '',
      parameters: def.parameters || {},
      handler: def.handler,
      timeoutMs: def.timeoutMs || DEFAULT_TIMEOUT_MS,
      requiresApproval: !!def.requiresApproval,
    });
    log.info('register', {
      name: def.name,
      parameters: Object.keys(def.parameters || {}),
      timeoutMs: def.timeoutMs || DEFAULT_TIMEOUT_MS,
      requiresApproval: !!def.requiresApproval,
      totalTools: this._tools.size,
    });
    return this;
  }

  /** Remove a registered tool. Returns true if it existed. */
  unregister(name) {
    const existed = this._tools.delete(name);
    log.info('unregister', { name, existed, totalTools: this._tools.size });
    return existed;
  }

  has(name) {
    return this._tools.has(name);
  }

  get(name) {
    return this._tools.get(name);
  }

  list() {
    return Array.from(this._tools.values());
  }

  /**
   * Render tool definitions into a plain schema array suitable for feeding a
   * reasoner/LLM (provider-agnostic shape: name/description/parameters).
   */
  toSchema() {
    return this.list().map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
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

    // reject unknown args? kept permissive by default; flip to strict if needed.
    return errors.length ? { ok: false, errors } : { ok: true, errors: [] };
  }

  /**
   * Execute a tool by name with validation, timeout, and safe error capture.
   * Never throws — always resolves to a result object.
   * @param {string} name
   * @param {object} args
   * @param {{signal?: AbortSignal}} [runCtx]
   * @returns {Promise<{ok:boolean, data?:any, error?:string, code?:string, durationMs:number}>}
   */
  async execute(name, args, runCtx = {}) {
    const startedAt = Date.now();
    const tool = this._tools.get(name);
    log.debug('execute:start', { name, args });

    if (!tool) {
      const result = {
        ok: false,
        error: `Unknown tool "${name}".`,
        code: 'UNKNOWN_TOOL',
        durationMs: Date.now() - startedAt,
      };
      log.warn('execute:done', { name, args, ok: false, code: result.code, durationMs: result.durationMs });
      return result;
    }

    const validation = this.validate(name, args);
    if (!validation.ok) {
      const result = {
        ok: false,
        error: `Invalid arguments for "${name}": ${validation.errors.join('; ')}`,
        code: 'VALIDATION_ERROR',
        durationMs: Date.now() - startedAt,
      };
      log.warn('execute:done', {
        name,
        args,
        ok: false,
        code: result.code,
        errors: validation.errors,
        durationMs: result.durationMs,
      });
      return result;
    }

    try {
      const data = await runWithTimeout(
        () => tool.handler(args || {}, { signal: runCtx.signal }),
        tool.timeoutMs,
        name
      );
      const result = { ok: true, data, durationMs: Date.now() - startedAt };
      log.info('execute:done', { name, args, ok: true, output: data, durationMs: result.durationMs });
      return result;
    } catch (err) {
      const result = {
        ok: false,
        error: err && err.message ? err.message : String(err),
        code: (err && err.code) || 'TOOL_EXECUTION_ERROR',
        durationMs: Date.now() - startedAt,
      };
      log.error('execute:done', {
        name,
        args,
        ok: false,
        code: result.code,
        error: result.error,
        durationMs: result.durationMs,
      });
      return result;
    }
  }
}

function runWithTimeout(fn, timeoutMs, toolName) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const err = new ToolError(`Tool "${toolName}" timed out after ${timeoutMs}ms.`, 'TOOL_TIMEOUT');
      reject(err);
    }, timeoutMs);

    Promise.resolve()
      .then(fn)
      .then((result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      })
      .catch((err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
  });
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
      return true; // unknown declared types are not enforced
  }
}

export default ToolRegistry;
