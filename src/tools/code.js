/**
 * tools/code.js — code execution tools (run / test / validate)
 * -------------------------------------------------------------
 * Three tools for working with code inside the sandbox:
 *
 *   code_run       execute a code file (or inline code) with the right
 *                  interpreter for its language; bounded timeout, truncated
 *                  output, non-zero exit reported (never thrown)
 *   code_test      run a project's tests: a custom command, a specific file
 *                  (node --test / pytest), or the package.json "test" script
 *   code_validate  static check without executing: node --check, JSON parse,
 *                  python py_compile — returns valid:true/false + errors
 *
 * Pure JavaScript (ES modules). Uses execa for subprocesses.
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { execa } from 'execa';
import { createLogger } from '../logger.js';
import { splitCommand, truncate, cleanSpawnEnv } from './shell.js';

const log = createLogger('tools:code');

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT = 8_000;

const EXT_RUNNERS = {
  '.js': ['node'],
  '.mjs': ['node'],
  '.cjs': ['node'],
  '.ts': ['node', '--experimental-strip-types'],
  '.mts': ['node', '--experimental-strip-types'],
  '.py': ['python3'],
  '.sh': ['bash'],
};

const EXT_VALIDATORS = {
  '.js': ['node', '--check'],
  '.mjs': ['node', '--check'],
  '.cjs': ['node', '--check'],
  '.json': 'json',
  '.py': ['python3', '-m', 'py_compile'],
};

const LANG_RUNNERS = {
  js: ['node', '--input-type=module', '-e'],
  ts: ['node', '--experimental-strip-types', '--input-type=module', '-e'],
  python: ['python3', '-c'],
  py: ['python3', '-c'],
  bash: ['bash', '-c'],
  sh: ['bash', '-c'],
};

/**
 * @param {Object} [opts]
 * @param {string} [opts.rootDir] sandbox root for path args
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.maxOutputChars]
 * @returns {Array<import('../tools.js').ToolDefinition>}
 */
export function createCodeTools(opts = {}) {
  const {
    rootDir = process.cwd(),
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxOutputChars = DEFAULT_MAX_OUTPUT,
  } = opts;

  const root = path.resolve(rootDir);

  function resolveSafe(relPath) {
    const resolved = path.resolve(root, relPath);
    const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
    if (resolved !== root && !resolved.startsWith(rootWithSep)) {
      throw codeError(`Path "${relPath}" escapes sandbox root "${root}".`, 'PATH_ESCAPE');
    }
    return resolved;
  }

  /** Run argv via execa and shape the result like the shell tool does. */
  async function run(argv, { cwd = root, timeout, label } = {}) {
    const startedAt = Date.now();
    log.info('code:run_start', { label, argv, cwd, timeout });
    try {
      const result = await execa(argv[0], argv.slice(1), {
        cwd,
        timeout,
        reject: false,
        shell: false,
        env: cleanSpawnEnv(),
        extendEnv: false,
      });
      const output = {
        command: argv.join(' '),
        exitCode: result.exitCode ?? null,
        timedOut: !!result.timedOut,
        stdout: truncate(result.stdout, maxOutputChars),
        stderr: truncate(result.stderr, maxOutputChars),
      };
      log.info('code:run_done', { label, durationMs: Date.now() - startedAt, exitCode: output.exitCode, timedOut: output.timedOut });
      return output;
    } catch (err) {
      log.error('code:run_failed', { label, durationMs: Date.now() - startedAt, error: err.message });
      throw codeError(`Failed to run "${argv.join(' ')}": ${err.message}`, err.code || 'RUN_ERROR');
    }
  }

  const runTool = {
    name: 'code_run',
    description:
      'Execute a code file (or inline code) with the interpreter matching its language ' +
      '(.js/.mjs/.cjs/.ts -> node, .py -> python3, .sh -> bash). Bounded timeout, truncated output, ' +
      'non-zero exit code is reported in the result (never thrown).',
    parameters: {
      path: { type: 'string', description: 'Code file path relative to sandbox root. Mutually exclusive with code.' },
      code: { type: 'string', description: 'Inline code to run. Mutually exclusive with path.' },
      language: { type: 'string', description: 'For inline code: js (default), python, bash, ts.' },
      args: { type: 'array', description: 'Extra arguments passed to the program (e.g. ["--flag", "value"]).' },
      cwd: { type: 'string', description: 'Working directory for the run (defaults to the sandbox root).' },
      timeoutMs: { type: 'number', description: `Per-call timeout override (default ${timeoutMs}ms).` },
    },
    handler: async (args) => {
      const runTimeout = Number.isFinite(args.timeoutMs) ? args.timeoutMs : timeoutMs;
      const extra = Array.isArray(args.args) ? args.args.map(String) : [];
      const cwd = args.cwd ? resolveSafe(args.cwd) : root;

      if (args.path) {
        const abs = resolveSafe(args.path);
        const runner = EXT_RUNNERS[path.extname(abs).toLowerCase()] || ['node'];
        return run([...runner, abs, ...extra], { cwd, timeout: runTimeout, label: args.path });
      }
      if (typeof args.code === 'string' && args.code.trim()) {
        const lang = String(args.language || 'js').toLowerCase();
        const runner = LANG_RUNNERS[lang];
        if (!runner) {
          throw codeError(`Unsupported inline language "${args.language}" (js|ts|python|bash).`, 'UNSUPPORTED_LANGUAGE');
        }
        return run([...runner, args.code, ...extra], { cwd, timeout: runTimeout, label: `inline ${lang}` });
      }
      throw codeError('Provide either "path" (a code file) or "code" (inline source).', 'NO_INPUT');
    },
  };

  const testTool = {
    name: 'code_test',
    description:
      'Run tests. Three modes: (1) "command" — run that exact test command; (2) "path" — run one test file ' +
      '(.js/.mjs -> node --test, .py -> pytest); (3) neither — run the package.json "test" script (npm test) ' +
      'in the sandbox root, or bare node --test. Reports exit code; never throws on test failures.',
    parameters: {
      command: { type: 'string', description: 'Exact test command to run, e.g. "node --test tests/foo.test.js".' },
      path: { type: 'string', description: 'A single test file to run (relative to sandbox root).' },
      cwd: { type: 'string', description: 'Working directory (defaults to the sandbox root).' },
      timeoutMs: { type: 'number', description: `Per-call timeout override (default ${timeoutMs}ms).` },
    },
    handler: async (args) => {
      const runTimeout = Number.isFinite(args.timeoutMs) ? args.timeoutMs : timeoutMs;
      const cwd = args.cwd ? resolveSafe(args.cwd) : root;

      if (args.command) {
        const [bin, ...rest] = splitCommand(String(args.command).trim());
        return run([bin, ...rest], { cwd, timeout: runTimeout, label: args.command });
      }
      if (args.path) {
        const abs = resolveSafe(args.path);
        const ext = path.extname(abs).toLowerCase();
        if (ext === '.py') return run(['python3', '-m', 'pytest', abs], { cwd, timeout: runTimeout, label: args.path });
        return run(['node', '--test', abs], { cwd, timeout: runTimeout, label: args.path });
      }
      // No explicit command/path: try the package.json "test" script, else bare node --test.
      try {
        const pkg = JSON.parse(await fs.readFile(path.join(cwd, 'package.json'), 'utf8'));
        if (pkg.scripts && typeof pkg.scripts.test === 'string') {
          return run(['npm', 'test'], { cwd, timeout: runTimeout, label: 'npm test' });
        }
      } catch (_err) {
        // no package.json / unparsable — fall through
      }
      return run(['node', '--test'], { cwd, timeout: runTimeout, label: 'node --test' });
    },
  };

  const validateTool = {
    name: 'code_validate',
    description:
      'Static validation WITHOUT executing the code: node --check for JavaScript/TypeScript syntax, ' +
      'JSON.parse for .json, py_compile for Python. Returns {valid, errors} — invalid code never runs.',
    parameters: {
      path: { type: 'string', description: 'File to validate (relative to sandbox root). Mutually exclusive with code.' },
      code: { type: 'string', description: 'Inline code to validate.' },
      language: { type: 'string', description: 'For inline code: js (default), json, python.' },
    },
    handler: async (args) => {
      let abs = null;
      let ext = '.js';
      let inline = null;
      if (args.path) {
        abs = resolveSafe(args.path);
        ext = path.extname(abs).toLowerCase();
      } else if (typeof args.code === 'string') {
        inline = args.code;
        const lang = String(args.language || 'js').toLowerCase();
        ext = lang === 'json' ? '.json' : lang === 'python' || lang === 'py' ? '.py' : lang === 'ts' ? '.ts' : '.js';
      } else {
        throw codeError('Provide either "path" or "code" to validate.', 'NO_INPUT');
      }

      // JSON: no subprocess needed.
      if (ext === '.json') {
        let text;
        try {
          text = abs ? await fs.readFile(abs, 'utf8') : inline;
          JSON.parse(text);
          return { valid: true, errors: [], path: args.path || null, checked: 'json' };
        } catch (err) {
          return { valid: false, errors: [`Invalid JSON: ${err.message}`], path: args.path || null, checked: 'json' };
        }
      }

      const checker = EXT_VALIDATORS[ext];
      if (!checker) {
        throw codeError(`No static validator for "${ext}" files (supported: .js .mjs .cjs .json .py).`, 'UNSUPPORTED_TYPE');
      }

      // Inline code -> materialize in a temp file under the sandbox so the
      // same checker (node --check / py_compile) can run on it.
      if (!abs) {
        const tmpDir = path.join(root, '.scrappyai-tmp');
        await fs.mkdir(tmpDir, { recursive: true });
        abs = path.join(tmpDir, `validate_${Date.now()}${ext}`);
        await fs.writeFile(abs, inline, 'utf8');
      }

      const startedAt = Date.now();
      try {
        const result = await execa(checker[0], checker.slice(1).concat(abs), { reject: false, env: cleanSpawnEnv(), extendEnv: false });
        const errors = result.stderr || result.stdout ? [truncate(`${result.stderr || ''}${result.stdout || ''}`.trim(), maxOutputChars)] : [];
        log.info('code_validate:done', { path: args.path || '(inline)', valid: result.exitCode === 0, durationMs: Date.now() - startedAt });
        return { valid: result.exitCode === 0, errors, path: args.path || null, checked: checker.join(' ') };
      } catch (err) {
        throw codeError(`Validator failed to run: ${err.message}`, err.code || 'VALIDATOR_ERROR');
      }
    },
  };

  return [runTool, testTool, validateTool];
}

function codeError(message, code) {
  const err = new Error(message);
  err.code = code || 'CODE_ERROR';
  return err;
}

export default createCodeTools;
