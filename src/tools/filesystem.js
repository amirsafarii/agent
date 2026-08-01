/**
 * tools/filesystem.js — the full filesystem tool suite
 * -----------------------------------------------------
 * Ten tools, all confined to a sandbox root (path traversal and absolute
 * paths outside the root are rejected before any fs call):
 *
 *   read_file      read a UTF-8 text file (capped)
 *   write_file     create/overwrite/append a file (capped, creates parents)
 *   edit_file      targeted find/replace edit (literal or regex), no full rewrite
 *   apply_patch    patch-based editing: read → validate → apply atomically → verify
 *   list_dir       list a directory (flat or recursive, depth-capped)
 *   search_files   find files by glob pattern, optionally grep contents
 *   make_dir       mkdir -p
 *   move_file      rename/move (cross-device safe)
 *   copy_file      copy a file or a directory tree
 *   delete_file    delete a file or directory (requiresApproval: true)
 *
 * `delete_file` is gated through AgentLoop's approval gate by default —
 * deletion is destructive and a human/auto policy should see it first.
 *
 * Pure JavaScript (ES modules), Node's built-in fs/promises only.
 */

import { promises as fs, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createLogger } from '../core/logger.js';
import { createSandbox } from '../security/sandbox.js';
import { checkCompleteness, formatCompletenessResult } from '../verification/completeness.js';

const log = createLogger('tools:filesystem');

const DEFAULT_MAX_READ_CHARS = 20_000;
const DEFAULT_MAX_WRITE_CHARS = 200_000;
const DEFAULT_MAX_LIST_ENTRIES = 500;
const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_MAX_SEARCH_RESULTS = 100;

/**
 * @param {Object} [opts]
 * @param {string} [opts.rootDir] sandbox root, defaults to process.cwd()
 * @param {import('../security/sandbox.js').Sandbox} [opts.sandbox] reuse a shared Sandbox
 * @param {number} [opts.maxReadChars]
 * @param {number} [opts.maxWriteChars]
 * @returns {Array<import('./registry.js').ToolDefinition>} nine registered-ready tool definitions
 */
export function createFilesystemTools(opts = {}) {
  const {
    rootDir = process.cwd(),
    maxReadChars = DEFAULT_MAX_READ_CHARS,
    maxWriteChars = DEFAULT_MAX_WRITE_CHARS,
    maxListEntries = DEFAULT_MAX_LIST_ENTRIES,
    maxDepth = DEFAULT_MAX_DEPTH,
    maxSearchResults = DEFAULT_MAX_SEARCH_RESULTS,
  } = opts;

  // Realpath-based sandbox: rejects symlink escapes (sandbox/link → /etc).
  const sandbox = opts.sandbox || createSandbox({ rootDir });
  const root = sandbox.root;
  try {
    mkdirSync(root, { recursive: true });
  } catch (_err) {}

  function resolveSafe(relPath) {
    try {
      return sandbox.resolve(relPath);
    } catch (err) {
      throw fileError(err.message, err.code || 'PATH_ESCAPE');
    }
  }

  /** Resolve a path but allow the sandbox root itself as an explicit target. */
  function rel(abs) {
    return sandbox.relativize(abs);
  }

  const readTool = {
    name: 'read_file',
    description: `Read a UTF-8 text file, relative to the sandbox root (${root}).`,
    parameters: {
      path: { type: 'string', required: true, description: 'Path relative to sandbox root.' },
      encoding: { type: 'string', description: 'Defaults to "utf8".' },
    },
    handler: async (args, ctx = {}) => {
      // Use the tool's own sandbox (bound to rootDir at construction). The
      // registry may pass a different ambient sandbox; only fall back to it
      // when this tool was built without one. Always realpath-check.
      if (ctx.signal?.aborted) throw fileError('aborted', 'ABORTED');
      const abs = resolveSafe(args.path);
      try {
        await sandbox.resolveAsync(args.path);
      } catch (e) {
        throw fileError(e.message, e.code || 'SYMLINK_ESCAPE');
      }
      const encoding = args.encoding || 'utf8';
      log.info('read_file:start', { path: args.path, abs, encoding });
      let content;
      try {
        content = await fs.readFile(abs, encoding);
      } catch (err) {
        log.error('read_file:failed', { path: args.path, error: err.message, code: err.code });
        throw fileError(`Failed to read "${args.path}": ${err.message}`, err.code || 'READ_ERROR');
      }
      const truncated = content.length > maxReadChars;
      log.info('read_file:done', { path: args.path, totalChars: content.length, truncated });
      return {
        path: args.path,
        content: truncated ? content.slice(0, maxReadChars) : content,
        truncated,
        totalChars: content.length,
      };
    },
  };

  const writeTool = {
    name: 'write_file',
    description: `Write (create or overwrite) a UTF-8 text file, relative to the sandbox root (${root}). Creates parent directories as needed.`,
    parameters: {
      path: { type: 'string', required: true, description: 'Path relative to sandbox root.' },
      content: { type: 'string', required: true, description: 'File contents to write.' },
      append: { type: 'boolean', description: 'Append instead of overwrite. Default false.' },
    },
    handler: async (args) => {
      log.info('write_file:start', { path: args.path, contentChars: args.content.length, append: !!args.append });
      if (args.content.length > maxWriteChars) {
        log.error('write_file:too_large', { path: args.path, contentChars: args.content.length, maxWriteChars });
        throw fileError(
          `Refusing to write ${args.content.length} chars, exceeds limit of ${maxWriteChars}.`,
          'WRITE_TOO_LARGE'
        );
      }
      const abs = resolveSafe(args.path);
      try {
        await fs.mkdir(path.dirname(abs), { recursive: true });
        if (args.append) {
          await fs.appendFile(abs, args.content, 'utf8');
        } else {
          await fs.writeFile(abs, args.content, 'utf8');
        }
      } catch (err) {
        log.error('write_file:failed', { path: args.path, error: err.message, code: err.code });
        throw fileError(`Failed to write "${args.path}": ${err.message}`, err.code || 'WRITE_ERROR');
      }
      // Anti-half-baked-code scan: on non-append writes of source-code-like
      // extensions, run the completeness detector so placeholders / stubs /
      // truncated code are caught BEFORE the agent ticks the TODO item.
      let completeness = null;
      if (!args.append) {
        const ext = (args.path.split('.').pop() || '').toLowerCase();
        const codeExts = new Set(['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'sh', 'bash', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'hpp', 'rb', 'php']);
        if (codeExts.has(ext)) {
          const res = checkCompleteness(args.content, args.path);
          completeness = {
            ok: res.ok,
            errors: res.errors.length,
            warnings: res.warnings.length,
            details: formatCompletenessResult(res, args.path),
          };
          if (!res.ok) {
            log.warn('write_file:completeness_failed', { path: args.path, errors: res.errors.length });
          }
        }
      }

      const output = {
        path: args.path,
        bytesWritten: Buffer.byteLength(args.content, 'utf8'),
        appended: !!args.append,
        ...(completeness ? { completeness } : {}),
      };
      log.info('write_file:done', { path: args.path, bytesWritten: output.bytesWritten, completenessOk: completeness?.ok ?? 'n/a' });
      return output;
    },
  };

  const editTool = {
    name: 'edit_file',
    description: `Edit a file with a targeted find/replace — no full rewrite needed. Replaces the FIRST occurrence of old_text (or all with replace_all:true). Fails loudly if old_text is not found, so a stale assumption never silently corrupts a file. Relative to sandbox root (${root}).`,
    parameters: {
      path: { type: 'string', required: true, description: 'Path relative to sandbox root.' },
      old_text: { type: 'string', required: true, description: 'Exact text to find (or a regex source when useRegex:true).' },
      new_text: { type: 'string', required: true, description: 'Replacement text.' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence instead of just the first. Default false.' },
      useRegex: { type: 'boolean', description: 'Treat old_text as a regular expression. Default false.' },
    },
    handler: async (args) => {
      const abs = resolveSafe(args.path);
      let content;
      try {
        content = await fs.readFile(abs, 'utf8');
      } catch (err) {
        throw fileError(`Failed to read "${args.path}": ${err.message}`, err.code || 'READ_ERROR');
      }
      let replaced = 0;
      let next;
      if (args.useRegex) {
        let re;
        try {
          re = new RegExp(args.old_text, args.replace_all ? 'g' : undefined);
        } catch (err) {
          throw fileError(`Invalid regex "${args.old_text}": ${err.message}`, 'INVALID_REGEX');
        }
        next = content.replace(re, () => {
          replaced += 1;
          return args.new_text;
        });
      } else if (args.replace_all) {
        const parts = content.split(args.old_text);
        replaced = parts.length - 1;
        next = parts.join(args.new_text);
      } else {
        const idx = content.indexOf(args.old_text);
        replaced = idx === -1 ? 0 : 1;
        next = idx === -1 ? content : content.slice(0, idx) + args.new_text + content.slice(idx + args.old_text.length);
      }
      if (replaced === 0) {
        throw fileError(
          `old_text not found in "${args.path}" (${args.useRegex ? 'regex' : 'literal'} mode, replace_all=${!!args.replace_all}).`,
          'NOT_FOUND'
        );
      }
      if (next.length > maxWriteChars) {
        throw fileError(`Result would be ${next.length} chars, exceeds limit of ${maxWriteChars}.`, 'WRITE_TOO_LARGE');
      }
      try {
        await fs.writeFile(abs, next, 'utf8');
      } catch (err) {
        throw fileError(`Failed to write "${args.path}": ${err.message}`, err.code || 'WRITE_ERROR');
      }
      const output = { path: args.path, replaced, totalChars: next.length };
      log.info('edit_file:done', output);
      return output;
    },
  };

  const listTool = {
    name: 'list_dir',
    description: `List directory entries relative to the sandbox root (${root}). Flat by default; recursive walks are depth-capped and entry-capped so a huge tree cannot flood the context.`,
    parameters: {
      path: { type: 'string', description: 'Directory path, defaults to the sandbox root (.).' },
      recursive: { type: 'boolean', description: 'Walk subdirectories (depth-capped). Default false.' },
      includeHidden: { type: 'boolean', description: 'Include dot-files/dot-dirs. Default false.' },
      maxDepth: { type: 'number', description: `Recursion depth cap (default ${maxDepth}).` },
    },
    handler: async (args) => {
      const abs = resolveSafe(args.path || '.');
      const depthCap = Number.isFinite(args.maxDepth) ? Math.max(1, args.maxDepth) : maxDepth;
      const entries = [];
      const seen = new Set();

      async function walk(dirAbs, depth) {
        if (entries.length >= maxListEntries) return;
        let names;
        try {
          names = await fs.readdir(dirAbs, { withFileTypes: true });
        } catch (err) {
          throw fileError(`Failed to list "${args.path || '.'}": ${err.message}`, err.code || 'LIST_ERROR');
        }
        names.sort((a, b) => a.name.localeCompare(b.name));
        for (const dirent of names) {
          if (entries.length >= maxListEntries) break;
          if (!args.includeHidden && dirent.name.startsWith('.')) continue;
          const full = path.join(dirAbs, dirent.name);
          const isDir = dirent.isDirectory();
          let size = null;
          if (!isDir && dirent.isFile()) {
            try {
              const st = await fs.stat(full);
              size = st.size;
            } catch (_err) {
              size = null;
            }
          }
          entries.push({ name: dirent.name, path: rel(full), type: isDir ? 'dir' : 'file', size });
          if (isDir && args.recursive && depth < depthCap) {
            await walk(full, depth + 1);
          }
        }
      }

      await walk(abs, 1);
      const output = {
        path: args.path || '.',
        entryCount: entries.length,
        truncated: entries.length >= maxListEntries,
        entries,
      };
      log.info('list_dir:done', { path: args.path || '.', entryCount: output.entryCount, truncated: output.truncated });
      return output;
    },
  };

  /** Tiny glob->regex: supports *, ?, ** and character classes pass through. */
  function globToRegExp(glob) {
    const escaped = glob
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '\u0000') // hold ** so * handling below doesn't eat it
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '[^/]')
      .replace(/\u0000/g, '.*');
    return new RegExp(`^${escaped}$`);
  }

  const searchTool = {
    name: 'search_files',
    description: `Find files by glob pattern (e.g. "**/*.js", "*.md", "src/**/index.*") relative to the sandbox root (${root}), optionally filtered by a text substring inside the file contents. Result list is capped (${maxSearchResults}) to protect the context budget.`,
    parameters: {
      pattern: { type: 'string', required: true, description: 'Glob pattern of file paths to match.' },
      text: { type: 'string', description: 'If set, only files whose contents contain this substring are returned.' },
      path: { type: 'string', description: 'Search root (relative to sandbox root). Defaults to the whole sandbox.' },
      maxResults: { type: 'number', description: `Result cap override (default ${maxSearchResults}).` },
    },
    handler: async (args) => {
      const searchRoot = resolveSafe(args.path || '.');
      const re = globToRegExp(args.pattern);
      const cap = Number.isFinite(args.maxResults) ? Math.max(1, args.maxResults) : maxSearchResults;
      const matches = [];

      async function walk(dirAbs) {
        if (matches.length >= cap) return;
        let names;
        try {
          names = await fs.readdir(dirAbs, { withFileTypes: true });
        } catch (_err) {
          return; // unreadable dirs are skipped, not fatal
        }
        for (const dirent of names) {
          if (matches.length >= cap) return;
          if (dirent.name.startsWith('.')) continue;
          const full = path.join(dirAbs, dirent.name);
          const relPath = rel(full);
          if (dirent.isDirectory()) {
            await walk(full);
          } else if (dirent.isFile() && re.test(relPath)) {
            if (args.text) {
              try {
                const content = await fs.readFile(full, 'utf8');
                if (!content.includes(args.text)) continue;
              } catch (_err) {
                continue;
              }
            }
            let size = null;
            try {
              size = (await fs.stat(full)).size;
            } catch (_err) {
              size = null;
            }
            matches.push({ path: relPath, size });
          }
        }
      }

      await walk(searchRoot);
      const output = {
        pattern: args.pattern,
        text: args.text || null,
        resultCount: matches.length,
        truncated: matches.length >= cap,
        results: matches,
      };
      log.info('search_files:done', { pattern: args.pattern, resultCount: output.resultCount, truncated: output.truncated });
      return output;
    },
  };

  const mkdirTool = {
    name: 'make_dir',
    description: `Create a directory (and any missing parents), relative to the sandbox root (${root}).`,
    parameters: {
      path: { type: 'string', required: true, description: 'Directory path relative to sandbox root.' },
    },
    handler: async (args) => {
      const abs = resolveSafe(args.path);
      try {
        await fs.mkdir(abs, { recursive: true });
      } catch (err) {
        throw fileError(`Failed to create directory "${args.path}": ${err.message}`, err.code || 'MKDIR_ERROR');
      }
      const output = { path: args.path, created: true };
      log.info('make_dir:done', output);
      return output;
    },
  };

  const moveTool = {
    name: 'move_file',
    description: `Move (rename) a file or directory within the sandbox (${root}). Creates the destination's parent directories.`,
    parameters: {
      source: { type: 'string', required: true, description: 'Source path relative to sandbox root.' },
      destination: { type: 'string', required: true, description: 'Destination path relative to sandbox root.' },
    },
    handler: async (args) => {
      const from = resolveSafe(args.source);
      const to = resolveSafe(args.destination);
      try {
        await fs.mkdir(path.dirname(to), { recursive: true });
        try {
          await fs.rename(from, to);
        } catch (err) {
          if (err.code !== 'EXDEV' && err.code !== 'EPERM') throw err;
          // cross-device move: copy + unlink
          await fs.cp(from, to, { recursive: true });
          await fs.rm(from, { recursive: true, force: true });
        }
      } catch (err) {
        throw fileError(`Failed to move "${args.source}" -> "${args.destination}": ${err.message}`, err.code || 'MOVE_ERROR');
      }
      const output = { source: args.source, destination: args.destination, moved: true };
      log.info('move_file:done', output);
      return output;
    },
  };

  const copyTool = {
    name: 'copy_file',
    description: `Copy a file or a whole directory tree within the sandbox (${root}). Creates the destination's parent directories.`,
    parameters: {
      source: { type: 'string', required: true, description: 'Source path relative to sandbox root.' },
      destination: { type: 'string', required: true, description: 'Destination path relative to sandbox root.' },
    },
    handler: async (args) => {
      const from = resolveSafe(args.source);
      const to = resolveSafe(args.destination);
      try {
        await fs.mkdir(path.dirname(to), { recursive: true });
        await fs.cp(from, to, { recursive: true, errorOnExist: false });
      } catch (err) {
        throw fileError(`Failed to copy "${args.source}" -> "${args.destination}": ${err.message}`, err.code || 'COPY_ERROR');
      }
      const output = { source: args.source, destination: args.destination, copied: true };
      log.info('copy_file:done', output);
      return output;
    },
  };

  const deleteTool = {
    name: 'delete_file',
    description: `Delete a file or directory inside the sandbox (${root}). Destructive — this tool is gated by the loop's tool-approval gate by default (requiresApproval:true), so a human or an onToolApproval policy decides before anything is removed.`,
    parameters: {
      path: { type: 'string', required: true, description: 'Path to delete, relative to sandbox root.' },
      recursive: { type: 'boolean', description: 'Delete a non-empty directory and its contents. Default false.' },
    },
    requiresApproval: true,
    handler: async (args) => {
      const abs = resolveSafe(args.path);
      if (rel(abs) === '.') {
        throw fileError('Refusing to delete the sandbox root itself.', 'ROOT_DELETE');
      }
      try {
        const st = await fs.lstat(abs);
        if (st.isDirectory() && !args.recursive) {
          throw fileError(`"${args.path}" is a directory — pass recursive:true to delete it and its contents.`, 'IS_DIRECTORY');
        }
        await fs.rm(abs, { recursive: !!args.recursive, force: false });
      } catch (err) {
        if (err.code === 'ROOT_DELETE' || err.code === 'IS_DIRECTORY') throw err;
        throw fileError(`Failed to delete "${args.path}": ${err.message}`, err.code || 'DELETE_ERROR');
      }
      const output = { path: args.path, deleted: true };
      log.info('delete_file:done', output);
      return output;
    },
  };

  // --- Patch-based editing ----------------------------------------------
  // read → validate patch → apply atomically → (optionally) verify.
  // Safer than a blind full overwrite: every hunk must match exactly once or
  // the whole patch is rejected with VALIDATION_ERROR (nothing is written).
  const patchTool = {
    name: 'apply_patch',
    description: `Apply a structured patch to a file atomically: read → validate → apply → (optionally) verify. A patch is a list of hunks, each {old, new}. Every "old" must exist exactly once in the file or the ENTIRE patch is rejected and nothing is written. Safer than a blind full-file overwrite.`,
    version: '1.0.0',
    parameters: {
      file: { type: 'string', required: true, description: 'Path relative to sandbox root.' },
      hunks: {
        type: 'array',
        required: true,
        description: 'List of patch hunks: [{old: string, new: string}]. Each "old" must appear exactly once.',
      },
      verify: {
        type: 'object',
        description: 'Optional post-apply check: {command: string, expectedExitCode: number}. Runs after applying and is included in the result.',
      },
    },
    handler: async (args) => {
      const abs = resolveSafe(args.file);
      let content;
      try {
        content = await fs.readFile(abs, 'utf8');
      } catch (err) {
        throw fileError(`Failed to read "${args.file}": ${err.message}`, err.code || 'READ_ERROR');
      }
      const hunks = Array.isArray(args.hunks) ? args.hunks : [];
      if (hunks.length === 0) {
        throw fileError('apply_patch requires a non-empty "hunks" array.', 'VALIDATION_ERROR');
      }

      // Validate every hunk against the ORIGINAL content first — all hunks
      // must match exactly once; otherwise reject before touching the file.
      for (let i = 0; i < hunks.length; i += 1) {
        const h = hunks[i];
        if (!h || typeof h.old !== 'string') {
          throw fileError(`Hunk ${i + 1} is missing a string "old".`, 'VALIDATION_ERROR');
        }
        const matches = content.split(h.old).length - 1;
        if (matches !== 1) {
          throw fileError(
            `Hunk ${i + 1} "old" matched ${matches} time(s) — each hunk must match exactly once.`,
            'VALIDATION_ERROR'
          );
        }
      }

      // Apply atomically: validate all passed, so now build the final content
      // and write it once. This never leaves a half-patched file.
      let next = content;
      const applied = [];
      for (let i = 0; i < hunks.length; i += 1) {
        const h = hunks[i];
        const idx = next.indexOf(h.old);
        if (idx === -1) {
          // Should not happen (validated above), but guard anyway.
          throw fileError(`Hunk ${i + 1} "old" not found during apply.`, 'VALIDATION_ERROR');
        }
        next = next.slice(0, idx) + (h.new || '') + next.slice(idx + h.old.length);
        applied.push(i + 1);
      }
      if (next.length > maxWriteChars) {
        throw fileError(`Result would be ${next.length} chars, exceeds limit of ${maxWriteChars}.`, 'WRITE_TOO_LARGE');
      }
      await fs.writeFile(abs, next, 'utf8');

      const output = {
        path: args.file,
        hunksApplied: applied.length,
        totalChars: next.length,
        beforeHash: sha256hex(content),
        afterHash: sha256hex(next),
      };

      // Optional post-apply verification step.
      if (args.verify && typeof args.verify === 'object' && args.verify.command) {
        output.verify = await runVerifyCommand(args.verify, { cwd: root });
      }

      log.info('apply_patch:done', { path: args.file, hunksApplied: output.hunksApplied });
      return output;
    },
  };

  return [readTool, writeTool, editTool, listTool, searchTool, mkdirTool, moveTool, copyTool, deleteTool, patchTool];
}

function sha256hex(text) {
  return createHash('sha256').update(String(text)).digest('hex');
}

async function runVerifyCommand(verify, { cwd }) {
  const { execa } = await import('execa');
  const start = Date.now();
  try {
    const proc = await execa(verify.command, {
      shell: true,
      cwd,
      timeout: verify.timeoutMs || 30_000,
      reject: false,
    });
    return {
      ok: (proc.exitCode ?? 0) === (verify.expectedExitCode ?? 0),
      exitCode: proc.exitCode ?? 0,
      expectedExitCode: verify.expectedExitCode ?? 0,
      stdout: proc.stdout.slice(0, 1000),
      stderr: proc.stderr.slice(0, 1000),
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return { ok: false, error: err.message, durationMs: Date.now() - start };
  }
}

function fileError(message, code) {
  const err = new Error(message);
  err.code = code || 'FILE_ERROR';
  return err;
}

export default createFilesystemTools;
