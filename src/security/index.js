/**
 * security/index.js — public entry for the security module
 */
export {
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
} from './permissions.js';

export {
  Sandbox,
  SandboxLevel,
  createSandbox,
  levelFromPermissions,
} from './sandbox.js';
