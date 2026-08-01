/**
 * security/permissions.js — Tool permission model + profiles
 * ----------------------------------------------------------
 * Replaces the binary `requiresApproval: true` flag with a structured
 * capability model. Every tool declares what it needs; every agent run
 * carries a profile that grants (or denies) those capabilities. Approval
 * can still gate individual tools / plans / sessions on top.
 *
 * Profiles shipped out of the box:
 *   readonly    — read FS + network; no write/shell/process/package
 *   developer   — full sandbox FS + restricted shell + npm
 *   autonomous  — developer + fewer approval gates (still sandboxed)
 *   admin       — everything, including host FS and unrestricted shell
 *
 * Pure JavaScript (ES modules).
 */

import { createLogger } from '../core/logger.js';

const log = createLogger('security:permissions');

/** Capability axes a tool may require / a profile may grant. */
export const PermissionAxis = Object.freeze({
  FILESYSTEM: 'filesystem',
  NETWORK: 'network',
  SHELL: 'shell',
  PROCESS: 'process',
  PACKAGE: 'package',
});

/**
 * Allowed values per axis.
 *   filesystem: 'none' | 'sandbox' | 'readonly' | 'host'
 *   network:    'none' | 'allow'
 *   shell:      'none' | 'restricted' | 'allow'
 *   process:    'none' | 'allow'
 *   package:    'none' | 'allow' | 'no_scripts'
 */
export const PermissionValue = Object.freeze({
  NONE: 'none',
  SANDBOX: 'sandbox',
  READONLY: 'readonly',
  HOST: 'host',
  ALLOW: 'allow',
  RESTRICTED: 'restricted',
  NO_SCRIPTS: 'no_scripts',
});

/** Risk levels used for approval heuristics. */
export const RiskLevel = Object.freeze({
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical',
});

/** Built-in permission profiles. */
export const PROFILES = Object.freeze({
  readonly: Object.freeze({
    name: 'readonly',
    description: 'Read-only agent: can inspect files and search the web, cannot mutate anything.',
    permissions: Object.freeze({
      filesystem: PermissionValue.READONLY,
      network: PermissionValue.ALLOW,
      shell: PermissionValue.NONE,
      process: PermissionValue.NONE,
      package: PermissionValue.NONE,
    }),
    // Tools at or above this risk always require approval under this profile.
    approvalRiskThreshold: RiskLevel.MEDIUM,
  }),
  developer: Object.freeze({
    name: 'developer',
    description: 'Day-to-day coding agent: sandboxed FS, restricted shell, npm with lifecycle scripts gated.',
    permissions: Object.freeze({
      filesystem: PermissionValue.SANDBOX,
      network: PermissionValue.ALLOW,
      shell: PermissionValue.RESTRICTED,
      process: PermissionValue.ALLOW,
      package: PermissionValue.ALLOW,
    }),
    approvalRiskThreshold: RiskLevel.HIGH,
  }),
  autonomous: Object.freeze({
    name: 'autonomous',
    description: 'Long-running autonomous agent: same sandbox as developer, fewer approval interruptions.',
    permissions: Object.freeze({
      filesystem: PermissionValue.SANDBOX,
      network: PermissionValue.ALLOW,
      shell: PermissionValue.RESTRICTED,
      process: PermissionValue.ALLOW,
      package: PermissionValue.ALLOW,
    }),
    approvalRiskThreshold: RiskLevel.CRITICAL,
  }),
  admin: Object.freeze({
    name: 'admin',
    description: 'Full power — host FS + unrestricted shell. Use only in trusted environments.',
    permissions: Object.freeze({
      filesystem: PermissionValue.HOST,
      network: PermissionValue.ALLOW,
      shell: PermissionValue.ALLOW,
      process: PermissionValue.ALLOW,
      package: PermissionValue.ALLOW,
    }),
    approvalRiskThreshold: RiskLevel.CRITICAL,
  }),
});

/** Rankings used to decide whether a granted value satisfies a required one. */
const FS_RANK = Object.freeze({
  [PermissionValue.NONE]: 0,
  [PermissionValue.READONLY]: 1,
  [PermissionValue.SANDBOX]: 2,
  [PermissionValue.HOST]: 3,
});
const SHELL_RANK = Object.freeze({
  [PermissionValue.NONE]: 0,
  [PermissionValue.RESTRICTED]: 1,
  [PermissionValue.ALLOW]: 2,
});
const PACKAGE_RANK = Object.freeze({
  [PermissionValue.NONE]: 0,
  [PermissionValue.NO_SCRIPTS]: 1,
  [PermissionValue.ALLOW]: 2,
});
const BINARY_RANK = Object.freeze({
  [PermissionValue.NONE]: 0,
  [PermissionValue.ALLOW]: 1,
});

const RISK_RANK = Object.freeze({
  [RiskLevel.LOW]: 0,
  [RiskLevel.MEDIUM]: 1,
  [RiskLevel.HIGH]: 2,
  [RiskLevel.CRITICAL]: 3,
});

/**
 * Default permissions inferred from a tool name/category when the definition
 * does not declare them explicitly. Conservative: unknown → none.
 */
export const DEFAULT_TOOL_PERMISSIONS = Object.freeze({
  // filesystem
  read_file: { filesystem: PermissionValue.READONLY, network: PermissionValue.NONE, shell: PermissionValue.NONE, process: PermissionValue.NONE, package: PermissionValue.NONE },
  list_dir: { filesystem: PermissionValue.READONLY, network: PermissionValue.NONE, shell: PermissionValue.NONE, process: PermissionValue.NONE, package: PermissionValue.NONE },
  search_files: { filesystem: PermissionValue.READONLY, network: PermissionValue.NONE, shell: PermissionValue.NONE, process: PermissionValue.NONE, package: PermissionValue.NONE },
  write_file: { filesystem: PermissionValue.SANDBOX, network: PermissionValue.NONE, shell: PermissionValue.NONE, process: PermissionValue.NONE, package: PermissionValue.NONE },
  edit_file: { filesystem: PermissionValue.SANDBOX, network: PermissionValue.NONE, shell: PermissionValue.NONE, process: PermissionValue.NONE, package: PermissionValue.NONE },
  make_dir: { filesystem: PermissionValue.SANDBOX, network: PermissionValue.NONE, shell: PermissionValue.NONE, process: PermissionValue.NONE, package: PermissionValue.NONE },
  move_file: { filesystem: PermissionValue.SANDBOX, network: PermissionValue.NONE, shell: PermissionValue.NONE, process: PermissionValue.NONE, package: PermissionValue.NONE },
  copy_file: { filesystem: PermissionValue.SANDBOX, network: PermissionValue.NONE, shell: PermissionValue.NONE, process: PermissionValue.NONE, package: PermissionValue.NONE },
  delete_file: { filesystem: PermissionValue.SANDBOX, network: PermissionValue.NONE, shell: PermissionValue.NONE, process: PermissionValue.NONE, package: PermissionValue.NONE },
  // shell
  shell: { filesystem: PermissionValue.SANDBOX, network: PermissionValue.NONE, shell: PermissionValue.RESTRICTED, process: PermissionValue.NONE, package: PermissionValue.NONE },
  shell_spawn: { filesystem: PermissionValue.SANDBOX, network: PermissionValue.NONE, shell: PermissionValue.RESTRICTED, process: PermissionValue.ALLOW, package: PermissionValue.NONE },
  shell_kill: { filesystem: PermissionValue.NONE, network: PermissionValue.NONE, shell: PermissionValue.NONE, process: PermissionValue.ALLOW, package: PermissionValue.NONE },
  shell_which: { filesystem: PermissionValue.NONE, network: PermissionValue.NONE, shell: PermissionValue.NONE, process: PermissionValue.NONE, package: PermissionValue.NONE },
  // code
  code_run: { filesystem: PermissionValue.SANDBOX, network: PermissionValue.NONE, shell: PermissionValue.RESTRICTED, process: PermissionValue.NONE, package: PermissionValue.NONE },
  code_test: { filesystem: PermissionValue.SANDBOX, network: PermissionValue.NONE, shell: PermissionValue.RESTRICTED, process: PermissionValue.NONE, package: PermissionValue.NONE },
  code_validate: { filesystem: PermissionValue.READONLY, network: PermissionValue.NONE, shell: PermissionValue.RESTRICTED, process: PermissionValue.NONE, package: PermissionValue.NONE },
  // package
  npm: { filesystem: PermissionValue.SANDBOX, network: PermissionValue.ALLOW, shell: PermissionValue.NONE, process: PermissionValue.NONE, package: PermissionValue.ALLOW },
  package_install: { filesystem: PermissionValue.SANDBOX, network: PermissionValue.ALLOW, shell: PermissionValue.NONE, process: PermissionValue.NONE, package: PermissionValue.ALLOW },
  package_info: { filesystem: PermissionValue.READONLY, network: PermissionValue.NONE, shell: PermissionValue.NONE, process: PermissionValue.NONE, package: PermissionValue.NONE },
  // web
  web_search: { filesystem: PermissionValue.NONE, network: PermissionValue.ALLOW, shell: PermissionValue.NONE, process: PermissionValue.NONE, package: PermissionValue.NONE },
  // planning / verification — pure in-process
  plan_create: { filesystem: PermissionValue.NONE, network: PermissionValue.NONE, shell: PermissionValue.NONE, process: PermissionValue.NONE, package: PermissionValue.NONE },
  plan_update_task: { filesystem: PermissionValue.NONE, network: PermissionValue.NONE, shell: PermissionValue.NONE, process: PermissionValue.NONE, package: PermissionValue.NONE },
  plan_get: { filesystem: PermissionValue.NONE, network: PermissionValue.NONE, shell: PermissionValue.NONE, process: PermissionValue.NONE, package: PermissionValue.NONE },
  plan_add_tasks: { filesystem: PermissionValue.NONE, network: PermissionValue.NONE, shell: PermissionValue.NONE, process: PermissionValue.NONE, package: PermissionValue.NONE },
  verify_file: { filesystem: PermissionValue.READONLY, network: PermissionValue.NONE, shell: PermissionValue.NONE, process: PermissionValue.NONE, package: PermissionValue.NONE },
  verify_command: { filesystem: PermissionValue.SANDBOX, network: PermissionValue.NONE, shell: PermissionValue.RESTRICTED, process: PermissionValue.NONE, package: PermissionValue.NONE },
  verify_json: { filesystem: PermissionValue.READONLY, network: PermissionValue.NONE, shell: PermissionValue.NONE, process: PermissionValue.NONE, package: PermissionValue.NONE },
  verify_suite: { filesystem: PermissionValue.SANDBOX, network: PermissionValue.NONE, shell: PermissionValue.RESTRICTED, process: PermissionValue.NONE, package: PermissionValue.NONE },
});

/** Default risk levels for known tools. */
export const DEFAULT_TOOL_RISK = Object.freeze({
  delete_file: RiskLevel.HIGH,
  shell_kill: RiskLevel.HIGH,
  shell: RiskLevel.MEDIUM,
  shell_spawn: RiskLevel.HIGH,
  package_install: RiskLevel.HIGH,
  npm: RiskLevel.MEDIUM,
  code_run: RiskLevel.MEDIUM,
  write_file: RiskLevel.LOW,
  edit_file: RiskLevel.LOW,
  web_search: RiskLevel.LOW,
  read_file: RiskLevel.LOW,
});

/**
 * Normalize a permissions object, filling missing axes with 'none'.
 * @param {Object} [perms]
 * @returns {Object}
 */
export function normalizePermissions(perms = {}) {
  // The plugin-facing API also accepts a compact capability list:
  //   permissions: ['network', 'process']
  // and boolean flags:
  //   permissions: { network: true, filesystem: false }
  // Keep the internal profile representation (axis -> ranked value) stable.
  if (Array.isArray(perms)) {
    const out = {
      filesystem: PermissionValue.NONE,
      network: PermissionValue.NONE,
      shell: PermissionValue.NONE,
      process: PermissionValue.NONE,
      package: PermissionValue.NONE,
    };
    for (const axis of perms) {
      if (Object.prototype.hasOwnProperty.call(out, axis)) out[axis] = PermissionValue.ALLOW;
    }
    return out;
  }

  const source = perms && typeof perms === 'object' ? perms : {};
  const value = (axis) => {
    const raw = source[axis];
    if (raw === true) return PermissionValue.ALLOW;
    if (raw === false || raw == null) return PermissionValue.NONE;
    return raw;
  };
  return {
    filesystem: value('filesystem'),
    network: value('network'),
    shell: value('shell'),
    process: value('process'),
    package: value('package'),
  };
}

/**
 * Resolve the effective permissions a tool requires.
 * Explicit def.permissions wins; otherwise DEFAULT_TOOL_PERMISSIONS[name];
 * otherwise all-none.
 * @param {Object} toolDef
 * @returns {Object}
 */
export function resolveToolPermissions(toolDef) {
  if (toolDef && toolDef.permissions) return normalizePermissions(toolDef.permissions);
  if (toolDef && toolDef.metadata && toolDef.metadata.permissions) {
    return normalizePermissions(toolDef.metadata.permissions);
  }
  if (toolDef && toolDef.name && DEFAULT_TOOL_PERMISSIONS[toolDef.name]) {
    return normalizePermissions(DEFAULT_TOOL_PERMISSIONS[toolDef.name]);
  }
  return normalizePermissions();
}

/**
 * Resolve risk level for a tool.
 * @param {Object} toolDef
 * @returns {string}
 */
export function resolveToolRisk(toolDef) {
  if (toolDef && toolDef.risk) return toolDef.risk;
  if (toolDef && toolDef.metadata && toolDef.metadata.risk) return toolDef.metadata.risk;
  if (toolDef && toolDef.name && DEFAULT_TOOL_RISK[toolDef.name]) return DEFAULT_TOOL_RISK[toolDef.name];
  return RiskLevel.LOW;
}

/**
 * Does `granted` satisfy `required` for a single axis?
 * @param {string} axis
 * @param {string} required
 * @param {string} granted
 * @returns {boolean}
 */
export function axisSatisfied(axis, required, granted) {
  if (!required || required === PermissionValue.NONE) return true;
  if (!granted || granted === PermissionValue.NONE) return false;

  switch (axis) {
    case PermissionAxis.FILESYSTEM: {
      // readonly requirement is satisfied by readonly, sandbox, or host
      // sandbox requirement is satisfied by sandbox or host
      // host requirement needs host
      const req = required === PermissionValue.READONLY ? PermissionValue.READONLY : required;
      return (FS_RANK[granted] || 0) >= (FS_RANK[req] || 0);
    }
    case PermissionAxis.SHELL:
      return (SHELL_RANK[granted] || 0) >= (SHELL_RANK[required] || 0);
    case PermissionAxis.PACKAGE:
      return (PACKAGE_RANK[granted] || 0) >= (PACKAGE_RANK[required] || 0);
    case PermissionAxis.NETWORK:
    case PermissionAxis.PROCESS:
      return (BINARY_RANK[granted] || 0) >= (BINARY_RANK[required] || 0);
    default:
      return granted === required || granted === PermissionValue.ALLOW;
  }
}

/**
 * Check whether a profile grants everything a tool requires.
 * @param {Object} required - tool permissions
 * @param {Object} granted - profile permissions
 * @returns {{ ok: true } | { ok: false, denied: Array<{axis, required, granted}>, code: string }}
 */
export function checkPermissions(required, granted) {
  const req = normalizePermissions(required);
  const gr = normalizePermissions(granted);
  const denied = [];

  for (const axis of Object.values(PermissionAxis)) {
    if (!axisSatisfied(axis, req[axis], gr[axis])) {
      denied.push({ axis, required: req[axis], granted: gr[axis] });
    }
  }

  if (denied.length === 0) return { ok: true, denied: [] };
  return {
    ok: false,
    denied,
    code: 'PERMISSION_DENIED',
    error: `Permission denied: ${denied.map((d) => `${d.axis} requires "${d.required}" (have "${d.granted}")`).join('; ')}`,
  };
}

/**
 * Resolve a profile by name or accept a custom profile object.
 * @param {string|Object} [profile='developer']
 * @returns {Object}
 */
export function resolveProfile(profile = 'developer') {
  if (!profile) return { ...PROFILES.developer, permissions: { ...PROFILES.developer.permissions } };
  if (typeof profile === 'string') {
    const p = PROFILES[profile];
    if (!p) {
      throw new Error(`Unknown permission profile "${profile}". Known: ${Object.keys(PROFILES).join(', ')}`);
    }
    return {
      name: p.name,
      description: p.description,
      permissions: { ...p.permissions },
      approvalRiskThreshold: p.approvalRiskThreshold,
    };
  }
  if (typeof profile === 'object') {
    return {
      name: profile.name || 'custom',
      description: profile.description || '',
      permissions: normalizePermissions(profile.permissions || profile),
      approvalRiskThreshold: profile.approvalRiskThreshold || RiskLevel.HIGH,
    };
  }
  throw new Error('resolveProfile() expects a profile name or object.');
}

/**
 * Should this tool call go through the approval gate under the given profile?
 * Combines: tool.requiresApproval, risk ≥ profile threshold, and any explicit
 * requireApprovalFor list (handled by the caller / AgentLoop).
 * @param {Object} toolDef
 * @param {Object} profile
 * @returns {boolean}
 */
export function shouldRequireApproval(toolDef, profile) {
  if (!toolDef) return false;
  if (toolDef.requiresApproval || (toolDef.metadata && toolDef.metadata.requiresApproval)) return true;
  const risk = resolveToolRisk(toolDef);
  const threshold = (profile && profile.approvalRiskThreshold) || RiskLevel.HIGH;
  return (RISK_RANK[risk] || 0) >= (RISK_RANK[threshold] || 0);
}

/**
 * Session-scoped approval grants: "approve this tool for this session".
 * Also supports plan-level and step-level grants tracked by the approval manager.
 */
export class ApprovalManager {
  constructor() {
    /** @type {Set<string>} tool names approved for the whole session */
    this.sessionToolGrants = new Set();
    /** @type {Set<string>} plan ids fully approved */
    this.planGrants = new Set();
    /** @type {Set<string>} `${planId}:${taskId}` step grants */
    this.stepGrants = new Set();
    /** @type {Set<string>} tools denied for the session */
    this.sessionToolDenials = new Set();
  }

  approveToolForSession(toolName) {
    this.sessionToolGrants.add(String(toolName));
    this.sessionToolDenials.delete(String(toolName));
    log.info('approval:tool_session_grant', { tool: toolName });
    return this;
  }

  denyToolForSession(toolName) {
    this.sessionToolDenials.add(String(toolName));
    this.sessionToolGrants.delete(String(toolName));
    log.info('approval:tool_session_deny', { tool: toolName });
    return this;
  }

  approvePlan(planId) {
    this.planGrants.add(String(planId));
    log.info('approval:plan_grant', { planId });
    return this;
  }

  approveStep(planId, taskId) {
    this.stepGrants.add(`${planId}:${taskId}`);
    log.info('approval:step_grant', { planId, taskId });
    return this;
  }

  /**
   * @param {{ tool?: string, planId?: string, taskId?: string }} request
   * @returns {'granted'|'denied'|'unknown'}
   */
  lookup(request = {}) {
    if (request.tool && this.sessionToolDenials.has(String(request.tool))) return 'denied';
    if (request.tool && this.sessionToolGrants.has(String(request.tool))) return 'granted';
    if (request.planId && this.planGrants.has(String(request.planId))) return 'granted';
    if (request.planId && request.taskId && this.stepGrants.has(`${request.planId}:${request.taskId}`)) {
      return 'granted';
    }
    return 'unknown';
  }

  reset() {
    this.sessionToolGrants.clear();
    this.planGrants.clear();
    this.stepGrants.clear();
    this.sessionToolDenials.clear();
  }

  toJSON() {
    return {
      sessionToolGrants: Array.from(this.sessionToolGrants),
      planGrants: Array.from(this.planGrants),
      stepGrants: Array.from(this.stepGrants),
      sessionToolDenials: Array.from(this.sessionToolDenials),
    };
  }
}

export default {
  PermissionAxis,
  PermissionValue,
  RiskLevel,
  PROFILES,
  DEFAULT_TOOL_PERMISSIONS,
  DEFAULT_TOOL_RISK,
  normalizePermissions,
  resolveToolPermissions,
  resolveToolRisk,
  axisSatisfied,
  checkPermissions,
  resolveProfile,
  shouldRequireApproval,
  ApprovalManager,
};
