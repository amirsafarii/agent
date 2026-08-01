/**
 * tools/index.js — public ToolSystem entry point
 * ------------------------------------------------
 * Registry/Runner/Context/Schema/Result/Error are the stable core. Built-in
 * tools are exposed through static plugin factories; no dynamic loading or
 * filesystem discovery is performed here.
 */
export {
  ToolRegistry,
  ToolError,
  ToolLifecycle,
  createToolMetadata,
  transitionLifecycle,
  promoteToActive,
  EXECUTABLE_LIFECYCLES,
} from './registry.js';
export { ToolSystem } from './system.js';
export { ToolRunner } from './runner.js';
export { ToolContext, createToolContext } from './context.js';
export {
  ToolSchema,
  normalizeInputSchema,
  legacyParametersFromSchema,
  validateInput,
} from './schema.js';
export {
  ToolResult,
  normalizeToolResult,
  toLegacyResult,
  resultErrorMessage,
} from './result.js';
export { ToolErrorCode, ToolErrorCodes, toolError } from './errors.js';
export {
  Middleware,
  createMiddleware,
  normalizeMiddleware,
  composeMiddleware,
  validationMiddleware,
  permissionMiddleware,
  timeoutMiddleware,
  createLoggingMiddleware,
} from './middleware.js';

// Backward-compatible lifecycle aliases.
export {
  ToolLifecycle as Lifecycle,
  createToolMetadata as toolMetadata,
  promoteToActive as promoteTool,
} from './lifecycle.js';

// Static built-in tool factories.
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

// Static plugin API. Dynamic/npm/filesystem discovery is intentionally absent.
export {
  createPlugin,
  createFilesystemPlugin,
  createFilePlugin,
  createWebPlugin,
  createHttpPlugin,
  createShellPlugin,
  createCodePlugin,
  createPackagePlugin,
  createPlanningPlugin,
  createTodoPlugin,
  createSpecPlugin,
  createVerificationPlugin,
  createDefaultPlugins,
} from './plugins/index.js';

export { ToolRegistry as default } from './registry.js';
