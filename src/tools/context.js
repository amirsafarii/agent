/**
 * tools/context.js — the stable boundary between Agent and Tool
 * ---------------------------------------------------------------
 * A Tool receives this object as its second argument. The object is deliberately
 * capability-shaped rather than an AgentLoop reference. New context services
 * can be added without changing the two-argument Tool contract.
 *
 * Pure JavaScript (ES modules).
 */

export class ToolContext {
  /**
   * @param {Object} [values]
   * @param {Object} [values.logger]
   * @param {Object} [values.config]
   * @param {Object|null} [values.memory]
   * @param {AbortSignal} [values.signal]
   * @param {Object} [values.capabilities]
   * @param {Object} [values.permissions]
   * @param {Object} [values.sandbox] legacy capability used by built-in FS/process tools
   * @param {Object} [values.tool] public tool metadata
   * @param {Object} [values.context] legacy ContextWindow reference, not AgentLoop internals
   * @param {Object} [values.task]
   * @param {Object} [values.run]
   */
  constructor(values = {}) {
    this.logger = values.logger || null;
    this.config = values.config && typeof values.config === 'object' ? values.config : {};
    this.memory = values.memory ?? null;
    this.signal = values.signal;
    this.capabilities = values.capabilities && typeof values.capabilities === 'object'
      ? values.capabilities
      : {};
    this.permissions = values.permissions && typeof values.permissions === 'object'
      ? values.permissions
      : {};
    this.sandbox = values.sandbox || null;
    this.tool = values.tool || null;
    this.context = values.context || null;
    this.task = values.task || null;
    this.run = values.run || null;

    // Kept non-enumerable as a narrow compatibility bridge for older tools
    // that used ctx.registry. New tools should request services through
    // `capabilities`/`config` instead; this is not an AgentLoop reference.
    if (values.registry) {
      Object.defineProperty(this, 'registry', {
        configurable: true,
        enumerable: false,
        value: values.registry,
        writable: false,
      });
    }
  }

  /** Whether a named capability was provided by the host. */
  hasCapability(name) {
    return Object.prototype.hasOwnProperty.call(this.capabilities, name)
      && this.capabilities[name] !== false
      && this.capabilities[name] != null;
  }

  /** Return a capability or a fallback without reaching into Agent internals. */
  getCapability(name, fallback = undefined) {
    return this.hasCapability(name) ? this.capabilities[name] : fallback;
  }

  /** Create a context with a small set of per-execution overrides. */
  with(values = {}) {
    return new ToolContext({
      logger: values.logger || this.logger,
      config: values.config || this.config,
      memory: values.memory ?? this.memory,
      signal: values.signal || this.signal,
      capabilities: values.capabilities || this.capabilities,
      permissions: values.permissions || this.permissions,
      sandbox: values.sandbox || this.sandbox,
      tool: values.tool || this.tool,
      context: values.context || this.context,
      task: values.task || this.task,
      run: values.run || this.run,
      registry: values.registry || this.registry,
    });
  }
}

export function createToolContext(values = {}) {
  return new ToolContext(values);
}

export default ToolContext;
