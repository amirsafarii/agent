/**
 * tools/registry.js — ToolRegistry
 * ---------------------------------
 * Registry is responsible for registration, plugin ownership, discovery and
 * definitions. It deliberately does not execute business logic. Execution is
 * delegated to ToolRunner, which owns validation, permissions, middleware,
 * timeout/abort and result normalization.
 *
 * `execute()` remains as a compatibility adapter for older ScrappyAi callers.
 * New code should use `run()` and receive the standard `{ error: { code,
 * message } }` result shape.
 *
 * Pure JavaScript (ES modules). No TypeScript, no build step.
 */

import { createLogger } from '../core/logger.js';
import {
  ToolLifecycle,
  createToolMetadata,
  transitionLifecycle,
  promoteToActive,
  EXECUTABLE_LIFECYCLES,
  SCHEMA_LIFECYCLES,
} from './lifecycle.js';
import { ToolRunner } from './runner.js';
import { ToolError } from './errors.js';
import { normalizeInputSchema, legacyParametersFromSchema, validateInput } from './schema.js';
import { toLegacyResult } from './result.js';
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
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * @typedef {Object} ToolDefinition
 * @property {string} name
 * @property {string} description
 * @property {Object} [inputSchema] JSON Schema object for the input
 * @property {Object<string,Object>} [parameters] legacy parameter-map alias
 * @property {Function} execute async (input, context) => any
 * @property {Function} handler legacy alias for execute
 * @property {number} [timeoutMs=15000]
 * @property {boolean} [enabled=true]
 * @property {boolean} [requiresApproval=false]
 * @property {Object|string[]} [permissions]
 * @property {string} [risk]
 * @property {Object} [metadata] arbitrary stable metadata
 */

export class ToolRegistry {
  /**
   * @param {Object} [opts]
   * @param {string|Object} [opts.profile='developer'] permission profile
   * @param {import('../security/sandbox.js').Sandbox} [opts.sandbox]
   * @param {string} [opts.filesRoot]
   * @param {ApprovalManager} [opts.approvals]
   * @param {Object} [opts.context] ambient ContextWindow forwarded through ToolContext
   * @param {Object} [opts.config] tool configuration exposed through ToolContext
   * @param {Object} [opts.memory] memory capability exposed through ToolContext
   * @param {Array<Function|Object>} [opts.middleware] runner middleware
   */
  constructor(opts = {}) {
    /** @type {Map<string, Object>} */
    this._tools = new Map();
    /** @type {Map<string, Object>} */
    this._plugins = new Map();
    /** @type {Map<string, Object>} */
    this._discovered = new Map();

    this.profile = resolveProfile(opts.profile || process.env.SCRAPPYAI_PERMISSION_PROFILE || 'developer');
    this.sandbox = opts.sandbox || createSandbox({
      rootDir: opts.filesRoot || process.env.SCRAPPYAI_FILES_ROOT || process.cwd(),
      level: levelFromPermissions(this.profile.permissions),
      allowSymlinksOutside: this.profile.permissions.filesystem === 'host',
    });
    this.approvals = opts.approvals || new ApprovalManager();
    this.context = opts.context || null;
    this.config = opts.config || {};
    this.memory = opts.memory ?? null;
    this.capabilities = opts.capabilities || {};

    this.runner = opts.runner || new ToolRunner({
      registry: this,
      defaultTimeoutMs: opts.defaultTimeoutMs,
      config: this.config,
      memory: this.memory,
      middleware: opts.middleware,
    });
    // A supplied runner is still attached to this registry so it can discover
    // records without importing Registry (avoids a circular dependency).
    if (opts.runner) this.runner.registry = this;
    // Descriptive alias for hosts that prefer the class name in their wiring.
    this.toolRunner = this.runner;
  }

  /**
   * Register a single Tool. Both the new `{execute, inputSchema}` contract and
   * the old `{handler, parameters}` form are accepted and normalized to one
   * internal record.
   */
  register(def, options = {}) {
    return this._register(def, options);
  }

  _register(def, options = {}) {
    if (!def || typeof def !== 'object') {
      throw new ToolError('register() requires a tool definition object.');
    }
    if (typeof def.name !== 'string' || !def.name.trim()) {
      throw new ToolError('Tool definition requires a non-empty string "name".');
    }
    if (typeof def.execute !== 'function' && typeof def.handler !== 'function') {
      throw new ToolError(
        `Tool "${def.name}" requires an "execute" function (legacy "handler" is also supported).`
      );
    }
    if (this._tools.has(def.name)) {
      throw new ToolError(`Tool "${def.name}" is already registered.`);
    }

    const definition = options.plugin
      ? withPluginMetadata(def, options.plugin)
      : def;

    // Promote from a discovered draft if present.
    let record;
    if (this._discovered.has(definition.name)) {
      record = this._discovered.get(definition.name);
      this._discovered.delete(definition.name);
      const merged = { ...record, ...definition };
      record = this._buildRecord(merged, {
        lifecycle: record.lifecycle,
        autoActivate: false,
      });
    } else {
      record = this._buildRecord(definition, {
        lifecycle: definition.lifecycle || ToolLifecycle.DISCOVERED,
        autoActivate: definition.autoActivate !== false && !definition.lifecycle,
      });
    }

    if (definition.autoActivate !== false && !definition.lifecycle) {
      promoteToActive(record, { approvedBy: definition.metadata?.approvedBy || 'system' });
    } else if (definition.lifecycle) {
      record.lifecycle = definition.lifecycle;
    } else if (record.lifecycle === ToolLifecycle.APPROVED) {
      transitionLifecycle(record, ToolLifecycle.REGISTERED);
    } else if (record.lifecycle === ToolLifecycle.DISCOVERED) {
      transitionLifecycle(record, ToolLifecycle.DRAFT);
    }

    // A manually supplied APPROVED lifecycle is still registered, not silently
    // executable, until its normal lifecycle transition is completed.
    if (record.lifecycle === ToolLifecycle.APPROVED) transitionLifecycle(record, ToolLifecycle.REGISTERED);

    this._tools.set(definition.name, record);
    log.info('register', {
      name: definition.name,
      parameters: Object.keys(record.parameters || {}),
      timeoutMs: record.timeoutMs,
      requiresApproval: record.requiresApproval,
      lifecycle: record.lifecycle,
      risk: record.risk,
      permissions: record.permissions,
      plugin: record.pluginName || null,
      totalTools: this._tools.size,
    });
    return this;
  }

  /**
   * Mount a static plugin. A plugin is only a named container; each contained
   * Tool is registered independently and therefore follows the exact same
   * pipeline as a custom Tool.
   *
   * @param {{name:string, tools:Object[], metadata?:Object}} plugin
   */
  use(plugin) {
    if (!plugin || typeof plugin !== 'object') {
      throw new ToolError('use() requires a plugin object.');
    }
    if (typeof plugin.name !== 'string' || !plugin.name.trim()) {
      throw new ToolError('Plugin requires a non-empty string "name".');
    }
    if (!Array.isArray(plugin.tools)) {
      throw new ToolError(`Plugin "${plugin.name}" requires a "tools" array.`);
    }
    if (this._plugins.has(plugin.name)) {
      throw new ToolError(`Plugin "${plugin.name}" is already mounted.`);
    }

    const mounted = {
      name: plugin.name,
      metadata: cloneValue(plugin.metadata || {}),
      tools: [],
      plugin,
    };
    try {
      for (const tool of plugin.tools) {
        if (!tool || typeof tool !== 'object') {
          throw new ToolError(`Plugin "${plugin.name}" contains an invalid tool.`);
        }
        this._register(tool, { plugin: mounted });
        mounted.tools.push(tool.name);
      }
      this._plugins.set(plugin.name, mounted);
      log.info('plugin:use', { name: plugin.name, tools: mounted.tools, metadata: mounted.metadata });
      return this;
    } catch (err) {
      // Keep mounting atomic: a duplicate or malformed tool does not leave a
      // half-mounted plugin behind.
      for (const name of mounted.tools) this.unregister(name);
      throw err;
    }
  }

  /** Remove every Tool owned by a plugin. */
  removePlugin(name) {
    const mounted = this._plugins.get(name);
    if (!mounted) return false;
    for (const toolName of [...mounted.tools]) this.unregister(toolName);
    this._plugins.delete(name);
    log.info('plugin:remove', { name, tools: mounted.tools });
    return true;
  }

  getPlugin(name) {
    const mounted = this._plugins.get(name);
    if (!mounted) return undefined;
    return {
      name: mounted.name,
      metadata: cloneValue(mounted.metadata),
      tools: [...mounted.tools],
    };
  }

  listPlugins() {
    return [...this._plugins.values()].map((mounted) => ({
      name: mounted.name,
      metadata: cloneValue(mounted.metadata),
      tools: [...mounted.tools],
    }));
  }

  /** Discover a lifecycle draft without activating it (legacy lifecycle API). */
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
    const record = this._buildRecord(def, {
      lifecycle: ToolLifecycle.DISCOVERED,
      autoActivate: false,
    });
    transitionLifecycle(record, ToolLifecycle.DRAFT);
    this._discovered.set(def.name, record);
    log.info('discover', { name: def.name, lifecycle: record.lifecycle });
    return this;
  }

  /** Walk a registered (or discovered) tool to a lifecycle state. */
  setLifecycle(name, to, meta = {}) {
    const tool = this._tools.get(name) || this._discovered.get(name);
    if (!tool) throw new ToolError(`Unknown tool "${name}".`, 'UNKNOWN_TOOL');
    transitionLifecycle(tool, to, meta);
    if (to === ToolLifecycle.REMOVED) {
      this._tools.delete(name);
      this._discovered.delete(name);
    } else if (this._discovered.has(name) && (to === ToolLifecycle.REGISTERED || to === ToolLifecycle.ACTIVE)) {
      this._discovered.delete(name);
      this._tools.set(name, tool);
    }
    return tool;
  }

  activate(name) {
    const tool = this._tools.get(name);
    if (!tool) throw new ToolError(`Unknown tool "${name}".`, 'UNKNOWN_TOOL');
    if (tool.lifecycle === ToolLifecycle.ACTIVE) return tool;
    if (tool.lifecycle === ToolLifecycle.REGISTERED || tool.lifecycle === ToolLifecycle.DEPRECATED) {
      return this.setLifecycle(name, ToolLifecycle.ACTIVE);
    }
    promoteToActive(tool);
    return tool;
  }

  deprecate(name, reason = null, replacedBy = null) {
    return this.setLifecycle(name, ToolLifecycle.DEPRECATED, { reason, replacedBy });
  }

  remove(name) {
    return this.setLifecycle(name, ToolLifecycle.REMOVED);
  }

  unregister(name) {
    const existed = this._tools.delete(name) || this._discovered.delete(name);
    // Remove the ownership reference without recursively unregistering.
    for (const mounted of this._plugins.values()) {
      mounted.tools = mounted.tools.filter((toolName) => toolName !== name);
    }
    log.info('unregister', { name, existed, totalTools: this._tools.size });
    return existed;
  }

  has(name) {
    return this._tools.has(name);
  }

  get(name) {
    return this._tools.get(name);
  }

  list(opts = {}) {
    const out = Array.from(this._tools.values());
    if (opts.includeDiscovered) out.push(...this._discovered.values());
    if (Array.isArray(opts.lifecycle) && opts.lifecycle.length) {
      return out.filter((tool) => opts.lifecycle.includes(tool.lifecycle));
    }
    return out;
  }

  /**
   * Legacy/provider-shaped definitions. New Router/LLM integrations should
   * use getDefinitions(), which exposes the canonical JSON Schema.
   */
  toSchema(opts = {}) {
    const lifecycles = opts.lifecycle || SCHEMA_LIFECYCLES;
    return this.list({ lifecycle: lifecycles })
      .filter((tool) => tool.enabled !== false)
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: cloneValue(tool.parameters),
        risk: tool.risk,
        requiresApproval: tool.requiresApproval,
      }));
  }

  /**
   * Public LLM definition surface. It contains only what is needed to choose
   * and call a Tool; execute/handler, permissions, plugin internals and Agent
   * state never enter the prompt.
   */
  getDefinitions(opts = {}) {
    const lifecycles = opts.lifecycle || SCHEMA_LIFECYCLES;
    return this.list({ lifecycle: lifecycles })
      .filter((tool) => opts.includeDisabled || tool.enabled !== false)
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: cloneValue(tool.inputSchema),
      }));
  }

  toMetadata() {
    return this.list({ includeDiscovered: true }).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: cloneValue(tool.inputSchema),
      parameters: cloneValue(tool.parameters),
      timeoutMs: tool.timeoutMs,
      enabled: tool.enabled,
      requiresApproval: tool.requiresApproval,
      lifecycle: tool.lifecycle,
      risk: tool.risk,
      permissions: cloneValue(tool.permissions),
      plugin: tool.pluginName || null,
      metadata: cloneValue(tool.metadata),
    }));
  }

  /** Central validation API (delegates only to the schema layer). */
  validate(name, args) {
    const tool = this._tools.get(name);
    if (!tool) return { ok: false, errors: [`Unknown tool "${name}".`] };
    return validateInput(tool.inputSchema, args);
  }

  checkToolPermissions(name, options = {}) {
    const tool = this._tools.get(name);
    if (!tool) return { ok: false, error: `Unknown tool "${name}".`, code: 'UNKNOWN_TOOL' };
    const granted = options.permissions
      ? normalizePermissions(options.permissions)
      : this.profile.permissions;
    return checkPermissions(tool.permissions, granted);
  }

  requiresApproval(name, request = {}) {
    const tool = this._tools.get(name);
    if (!tool) return false;
    const session = this.approvals.lookup({ tool: name, ...request });
    if (session === 'granted') return false;
    if (session === 'denied') return true;
    if (tool.requiresApproval) return true;
    return shouldRequireApproval(tool, this.profile);
  }

  setProfile(profile) {
    this.profile = resolveProfile(profile);
    log.info('profile:set', { name: this.profile.name, permissions: this.profile.permissions });
    return this.profile;
  }

  /** Standard execution API; business logic lives in ToolRunner. */
  run(name, input, options = {}) {
    return this.runner.run(name, input, options);
  }

  /**
   * Legacy execution adapter. It preserves top-level `code` and string
   * `error` fields for older Agent integrations; the runner itself remains
   * standard and independently usable.
   */
  async execute(name, args, runCtx = {}) {
    const result = await this.run(name, args, runCtx);
    return toLegacyResult(result);
  }

  async executeParallel(calls, runCtx = {}) {
    const { parallel } = await import('../planning/parallel-executor.js');
    const { concurrency = 4, onError = 'collect', signal, ...rest } = runCtx;
    const summary = await parallel(
      calls.map((call) => async ({ signal: childSignal }) => {
        const result = await this.execute(call.name, call.args || {}, { ...rest, signal: childSignal });
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
    return {
      ...summary,
      results: summary.results.map((result, index) => {
        if (result.ok) return { ...result.data, index, name: calls[index].name };
        return {
          ok: false,
          index,
          name: calls[index].name,
          error: result.error,
          code: result.code,
          durationMs: result.durationMs,
          attempts: result.attempts,
        };
      }),
    };
  }

  toolContract(name) {
    const tool = this._tools.get(name);
    if (!tool) return null;
    return {
      name: tool.name,
      version: tool.metadata?.version || '0.0.0',
      inputSchema: cloneValue(tool.declaredInputSchema || tool.inputSchema),
      outputSchema: cloneValue(tool.outputSchema || {}),
      description: tool.description || '',
    };
  }

  listContracts() {
    return [...this._tools.values()].map((tool) => ({
      name: tool.name,
      version: tool.metadata?.version || '0.0.0',
    }));
  }

  _buildRecord(def, { lifecycle, autoActivate }) {
    const rawInputSchema = def.inputSchema ?? def.parameters ?? {};
    const inputSchema = normalizeInputSchema(rawInputSchema);
    const parameters = def.parameters && !isCanonicalSchema(def.parameters)
      ? cloneValue(def.parameters)
      : legacyParametersFromSchema(inputSchema);
    const category = def.metadata?.category || def.category || inferCategory(def.name);
    const metadata = createToolMetadata({
      ...(def.metadata || {}),
      permissions: resolveToolPermissions(def),
      requiresApproval: !!def.requiresApproval,
      risk: resolveToolRisk(def),
      category,
      tags: def.metadata?.tags || def.tags,
      version: def.metadata?.version || def.version,
      author: def.metadata?.author || def.author,
      sideEffects: def.metadata?.sideEffects || def.sideEffects,
      traceName: def.metadata?.traceName || defaultTraceName(category),
      source: def.metadata?.source || def.source || (def.pluginName ? 'plugin' : undefined),
    });

    return {
      name: def.name,
      description: def.description || '',
      inputSchema,
      // Keep the author-declared shape for the versioned contract API. The
      // runner still uses normalized `inputSchema` for every validation call.
      declaredInputSchema: def.inputSchema ? cloneValue(def.inputSchema) : null,
      parameters,
      outputSchema: def.outputSchema || null,
      execute: def.execute || def.handler,
      // The alias is intentionally retained for old inspection code. Runner
      // calls `execute`, so both forms use the same execution pipeline.
      handler: def.handler || def.execute,
      timeoutMs: Number.isFinite(def.timeoutMs) ? def.timeoutMs : DEFAULT_TIMEOUT_MS,
      enabled: def.enabled !== false,
      disabled: def.enabled === false,
      disabledReason: def.disabledReason || null,
      requiresApproval: !!def.requiresApproval || resolveToolRisk(def) === 'critical',
      permissions: resolveToolPermissions(def),
      risk: resolveToolRisk(def),
      metadata,
      pluginName: def.pluginName || def.metadata?.plugin || null,
      pluginMetadata: cloneValue(def.pluginMetadata || def.metadata?.pluginMetadata || null),
      lifecycle: lifecycle || ToolLifecycle.DISCOVERED,
      autoActivate: autoActivate !== false,
    };
  }
}

function withPluginMetadata(def, plugin) {
  const metadata = {
    ...(def.metadata || {}),
    source: def.metadata?.source || plugin.metadata?.source || 'plugin',
    plugin: plugin.name,
    ...(plugin.metadata?.category && !def.metadata?.category ? { category: plugin.metadata.category } : {}),
    pluginMetadata: cloneValue(plugin.metadata || {}),
  };
  return {
    ...def,
    pluginName: plugin.name,
    pluginMetadata: cloneValue(plugin.metadata || {}),
    metadata,
  };
}

function isCanonicalSchema(schema) {
  return !!(
    schema &&
    typeof schema === 'object' &&
    !Array.isArray(schema) &&
    (schema.type === 'object' || schema.properties || Array.isArray(schema.required))
  );
}

function inferCategory(name) {
  if (!name) return 'general';
  if (/^(read|write|edit|list|search_files|make_dir|move|copy|delete)_?file|list_dir|make_dir/.test(name)) return 'filesystem';
  if (/^shell/.test(name)) return 'shell';
  if (/^code_/.test(name)) return 'code';
  if (/^(npm|package_)/.test(name)) return 'package';
  if (/^plan_/.test(name)) return 'planning';
  if (/^spec_/.test(name)) return 'spec';
  if (/^todo_/.test(name)) return 'todo';
  if (/^verify_/.test(name)) return 'verification';
  if (/search|web_|^http_|^fetch_/.test(name)) return 'web';
  return 'general';
}

function defaultTraceName(category) {
  if (category === 'web') return 'tool.search';
  if (category === 'verification') return 'verification';
  return `tool.${category || 'custom'}`;
}

function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    // Function values cannot be part of a public schema/metadata clone.
    if (typeof child !== 'function') out[key] = cloneValue(child);
  }
  return out;
}

// Re-export lifecycle and error symbols from the historical module path.
export {
  ToolError,
  ToolLifecycle,
  createToolMetadata,
  transitionLifecycle,
  promoteToActive,
  EXECUTABLE_LIFECYCLES,
};

export default ToolRegistry;
