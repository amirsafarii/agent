/**
 * tools/files.js — read/write files under a sandboxed root
 * -----------------------------------------------
 * Two tools: "read_file" and "write_file". Both resolve paths against a
 * fixed `rootDir` and refuse to escape it (blocks "../" traversal and
 * absolute paths pointing elsewhere), so an agent can't be tricked into
 * touching files outside its workspace.
 *
 * Pure JavaScript (ES modules), Node's built-in fs/promises only.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createLogger } from '../logger.js';

const log = createLogger('tools:files');

const DEFAULT_MAX_READ_CHARS = 20_000;
const DEFAULT_MAX_WRITE_CHARS = 200_000;

/**
 * @param {Object} [opts]
 * @param {string} [opts.rootDir] sandbox root, defaults to process.cwd()
 * @param {number} [opts.maxReadChars]
 * @param {number} [opts.maxWriteChars]
 * @returns {{readTool: import('../tools.js').ToolDefinition, writeTool: import('../tools.js').ToolDefinition}}
 */
export function createFileTools(opts = {}) {
  const {
    rootDir = process.cwd(),
    maxReadChars = DEFAULT_MAX_READ_CHARS,
    maxWriteChars = DEFAULT_MAX_WRITE_CHARS,
  } = opts;

  const root = path.resolve(rootDir);

  function resolveSafe(relPath) {
    const resolved = path.resolve(root, relPath);
    const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
    if (resolved !== root && !resolved.startsWith(rootWithSep)) {
      throw fileError(`Path "${relPath}" escapes sandbox root "${root}".`, 'PATH_ESCAPE');
    }
    return resolved;
  }

  const readTool = {
    name: 'read_file',
    description: `Read a UTF-8 text file, relative to the sandbox root (${root}).`,
    parameters: {
      path: { type: 'string', required: true, description: 'Path relative to sandbox root.' },
      encoding: { type: 'string', description: 'Defaults to "utf8".' },
    },
    handler: async (args) => {
      const abs = resolveSafe(args.path);
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
      const output = { path: args.path, bytesWritten: Buffer.byteLength(args.content, 'utf8'), appended: !!args.append };
      log.info('write_file:done', output);
      return output;
    },
  };

  return { readTool, writeTool };
}

function fileError(message, code) {
  const err = new Error(message);
  err.code = code || 'FILE_ERROR';
  return err;
}

export default createFileTools;
