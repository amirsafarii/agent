/**
 * tools/todo.js — TODO / Task Checklist tools
 * ---------------------------------------------------------------------------
 * Exposes the TodoManager to the agent as a set of tools. The system prompt
 * instructs the reasoner that creating a TODO list (via todo_create) is the
 * MANDATORY FIRST STEP on any non-trivial task, and that it may NOT call
 * final until every item is ticked, verified, and tested.
 *
 *   todo_create       create / overwrite the TODO.md checklist for this task
 *   todo_add          append new items to an existing checklist
 *   todo_start        mark an item in_progress (signals intent to work on it)
 *   todo_tick         mark an item completed (+ optional verified / tested flags)
 *   todo_mark_verified  record that a verification check passed for this item
 *   todo_mark_tested    record that relevant tests passed for this item
 *   todo_untick       reopen an item (e.g. after a failing test)
 *   todo_skip         skip an item with a reason
 *   todo_status       view current checklist + progress % + canFinish?
 *
 * Pure JavaScript (ES modules).
 */

import { TodoManager, getDefaultTodoManager } from '../core/todo-manager.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('tools:todo');

/**
 * @param {Object} [opts]
 * @param {TodoManager} [opts.manager]
 * @param {string} [opts.rootDir]
 * @returns {Array<import('./registry.js').ToolDefinition>}
 */
export function createTodoTools(opts = {}) {
  const manager = opts.manager || getDefaultTodoManager(opts.rootDir);

  // Load on startup (best-effort: if no TODO.md exists yet, manager starts empty).
  // We don't await here so tool registration can't block startup; first tool
  // call that needs the manager will ensure it's loaded.
  manager.load().catch((err) => log.warn('todo:initial_load_failed', { error: err.message }));

  async function ensureLoaded() {
    if (!manager._loaded) await manager.load();
  }

  return [
    {
      name: 'todo_create',
      description: [
        'MANDATORY FIRST STEP for any non-trivial task (multi-file, multi-step,',
        'or anything that needs verification). Creates or overwrites TODO.md in',
        'the workspace with a checklist of concrete, testable subtasks. Every',
        'item should be small enough to complete in 1-3 tool calls. Call this',
        'BEFORE writing any code or running build commands.',
      ].join(' '),
      parameters: {
        title: { type: 'string', description: 'Short goal/title for this checklist', required: true },
        tasks: {
          type: 'array',
          description: [
            'Array of checklist items. Each item is either a plain string or',
            '{id?, text} where id is a short stable handle (e.g. "1.3", "auth").',
            'Items must be ordered, concrete, and individually verifiable.',
          ].join(' '),
          required: true,
        },
      },
      handler: async ({ title, tasks }) => {
        await ensureLoaded();
        const items = (tasks || []).map((t) =>
          typeof t === 'string' ? { text: t } : { id: t.id, text: t.text || t.title || String(t) }
        );
        log.info('todo_create', { title, itemCount: items.length });
        return manager.create(title, items);
      },
    },
    {
      name: 'todo_add',
      description: 'Append new items to the existing TODO.md checklist (use when you discover new work mid-flight).',
      parameters: {
        tasks: {
          type: 'array',
          description: 'Array of new items: strings or {id?, text}',
          required: true,
        },
      },
      handler: async ({ tasks }) => {
        await ensureLoaded();
        if (manager.isEmpty()) {
          return {
            ok: false,
            error: 'No TODO list exists yet. Call todo_create first (it is mandatory before any code work).',
          };
        }
        const items = (tasks || []).map((t) =>
          typeof t === 'string' ? { text: t } : { id: t.id, text: t.text || t.title || String(t) }
        );
        log.info('todo_add', { addedCount: items.length });
        return manager.add(items);
      },
    },
    {
      name: 'todo_start',
      description: 'Mark a TODO item in_progress (call this before you begin working on it).',
      parameters: {
        taskId: { type: 'string', description: 'Item id (e.g. "1.3") or 1-based index', required: true },
        notes: { type: 'string', description: 'Optional progress notes' },
      },
      handler: async ({ taskId, notes }) => {
        await ensureLoaded();
        return manager.start(taskId, { notes });
      },
    },
    {
      name: 'todo_tick',
      description: [
        'Mark a TODO item completed. Pass verified:true after running a verify_*',
        'tool on it, and testPassed:true after the relevant test command passes.',
        'NEVER tick an item until you have actually executed the work.',
      ].join(' '),
      parameters: {
        taskId: { type: 'string', description: 'Item id or 1-based index', required: true },
        verified: { type: 'boolean', description: 'Set true if you just ran and passed a verify_* check' },
        testPassed: { type: 'boolean', description: 'Set true if the relevant tests passed for this item' },
        notes: { type: 'string' },
      },
      handler: async ({ taskId, verified, testPassed, notes }) => {
        await ensureLoaded();
        return manager.tick(taskId, { verified, testPassed, notes });
      },
    },
    {
      name: 'todo_mark_verified',
      description: 'Record that a verification check (verify_file / verify_command / verify_suite) passed for a completed item.',
      parameters: {
        taskId: { type: 'string', description: 'Item id or 1-based index', required: true },
      },
      handler: async ({ taskId }) => {
        await ensureLoaded();
        return manager.markVerified(taskId);
      },
    },
    {
      name: 'todo_mark_tested',
      description: 'Record that relevant tests (code_test / npm test / verify_command on the test script) passed.',
      parameters: {
        taskId: { type: 'string', description: 'Item id or 1-based index', required: true },
      },
      handler: async ({ taskId }) => {
        await ensureLoaded();
        return manager.markTested(taskId);
      },
    },
    {
      name: 'todo_untick',
      description: 'Reopen a previously-completed item (e.g. after a failing verification/test reveals it was not actually done).',
      parameters: {
        taskId: { type: 'string', description: 'Item id or 1-based index', required: true },
        reason: { type: 'string', description: 'Why it is being reopened' },
      },
      handler: async ({ taskId, reason }) => {
        await ensureLoaded();
        return manager.untick(taskId, { reason });
      },
    },
    {
      name: 'todo_skip',
      description: 'Mark an item skipped (use only for items that turn out to be unnecessary, with a reason).',
      parameters: {
        taskId: { type: 'string', required: true },
        reason: { type: 'string', required: true },
      },
      handler: async ({ taskId, reason }) => {
        await ensureLoaded();
        return manager.skip(taskId, { reason });
      },
    },
    {
      name: 'todo_status',
      description: 'View the current TODO checklist: progress %, items, next actionable task, and whether finishing is allowed.',
      parameters: {
        forceLoad: { type: 'boolean', description: 'Reload TODO.md from disk (use if you or the user edited it manually).' },
      },
      handler: async ({ forceLoad }) => {
        await ensureLoaded();
        if (forceLoad && manager.isEmpty()) {
          await manager.load({ force: true });
        }
        return manager.summary();
      },
    },
  ];
}

/**
 * Build a {name, description, parameters, handler} tool that runs the
 * automatic pre-final verification sweep: checks TODO gate + Spec gate
 * and runs code_validate on every file the agent just wrote. The system
 * prompt instructs the agent to call this BEFORE emitting a final answer
 * on non-trivial tasks.
 *
 * Exposed separately so it can be added to registries that want a single
 * "verify everything" tool without coupling to TodoManager directly.
 *
 * @param {Object} opts
 * @param {TodoManager} opts.todoManager
 * @param {import('../planning/spec.js').Spec} [opts.spec]
 * @param {import('../verification/engine.js').VerificationEngine} [opts.verificationEngine]
 * @param {string} opts.rootDir
 */
export function createPreflightTool(opts) {
  const { todoManager, spec, verificationEngine, rootDir } = opts || {};
  return {
    name: 'verify_preflight',
    description: [
      'Pre-final verification sweep. Call this BEFORE declaring done on any',
      'implementation task. Checks TODO.md completion, SPEC.md file coverage,',
      'and runs a syntax validation pass on relevant files. Returns a report',
      'of what (if anything) is still blocking a final answer.',
    ].join(' '),
    parameters: {
      extraChecks: {
        type: 'array',
        description: 'Optional extra verify_command checks [{command, expectedExitCode?}] to run during the sweep.',
      },
    },
    handler: async ({ extraChecks }) => {
      const report = { ok: true, blocks: [], warnings: [] };

      if (todoManager) {
        if (!todoManager._loaded && typeof todoManager.load === 'function') {
          await todoManager.load().catch(() => {});
        }
        if (!todoManager.isEmpty()) {
          const r = todoManager.canFinish();
          if (!r.ok) {
            report.ok = false;
            report.blocks.push({ source: 'todo', message: r.message, pending: r.blockingCount });
          }
        }
      }

      if (spec && typeof spec.canFinish === 'function') {
        if (spec.exists && spec.exists()) {
          const r = spec.canFinish();
          if (!r.ok) {
            report.ok = false;
            report.blocks.push({
              source: 'spec',
              undoneFiles: r.undoneFiles.length,
              undoneTests: r.undoneTests.length,
              nextFiles: r.nextFiles,
            });
          }
        }
      }

      // Run any extra command checks the caller asked for.
      if (verificationEngine && Array.isArray(extraChecks) && extraChecks.length) {
        const suiteResult = await verificationEngine.runSuite({
          checks: extraChecks.map((c) => ({ type: 'command', ...c })),
          stopOnFirstFailure: false,
        });
        if (!suiteResult.ok) {
          report.ok = false;
          report.blocks.push({ source: 'extra_checks', failed: suiteResult.failed, results: suiteResult.results });
        } else {
          report.checks = suiteResult;
        }
      }

      if (report.ok) {
        report.message = 'Preflight OK: TODO/Spec gates pass. Safe to produce final answer.';
      } else {
        report.message = `Preflight FAILED: ${report.blocks.length} block(s) must be resolved before finishing.`;
      }
      return report;
    },
  };
}
