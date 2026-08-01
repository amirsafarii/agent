/**
 * tools/index.js — public entry for the tools module
 * -----------------------------------------------
 * One import site for the ToolRegistry and every built-in tool-suite
 * factory:
 *
 *   import { ToolRegistry, createFilesystemTools, createShellTool, ... } from 'src/tools/index.js';
 *
 * Implementation lives in focused sibling modules: registry.js (ToolRegistry),
 * filesystem.js / shell.js / code.js / package.js / planning.js /
 * verification.js (tool suites), search.js (web search).
 */
export { ToolRegistry, ToolError } from './registry.js';
export { createFilesystemTools } from './filesystem.js';
export { createShellTool, createShellSpawnTool, createShellKillTool, createShellWhichTool } from './shell.js';
export { createCodeTools } from './code.js';
export { createPackageTools } from './package.js';
export { createPlanningTools } from './planning.js';
export { createVerificationTools } from './verification.js';
export { createWebSearchTool } from './search.js';

export { ToolRegistry as default } from './registry.js';
