/**
 * tools/package.js — package management tools (npm / install / package_info)
 * ---------------------------------------------------------------------------
 * Three tools for working with npm packages inside the sandbox:
 *
 *   npm             run any npm command (install, run <script>, ls, ...)
 *                   with a bounded timeout and truncated output
 *   package_install install dependencies: all of them, or specific packages
 *                   (dev:true -> -D, force:true -> --force)
 *   package_info    inspect package metadata: reads package.json of the
 *                   project (or of an installed package resolved from cwd)
 *                   and reports name/version/scripts/dependencies/...
 *                   Fully offline — no registry call.
 *
 * Pure JavaScript (ES modules).
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { createLogger } from '../core/logger.js';
import { splitCommand, truncate, cleanSpawnEnv } from './shell.js';

const log = createLogger('tools:package');

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT = 8_000;

/**
 * @param {Object} [opts]
 * @param {string} [opts.rootDir] sandbox root for cwd/path args
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.maxOutputChars]
 * @returns {Array<import('./registry.js').ToolDefinition>}
 */
export function createPackageTools(opts = {}) {
  const {
    rootDir = process.cwd(),
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxOutputChars = DEFAULT_MAX_OUTPUT,
  } = opts;

  const root = path.resolve(rootDir);
  const require = createRequire(import.meta.url);
  // Resolution bases: the requested cwd first, then the directory this tool
  // itself runs from (so deps of the agent's own project are findable even
  // when the sandbox cwd has no node_modules of its own).
  const ownDir = path.dirname(fileURLToPath(import.meta.url));

  function resolveSafe(relPath) {
    const resolved = path.resolve(root, relPath);
    const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
    if (resolved !== root && !resolved.startsWith(rootWithSep)) {
      throw pkgError(`Path "${relPath}" escapes sandbox root "${root}".`, 'PATH_ESCAPE');
    }
    return resolved;
  }

  async function runNpm(argv, { cwd = root, timeout, signal, ignoreScripts = false } = {}) {
    const startedAt = Date.now();
    const finalArgv = ignoreScripts && !argv.includes('--ignore-scripts')
      ? [...argv, '--ignore-scripts']
      : argv;
    log.info('npm:run_start', { argv: finalArgv, cwd, timeout, ignoreScripts });
    try {
      const result = await execa('npm', finalArgv, {
        cwd,
        timeout,
        reject: false,
        env: cleanSpawnEnv(),
        extendEnv: false,
        cancelSignal: signal,
        killSignal: 'SIGTERM',
      });
      const output = {
        command: `npm ${finalArgv.join(' ')}`,
        exitCode: result.exitCode ?? null,
        timedOut: !!result.timedOut,
        stdout: truncate(result.stdout, maxOutputChars),
        stderr: truncate(result.stderr, maxOutputChars),
        ignoreScripts,
      };
      log.info('npm:run_done', { argv: finalArgv, durationMs: Date.now() - startedAt, exitCode: output.exitCode, timedOut: output.timedOut });
      return output;
    } catch (err) {
      log.error('npm:run_failed', { argv: finalArgv, durationMs: Date.now() - startedAt, error: err.message });
      throw pkgError(`Failed to run npm ${finalArgv.join(' ')}: ${err.message}`, err.code || 'NPM_ERROR');
    }
  }

  /**
   * Lifecycle scripts (postinstall etc.) are a code-execution vector.
   * Default SAFE: always ignore scripts unless the sandbox is DANGEROUS
   * (admin profile) AND package permission is "allow".
   * developer/autonomous get package installs but with --ignore-scripts.
   */
  function shouldIgnoreScripts(ctx = {}) {
    const granted = ctx.permissions || {};
    if (granted.package === 'no_scripts' || granted.package === 'none') return true;
    if (ctx.sandbox && typeof ctx.sandbox.allowLifecycleScripts === 'function') {
      return !ctx.sandbox.allowLifecycleScripts(granted);
    }
    // Without a sandbox handle: only allow scripts for an explicit package:allow
    // from an admin-like caller. Still default to ignore.
    return true;
  }

  const npmTool = {
    name: 'npm',
    description:
      'Run any npm command inside the sandbox, e.g. "npm run build", "npm ls --depth=0", "npm view express version". ' +
      'Bounded timeout (default 120s), output truncated. Non-zero exit codes are reported in the result, never thrown.',
    parameters: {
      args: { type: 'string', required: true, description: 'npm arguments, e.g. "run build" or "ls --depth=0".' },
      cwd: { type: 'string', description: 'Working directory (defaults to the sandbox root).' },
      timeoutMs: { type: 'number', description: `Per-call timeout override (default ${timeoutMs}ms).` },
    },
    handler: async (args, ctx = {}) => {
      if (ctx.signal?.aborted) throw pkgError('aborted', 'ABORTED');
      const argv = splitCommand(String(args.args || '').trim());
      if (argv.length === 0) throw pkgError('Empty npm arguments.', 'EMPTY_ARGS');
      const cwd = args.cwd ? resolveSafe(args.cwd) : root;
      const runTimeout = Number.isFinite(args.timeoutMs) ? args.timeoutMs : timeoutMs;
      return runNpm(argv, {
        cwd,
        timeout: runTimeout,
        signal: ctx.signal,
        ignoreScripts: shouldIgnoreScripts(ctx),
      });
    },
  };

  const installTool = {
    name: 'package_install',
    description:
      'Install npm dependencies in the sandbox: no packages -> "npm install" (uses package.json/lockfile); ' +
      'with packages -> "npm install <pkg...>". dev:true adds -D, force:true adds --force. Network required. ' +
      'Lifecycle scripts are DISABLED by default (security) unless the permission profile grants package:"allow".',
    parameters: {
      packages: { type: 'array', description: 'Package specifiers to install, e.g. ["express"] or ["-D", "vitest"].' },
      dev: { type: 'boolean', description: 'Install as devDependencies (-D). Default false.' },
      force: { type: 'boolean', description: 'Pass --force to npm. Default false.' },
      cwd: { type: 'string', description: 'Working directory (defaults to the sandbox root).' },
      timeoutMs: { type: 'number', description: `Per-call timeout override (default ${timeoutMs}ms).` },
    },
    requiresApproval: true,
    risk: 'high',
    handler: async (args, ctx = {}) => {
      if (ctx.signal?.aborted) throw pkgError('aborted', 'ABORTED');
      const cwd = args.cwd ? resolveSafe(args.cwd) : root;
      const runTimeout = Number.isFinite(args.timeoutMs) ? args.timeoutMs : timeoutMs;
      const argv = ['install'];
      const packages = Array.isArray(args.packages) ? args.packages.map(String) : [];
      if (args.dev) argv.push('-D');
      if (args.force) argv.push('--force');
      argv.push(...packages);
      // Security: malicious packages can RCE via postinstall. Default to --ignore-scripts
      // unless the active profile explicitly allows lifecycle scripts.
      return runNpm(argv, {
        cwd,
        timeout: runTimeout,
        signal: ctx.signal,
        ignoreScripts: shouldIgnoreScripts(ctx),
      });
    },
  };

  const infoTool = {
    name: 'package_info',
    description:
      'Inspect package metadata offline. With no "name": reads the package.json in the working directory ' +
      '(the project itself). With "name": resolves the installed package from cwd via node resolution and ' +
      'reports its package.json. Never hits the network.',
    parameters: {
      name: { type: 'string', description: 'Installed package name to inspect, e.g. "express" or "execa".' },
      cwd: { type: 'string', description: 'Resolution base (defaults to the sandbox root).' },
    },
    handler: async (args) => {
      const cwd = args.cwd ? resolveSafe(args.cwd) : root;

      if (args.name) {
        try {
          const pkg = await resolveInstalledPackage(args.name, { cwd, ownDir, require });
          const output = pickPackageInfo(pkg.data, { name: args.name, installedPath: pkg.path, installed: true });
          log.info('package_info:done', { name: args.name, version: output.version, installed: true });
          return output;
        } catch (err) {
          log.info('package_info:not_found', { name: args.name, error: err.message });
          return { name: args.name, installed: false, installedPath: null, reason: err.message };
        }
      }

      const pkgJsonPath = path.join(cwd, 'package.json');
      let pkg;
      try {
        pkg = JSON.parse(await fs.readFile(pkgJsonPath, 'utf8'));
      } catch (err) {
        throw pkgError(`No package.json in "${args.cwd || '.'}": ${err.message}`, 'NOT_FOUND');
      }
      const output = pickPackageInfo(pkg, { installedPath: cwd, installed: true, self: true });
      log.info('package_info:done', { self: true, version: output.version });
      return output;
    },
  };

  return [npmTool, installTool, infoTool];
}

/**
 * Resolve an installed package's package.json WITHOUT relying on
 * "<name>/package.json" being exported (modern packages with an `exports`
 * map often hide it, e.g. execa v10). Instead: resolve the package's main
 * entry, then walk up from its directory until package.json appears.
 * @returns {Promise<{ data: object, path: string }>}
 */
async function resolveInstalledPackage(name, { cwd, ownDir, require }) {
  const entry = require.resolve(name, { paths: [cwd, ownDir] });
  let dir = path.dirname(entry);
  for (let i = 0; i < 8; i += 1) {
    const candidate = path.join(dir, 'package.json');
    try {
      const data = JSON.parse(await fs.readFile(candidate, 'utf8'));
      return { data, path: dir };
    } catch (_err) {
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  throw pkgError(`Could not locate package.json for "${name}" near ${entry}.`, 'NOT_FOUND');
}

function pickPackageInfo(pkg, { installedPath, installed, self }) {
  return {
    self: !!self,
    name: pkg.name || null,
    version: pkg.version || null,
    description: pkg.description || null,
    license: pkg.license || null,
    type: pkg.type || null,
    main: pkg.main || null,
    engines: pkg.engines || null,
    bin: pkg.bin || null,
    scripts: pkg.scripts || null,
    dependencies: pkg.dependencies || null,
    devDependencies: pkg.devDependencies || null,
    peerDependencies: pkg.peerDependencies || null,
    workspaces: pkg.workspaces || null,
    installed,
    installedPath,
  };
}

function pkgError(message, code) {
  const err = new Error(message);
  err.code = code || 'PACKAGE_ERROR';
  return err;
}

export default createPackageTools;
