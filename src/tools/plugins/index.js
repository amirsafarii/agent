/**
 * tools/plugins/index.js — static built-in plugins
 * --------------------------------------------------
 * A plugin is only a named container of Tool definitions. These factories are
 * ordinary JavaScript objects; they do not discover files, load npm packages,
 * generate tools, or know anything about AgentLoop internals.
 */

import { createFilesystemTools } from '../filesystem.js';
import { createShellTool, createShellSpawnTool, createShellKillTool, createShellWhichTool } from '../shell.js';
import { createCodeTools } from '../code.js';
import { createPackageTools } from '../package.js';
import { createPlanningTools } from '../planning.js';
import { createTodoTools, createPreflightTool } from '../todo.js';
import { createSpecTools } from '../spec.js';
import { createVerificationTools } from '../verification.js';
import { createWebSearchTool } from '../search.js';
import { createHttpTools } from '../http.js';

function toCanonicalTool(tool) {
  if (!tool || typeof tool !== 'object') return tool;
  if (typeof tool.execute === 'function') return tool;
  if (typeof tool.handler === 'function') return { ...tool, execute: tool.handler };
  return tool;
}

/**
 * Create a plugin object. Kept small on purpose so a developer can use the
 * same helper for a custom plugin without a base class or registration magic.
 */
export function createPlugin({ name, tools = [], metadata = {} } = {}) {
  if (typeof name !== 'string' || !name.trim()) throw new TypeError('Plugin name must be a non-empty string.');
  if (!Array.isArray(tools)) throw new TypeError(`Plugin "${name}" tools must be an array.`);
  // Normalize legacy built-in factories to the canonical execute property at
  // the plugin boundary. Registry registration still retains handler as a
  // compatibility alias, so old callers see no break.
  return { name, tools: tools.map(toCanonicalTool), metadata };
}

export function createFilesystemPlugin(opts = {}) {
  return createPlugin({
    name: opts.name || 'filesystem',
    metadata: { category: 'filesystem', ...(opts.metadata || {}) },
    tools: createFilesystemTools(opts),
  });
}

export function createFilePlugin(opts = {}) {
  return createFilesystemPlugin({ ...opts, name: opts.name || 'file' });
}

/**
 * WebPlugin defaults to web_search. Set includeFetchUrl to expose a small
 * fetch_url alias as well; the default Agent surface keeps the historical
 * http_get/http_post/http_request names in the separate HTTP plugin.
 */
export function createWebPlugin(opts = {}) {
  const tools = [createWebSearchTool(opts)];
  if (opts.includeFetchUrl !== false) {
    const getTool = createHttpTools(opts).find((tool) => tool.name === 'http_get');
    if (getTool) {
      tools.push({
        ...getTool,
        name: 'fetch_url',
        description: 'Fetch a URL and return its bounded response.',
        permissions: { network: 'allow' },
        metadata: { ...(getTool.metadata || {}), category: 'web' },
      });
    }
  }
  return createPlugin({
    name: opts.name || 'web',
    metadata: { category: 'web', ...(opts.metadata || {}) },
    tools,
  });
}

export function createHttpPlugin(opts = {}) {
  return createPlugin({
    name: opts.name || 'http',
    metadata: { category: 'web', ...(opts.metadata || {}) },
    tools: createHttpTools(opts),
  });
}

export function createShellPlugin(opts = {}) {
  return createPlugin({
    name: opts.name || 'shell',
    metadata: { category: 'shell', ...(opts.metadata || {}) },
    tools: [
      createShellTool(opts),
      createShellSpawnTool(opts),
      createShellKillTool(opts),
      createShellWhichTool(opts),
    ],
  });
}

export function createCodePlugin(opts = {}) {
  return createPlugin({
    name: opts.name || 'code',
    metadata: { category: 'code', ...(opts.metadata || {}) },
    tools: createCodeTools(opts),
  });
}

export function createPackagePlugin(opts = {}) {
  return createPlugin({
    name: opts.name || 'package',
    metadata: { category: 'package', ...(opts.metadata || {}) },
    tools: createPackageTools(opts),
  });
}

export function createPlanningPlugin(opts = {}) {
  return createPlugin({
    name: opts.name || 'planning',
    metadata: { category: 'planning', ...(opts.metadata || {}) },
    tools: createPlanningTools(opts),
  });
}

export function createTodoPlugin(opts = {}) {
  return createPlugin({
    name: opts.name || 'todo',
    metadata: { category: 'todo', ...(opts.metadata || {}) },
    tools: createTodoTools(opts),
  });
}

export function createSpecPlugin(opts = {}) {
  return createPlugin({
    name: opts.name || 'spec',
    metadata: { category: 'spec', ...(opts.metadata || {}) },
    tools: createSpecTools(opts),
  });
}

export function createVerificationPlugin(opts = {}) {
  return createPlugin({
    name: opts.name || 'verification',
    metadata: { category: 'verification', ...(opts.metadata || {}) },
    tools: createVerificationTools(opts),
  });
}

/**
 * Build the static set used by createDefaultToolRegistry(). No plugin loading
 * takes place: this is simply composition of known factories.
 */
export function createDefaultPlugins(opts = {}) {
  const filesRoot = opts.filesRoot || process.cwd();
  const plugins = [
    createFilesystemPlugin({ rootDir: filesRoot, sandbox: opts.sandbox, metadata: { source: 'builtin' } }),
    createShellPlugin({ ...(opts.shellOpts || {}), metadata: { source: 'builtin' } }),
    createCodePlugin({ rootDir: filesRoot, metadata: { source: 'builtin' } }),
    createPackagePlugin({ rootDir: filesRoot, metadata: { source: 'builtin' } }),
    createPlanningPlugin({ engine: opts.planningEngine, metadata: { source: 'builtin' } }),
  ];

  if (opts.todoManager) {
    plugins.push(createTodoPlugin({ manager: opts.todoManager, rootDir: filesRoot, metadata: { source: 'builtin' } }));
  }
  if (opts.spec) {
    plugins.push(createSpecPlugin({ spec: opts.spec, rootDir: filesRoot, metadata: { source: 'builtin' } }));
  }

  plugins.push(createVerificationPlugin({
    rootDir: filesRoot,
    engine: opts.verificationEngine,
    metadata: { source: 'builtin' },
  }));

  if (opts.todoManager) {
    // verify_preflight needs the same managers but remains an ordinary Tool
    // in the TODO plugin, not a special registry code path.
    const todoPlugin = plugins.find((plugin) => plugin.name === 'todo');
    if (todoPlugin) {
      const preflight = createPreflightTool({
        todoManager: opts.todoManager,
        spec: opts.spec,
        verificationEngine: opts.verificationEngine,
        rootDir: filesRoot,
      });
      todoPlugin.tools.push(toCanonicalTool(preflight));
    }
  }

  // The web plugin is intentionally separate from HTTP so applications can
  // mount only search, only HTTP, or both. This preserves the historical
  // default names while keeping them plugin-owned.
  plugins.push(createWebPlugin({
    ...opts.webOpts,
    includeFetchUrl: false,
    metadata: { source: 'builtin' },
  }));
  plugins.push(createHttpPlugin({ ...opts.httpOpts, metadata: { source: 'builtin' } }));

  return plugins;
}

export default createPlugin;
