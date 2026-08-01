/**
 * tools/lifecycle.js — Tool lifecycle states + metadata
 * ------------------------------------------------------
 * Tools are no longer a binary register→execute path. Every tool moves
 * through an explicit lifecycle so the registry, approval gate, and
 * operator UIs can reason about readiness:
 *
 *   DISCOVERED → DRAFT → VALIDATING → TESTING → APPROVED
 *     → REGISTERED → ACTIVE → DEPRECATED → REMOVED
 *
 * Pure JavaScript (ES modules).
 */

import { createLogger } from '../core/logger.js';

const log = createLogger('tools:lifecycle');

/** Ordered tool lifecycle states. */
export const ToolLifecycle = Object.freeze({
  DISCOVERED: 'discovered',
  DRAFT: 'draft',
  VALIDATING: 'validating',
  TESTING: 'testing',
  APPROVED: 'approved',
  REGISTERED: 'registered',
  ACTIVE: 'active',
  DEPRECATED: 'deprecated',
  REMOVED: 'removed',
});

/** Legal transitions. A tool may also jump to REMOVED from any non-REMOVED state. */
export const TOOL_LIFECYCLE_TRANSITIONS = Object.freeze({
  [ToolLifecycle.DISCOVERED]: [ToolLifecycle.DRAFT, ToolLifecycle.REMOVED],
  [ToolLifecycle.DRAFT]: [ToolLifecycle.VALIDATING, ToolLifecycle.REMOVED],
  [ToolLifecycle.VALIDATING]: [ToolLifecycle.TESTING, ToolLifecycle.DRAFT, ToolLifecycle.REMOVED],
  [ToolLifecycle.TESTING]: [ToolLifecycle.APPROVED, ToolLifecycle.DRAFT, ToolLifecycle.REMOVED],
  [ToolLifecycle.APPROVED]: [ToolLifecycle.REGISTERED, ToolLifecycle.REMOVED],
  [ToolLifecycle.REGISTERED]: [ToolLifecycle.ACTIVE, ToolLifecycle.DEPRECATED, ToolLifecycle.REMOVED],
  [ToolLifecycle.ACTIVE]: [ToolLifecycle.DEPRECATED, ToolLifecycle.REMOVED],
  [ToolLifecycle.DEPRECATED]: [ToolLifecycle.ACTIVE, ToolLifecycle.REMOVED],
  [ToolLifecycle.REMOVED]: [],
});

/** States from which a tool may be executed. */
export const EXECUTABLE_LIFECYCLES = Object.freeze([
  ToolLifecycle.ACTIVE,
  ToolLifecycle.DEPRECATED, // still callable, but warned
]);

/** States from which a tool is advertised to the reasoner (toSchema). */
export const SCHEMA_LIFECYCLES = Object.freeze([
  ToolLifecycle.ACTIVE,
]);

/**
 * @typedef {Object} ToolMetadata
 * @property {string} [version] semver-ish string
 * @property {string} [author]
 * @property {string[]} [tags]
 * @property {string} [category] e.g. 'filesystem' | 'shell' | 'code' | 'package' | 'planning' | 'verification' | 'web'
 * @property {string} [source] where the tool came from (builtin, plugin, discovered path)
 * @property {Object} [permissions] capability requirements (see security/permissions.js)
 * @property {boolean} [requiresApproval]
 * @property {string} [risk] 'low' | 'medium' | 'high' | 'critical'
 * @property {string[]} [sideEffects] e.g. ['filesystem.write', 'network', 'process.spawn']
 * @property {Object} [docs] { usage?, examples?, changelog? }
 * @property {Object} [metrics] runtime counters filled by the registry
 * @property {string} [createdAt]
 * @property {string} [updatedAt]
 * @property {string} [approvedAt]
 * @property {string} [approvedBy]
 * @property {string} [deprecatedAt]
 * @property {string} [deprecatedReason]
 * @property {string} [replacedBy] name of successor tool when deprecated
 */

/**
 * Normalize / fill defaults for tool metadata.
 * @param {Partial<ToolMetadata>} [meta]
 * @returns {ToolMetadata}
 */
export function createToolMetadata(meta = {}) {
  const now = new Date().toISOString();
  return {
    // Preserve unknown metadata keys. This is what lets a plugin add its own
    // metadata (trace names, documentation links, feature flags, etc.) without
    // making the Tool contract or old tools change.
    ...meta,
    version: meta.version || '1.0.0',
    author: meta.author || 'builtin',
    tags: Array.isArray(meta.tags) ? meta.tags.slice() : [],
    category: meta.category || 'general',
    source: meta.source || 'builtin',
    permissions: meta.permissions && typeof meta.permissions === 'object' ? { ...meta.permissions } : null,
    requiresApproval: !!meta.requiresApproval,
    risk: meta.risk || 'low',
    sideEffects: Array.isArray(meta.sideEffects) ? meta.sideEffects.slice() : [],
    docs: meta.docs && typeof meta.docs === 'object' ? { ...meta.docs } : {},
    metrics: {
      executions: 0,
      successes: 0,
      failures: 0,
      totalDurationMs: 0,
      lastExecutedAt: null,
      ...(meta.metrics || {}),
    },
    createdAt: meta.createdAt || now,
    updatedAt: meta.updatedAt || now,
    approvedAt: meta.approvedAt || null,
    approvedBy: meta.approvedBy || null,
    deprecatedAt: meta.deprecatedAt || null,
    deprecatedReason: meta.deprecatedReason || null,
    replacedBy: meta.replacedBy || null,
  };
}

/**
 * Validate a proposed lifecycle transition.
 * @param {string} from
 * @param {string} to
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function canTransitionLifecycle(from, to) {
  if (!Object.values(ToolLifecycle).includes(from)) {
    return { ok: false, error: `Unknown lifecycle state "${from}".` };
  }
  if (!Object.values(ToolLifecycle).includes(to)) {
    return { ok: false, error: `Unknown lifecycle state "${to}".` };
  }
  if (from === to) return { ok: true };
  const allowed = TOOL_LIFECYCLE_TRANSITIONS[from] || [];
  if (!allowed.includes(to)) {
    return {
      ok: false,
      error: `Illegal tool lifecycle transition ${from} → ${to}. Allowed: [${allowed.join(', ') || 'none'}].`,
    };
  }
  return { ok: true };
}

/**
 * Advance a tool's lifecycle. Mutates `tool.lifecycle` + metadata timestamps.
 * @param {Object} tool - registered tool record
 * @param {string} to
 * @param {Object} [meta]
 * @returns {Object} tool
 */
export function transitionLifecycle(tool, to, meta = {}) {
  const from = tool.lifecycle || ToolLifecycle.DISCOVERED;
  const check = canTransitionLifecycle(from, to);
  if (!check.ok) {
    const err = new Error(check.error);
    err.code = 'INVALID_LIFECYCLE_TRANSITION';
    throw err;
  }

  tool.lifecycle = to;
  tool.metadata = tool.metadata || createToolMetadata();
  tool.metadata.updatedAt = new Date().toISOString();

  if (to === ToolLifecycle.APPROVED) {
    tool.metadata.approvedAt = tool.metadata.updatedAt;
    tool.metadata.approvedBy = meta.approvedBy || tool.metadata.approvedBy || 'system';
  }
  if (to === ToolLifecycle.DEPRECATED) {
    tool.metadata.deprecatedAt = tool.metadata.updatedAt;
    tool.metadata.deprecatedReason = meta.reason || tool.metadata.deprecatedReason || null;
    if (meta.replacedBy) tool.metadata.replacedBy = meta.replacedBy;
  }
  if (to === ToolLifecycle.REMOVED) {
    tool.metadata.deprecatedAt = tool.metadata.deprecatedAt || tool.metadata.updatedAt;
  }

  log.info('lifecycle:transition', {
    name: tool.name,
    from,
    to,
    version: tool.metadata.version,
  });
  return tool;
}

/**
 * Convenience: walk a brand-new definition through DISCOVERED → … → ACTIVE
 * in one shot (used by the default register() path for built-in tools).
 * @param {Object} tool
 * @param {Object} [opts]
 * @param {boolean} [opts.skipValidation=true] when true, jumps DRAFT→APPROVED via synthetic validating/testing
 * @param {string} [opts.approvedBy='system']
 */
export function promoteToActive(tool, opts = {}) {
  const skipValidation = opts.skipValidation !== false;
  const approvedBy = opts.approvedBy || 'system';

  if (!tool.lifecycle || tool.lifecycle === ToolLifecycle.DISCOVERED) {
    tool.lifecycle = ToolLifecycle.DISCOVERED;
    transitionLifecycle(tool, ToolLifecycle.DRAFT);
  }
  if (tool.lifecycle === ToolLifecycle.DRAFT) {
    transitionLifecycle(tool, ToolLifecycle.VALIDATING);
  }
  if (tool.lifecycle === ToolLifecycle.VALIDATING) {
    if (skipValidation) {
      transitionLifecycle(tool, ToolLifecycle.TESTING);
    }
  }
  if (tool.lifecycle === ToolLifecycle.TESTING) {
    if (skipValidation) {
      transitionLifecycle(tool, ToolLifecycle.APPROVED, { approvedBy });
    }
  }
  if (tool.lifecycle === ToolLifecycle.APPROVED) {
    transitionLifecycle(tool, ToolLifecycle.REGISTERED);
  }
  if (tool.lifecycle === ToolLifecycle.REGISTERED) {
    transitionLifecycle(tool, ToolLifecycle.ACTIVE);
  }
  return tool;
}

/**
 * Record one execution against tool metadata metrics.
 * @param {Object} tool
 * @param {{ ok: boolean, durationMs: number }} result
 */
export function recordExecutionMetrics(tool, result) {
  if (!tool.metadata) tool.metadata = createToolMetadata();
  const m = tool.metadata.metrics;
  m.executions += 1;
  if (result.ok) m.successes += 1;
  else m.failures += 1;
  m.totalDurationMs += result.durationMs || 0;
  m.lastExecutedAt = new Date().toISOString();
  tool.metadata.updatedAt = m.lastExecutedAt;
}

export default {
  ToolLifecycle,
  TOOL_LIFECYCLE_TRANSITIONS,
  EXECUTABLE_LIFECYCLES,
  SCHEMA_LIFECYCLES,
  createToolMetadata,
  canTransitionLifecycle,
  transitionLifecycle,
  promoteToActive,
  recordExecutionMetrics,
};
