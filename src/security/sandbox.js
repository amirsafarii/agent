/**
 * security/sandbox.js — realpath-based sandbox containment
 * ---------------------------------------------------------
 * Path-prefix checks alone are not enough: a symlink inside the sandbox
 * that points at `/etc` lets `read_file("link/passwd")` escape. This module
 * resolves every candidate path with `fs.realpath` (falling back to
 * lexical resolution for not-yet-existing paths) and verifies the final
 * real path still lives under the sandbox root.
 *
 * Also exposes a small permission-level helper used by shell/package tools:
 *   SAFE | RESTRICTED | DANGEROUS
 *
 * Pure JavaScript (ES modules).
 */

import { promises as fs, realpathSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createLogger } from '../core/logger.js';
import { PermissionValue } from './permissions.js';

const log = createLogger('security:sandbox');

/** Coarse runtime security levels for process-spawning tools. */
export const SandboxLevel = Object.freeze({
  SAFE: 'safe',             // no shell, no package install, FS readonly-ish
  RESTRICTED: 'restricted', // sandboxed FS, restricted shell, npm --ignore-scripts
  DANGEROUS: 'dangerous',   // full shell, lifecycle scripts, still path-contained unless host FS
});

/**
 * Map a permission profile's shell/package/fs axes onto a SandboxLevel.
 * @param {Object} permissions - normalizePermissions() output
 * @returns {string}
 */
export function levelFromPermissions(permissions = {}) {
  if (
    permissions.shell === PermissionValue.ALLOW ||
    permissions.filesystem === PermissionValue.HOST
  ) {
    return SandboxLevel.DANGEROUS;
  }
  if (
    permissions.shell === PermissionValue.RESTRICTED ||
    permissions.package === PermissionValue.ALLOW ||
    permissions.package === PermissionValue.NO_SCRIPTS ||
    permissions.filesystem === PermissionValue.SANDBOX
  ) {
    return SandboxLevel.RESTRICTED;
  }
  return SandboxLevel.SAFE;
}

/**
 * Create a sandbox bound to a root directory.
 * @param {Object} [opts]
 * @param {string} [opts.rootDir]
 * @param {string} [opts.level]
 * @param {boolean} [opts.allowSymlinksOutside=false] only for host/admin
 * @returns {Sandbox}
 */
export function createSandbox(opts = {}) {
  return new Sandbox(opts);
}

export class Sandbox {
  /**
   * @param {Object} [opts]
   * @param {string} [opts.rootDir]
   * @param {string} [opts.level]
   * @param {boolean} [opts.allowSymlinksOutside]
   */
  constructor(opts = {}) {
    const rootDir = opts.rootDir || process.env.SCRAPPYAI_FILES_ROOT || process.cwd();
    this.root = path.resolve(rootDir);
    this.level = opts.level || SandboxLevel.RESTRICTED;
    this.allowSymlinksOutside = !!opts.allowSymlinksOutside;

    try {
      mkdirSync(this.root, { recursive: true });
    } catch (_err) {
      // root may already exist or be unwritable; resolveSafe will surface that later
    }

    // Cache the real path of the root so symlink-escape checks compare apples to apples.
    try {
      this.realRoot = realpathSync(this.root);
    } catch (_err) {
      this.realRoot = this.root;
    }

    log.info('sandbox:init', {
      root: this.root,
      realRoot: this.realRoot,
      level: this.level,
      allowSymlinksOutside: this.allowSymlinksOutside,
    });
  }

  /**
   * Lexical (no I/O) containment check — fast reject for obvious escapes.
   * @param {string} absPath
   * @returns {boolean}
   */
  isLexicallyInside(absPath) {
    const resolved = path.resolve(absPath);
    const rootWithSep = this.realRoot.endsWith(path.sep) ? this.realRoot : this.realRoot + path.sep;
    const rootLex = this.root.endsWith(path.sep) ? this.root : this.root + path.sep;
    return (
      resolved === this.realRoot ||
      resolved === this.root ||
      resolved.startsWith(rootWithSep) ||
      resolved.startsWith(rootLex)
    );
  }

  /**
   * Realpath-based containment. Walks existing prefix of the path so that
   * not-yet-created files still get their parent checked.
   * @param {string} absPath
   * @returns {string} the resolved absolute path (lexical; realpath of existing prefix verified)
   */
  assertInside(absPath) {
    if (this.level === SandboxLevel.DANGEROUS && this.allowSymlinksOutside) {
      // admin/host mode: still do lexical check against root unless root is effectively unrestricted
      return path.resolve(absPath);
    }

    const resolved = path.resolve(absPath);

    // Fast lexical reject
    if (!this.isLexicallyInside(resolved)) {
      throw sandboxError(
        `Path "${resolved}" escapes sandbox root "${this.realRoot}".`,
        'PATH_ESCAPE'
      );
    }

    // Realpath check on the longest existing prefix — catches symlink escapes.
    const real = this._realpathContained(resolved);
    if (!real.ok) {
      throw sandboxError(real.error, real.code || 'PATH_ESCAPE');
    }
    return resolved;
  }

  /**
   * Resolve a user-supplied relative (or absolute) path against the sandbox
   * root and enforce containment.
   * @param {string} relPath
   * @returns {string} absolute path inside the sandbox
   */
  resolve(relPath) {
    if (typeof relPath !== 'string' || !relPath.trim()) {
      throw sandboxError('A non-empty "path" is required.', 'INVALID_PATH');
    }
    // Absolute paths are interpreted relative to root only if they already
    // sit under root; otherwise rejected. Relative paths join root.
    let candidate;
    if (path.isAbsolute(relPath)) {
      candidate = path.resolve(relPath);
    } else {
      candidate = path.resolve(this.root, relPath);
    }
    return this.assertInside(candidate);
  }

  /**
   * Async variant of resolve that also realpath()'s the final path when it
   * already exists (stricter — use for reads).
   * @param {string} relPath
   * @returns {Promise<string>}
   */
  async resolveAsync(relPath) {
    const abs = this.resolve(relPath);
    try {
      const real = await fs.realpath(abs);
      if (!this._isRealInside(real)) {
        throw sandboxError(
          `Path "${relPath}" resolves via symlink to "${real}", outside sandbox root "${this.realRoot}".`,
          'SYMLINK_ESCAPE'
        );
      }
      return abs;
    } catch (err) {
      if (err.code === 'SYMLINK_ESCAPE' || err.code === 'PATH_ESCAPE') throw err;
      // ENOENT etc. — parent already verified by resolve()/assertInside
      return abs;
    }
  }

  /**
   * Relative path from sandbox root (for tool outputs).
   * @param {string} absPath
   * @returns {string}
   */
  relativize(absPath) {
    return path.relative(this.root, absPath) || '.';
  }

  /**
   * Whether package installs may run lifecycle scripts under this sandbox.
   * Only DANGEROUS (admin) + package:allow — RESTRICTED always strips scripts
   * because postinstall is arbitrary code execution.
   * @param {Object} [permissions]
   * @returns {boolean}
   */
  allowLifecycleScripts(permissions = {}) {
    if (this.level !== SandboxLevel.DANGEROUS) return false;
    if (permissions.package === PermissionValue.NO_SCRIPTS) return false;
    if (permissions.package === PermissionValue.NONE) return false;
    return permissions.package === PermissionValue.ALLOW;
  }

  /**
   * Whether unrestricted shell (useShell:true, no denylist) is permitted.
   * @param {Object} [permissions]
   * @returns {boolean}
   */
  allowUnrestrictedShell(permissions = {}) {
    return (
      this.level === SandboxLevel.DANGEROUS ||
      permissions.shell === PermissionValue.ALLOW
    );
  }

  // --- internals -----------------------------------------------------------

  _isRealInside(realPath) {
    const real = path.resolve(realPath);
    const rootWithSep = this.realRoot.endsWith(path.sep) ? this.realRoot : this.realRoot + path.sep;
    return real === this.realRoot || real.startsWith(rootWithSep);
  }

  /**
   * Walk from absPath upward until an existing node is found; realpath that
   * node; re-join the missing suffix; confirm the reconstructed path is still
   * under realRoot. Also, if any intermediate component is a symlink, resolve it.
   * @param {string} absPath
   * @returns {{ ok: true, real: string } | { ok: false, error: string, code: string }}
   */
  _realpathContained(absPath) {
    // Build the chain of prefixes from root-ward to the leaf.
    const parts = [];
    let cur = path.resolve(absPath);
    const seen = new Set();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      parts.unshift(cur);
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }

    // Find the deepest existing prefix.
    let existingIdx = -1;
    for (let i = parts.length - 1; i >= 0; i -= 1) {
      if (existsSync(parts[i])) {
        existingIdx = i;
        break;
      }
    }

    if (existingIdx === -1) {
      // Nothing exists — lexical check already passed; allow (parent will be created).
      return { ok: true, real: absPath };
    }

    // If any existing component is a symlink, resolve and verify.
    try {
      for (let i = 0; i <= existingIdx; i += 1) {
        const p = parts[i];
        let st;
        try {
          st = lstatSync(p);
        } catch (_err) {
          continue;
        }
        if (st.isSymbolicLink()) {
          const real = realpathSync(p);
          if (!this._isRealInside(real)) {
            return {
              ok: false,
              code: 'SYMLINK_ESCAPE',
              error: `Symlink "${path.relative(this.root, p) || p}" points to "${real}", outside sandbox root "${this.realRoot}".`,
            };
          }
        }
      }

      const existing = parts[existingIdx];
      const realExisting = realpathSync(existing);
      if (!this._isRealInside(realExisting)) {
        return {
          ok: false,
          code: 'SYMLINK_ESCAPE',
          error: `Path "${absPath}" resolves to "${realExisting}", outside sandbox root "${this.realRoot}".`,
        };
      }

      // Reconstruct full real path with the non-existing suffix.
      const suffix = parts.slice(existingIdx + 1).map((p) => path.basename(p));
      const reconstructed = suffix.length ? path.join(realExisting, ...suffix) : realExisting;
      // Final lexical check on reconstructed path
      if (!this._isRealInside(path.dirname(reconstructed)) && reconstructed !== this.realRoot) {
        // dirname of a file directly in root is realRoot — already covered
        if (!this._isRealInside(reconstructed)) {
          return {
            ok: false,
            code: 'PATH_ESCAPE',
            error: `Resolved path "${reconstructed}" escapes sandbox root "${this.realRoot}".`,
          };
        }
      }
      return { ok: true, real: reconstructed };
    } catch (err) {
      // Race / permission — fall back to lexical (already checked)
      log.debug('sandbox:realpath_fallback', { path: absPath, error: err.message });
      return { ok: true, real: absPath };
    }
  }
}

function sandboxError(message, code) {
  const err = new Error(message);
  err.code = code || 'SANDBOX_ERROR';
  return err;
}

export default {
  Sandbox,
  SandboxLevel,
  createSandbox,
  levelFromPermissions,
};
