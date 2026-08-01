/**
 * tools/index.js — public entry for the tools module
 * -----------------------------------------------
 * One import site for the ToolRegistry and every built-in tool-suite
 * factory:
 *
 *   import { ToolRegistry, createFilesystemTools, createShellTool, ... } from 'src/tools/index.js';
 *
 * Implementation lives in focused sibling modules: registry.js (ToolRegistry),
 * lifecycle.js (tool lifecycle states + metadata), filesystem.js / shell.js /
 * code.js / package.js / planning.js / verification.js (tool suites),
 * search.js (web search).
 */
export {
  ToolRegistry,
  ToolError,
  ToolLifecycle,
  createToolMetadata,
  transitionLifecycle,
  promoteToActive,
  canTransitionLifecycle,
  EXECUTABLE_LIFECYCLES,
  SCHEMA_LIFECYCLES,
} from './registry.js';
export {
  ToolLifecycle as Lifecycle,
  createToolMetadata as toolMetadata,
  promoteToActive as promoteTool,
} from './lifecycle.js';
export { createFilesystemTools } from './filesystem.js';
export { createShellTool, createShellSpawnTool, createShellKillTool, createShellWhichTool } from './shell.js';
export { createCodeTools } from './code.js';
export { createPackageTools } from './package.js';
export { createPlanningTools } from './planning.js';
export { createTodoTools } from './todo.js';
export { createSpecTools } from './spec.js';
export { createVerificationTools } from './verification.js';
export { createWebSearchTool } from './search.js';
export { createHttpTools } from './http.js';

export { ToolRegistry as default } from './registry.js';
