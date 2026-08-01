/**
 * tools/spec.js — Planner-Executor Spec (PRD) tools
 * ---------------------------------------------------------------------------
 * Exposes the Spec model to the agent. The system prompt enforces:
 *
 *   1. On any multi-file / multi-component task, BEFORE writing code:
 *        call spec_create(...) to produce SPEC.md (the Planner step).
 *        This is the "architect" brain — components, files, API, tests.
 *   2. Then switch to Executor mode: read spec_show() and implement
 *      files one at a time in dependency order (spec.nextFiles()),
 *      marking each file IMPLEMENTED -> VERIFIED as you go.
 *   3. Do not declare done until spec_status().canFinish === true
 *      (every non-skipped file implemented + verified, tests pass).
 *
 *   spec_create        create the PRD (Planner output)
 *   spec_show          view current spec summary
 *   spec_next_files    next files that are ready to implement (deps satisfied)
 *   spec_file_started  mark a file in_progress
 *   spec_file_done     mark a file IMPLEMENTED
 *   spec_file_verified mark a file VERIFIED (tests/verification passed)
 *   spec_test_passed   mark a test VERIFIED
 *   spec_status        rollup: counts, next files, canFinish?
 *
 * Pure JavaScript (ES modules).
 */

import { Spec, SpecStatus, getDefaultSpec } from '../planning/spec.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('tools:spec');

/**
 * @param {Object} [opts]
 * @param {Spec} [opts.spec]
 * @param {string} [opts.rootDir]
 * @returns {Array<import('./registry.js').ToolDefinition>}
 */
export function createSpecTools(opts = {}) {
  const spec = opts.spec || getDefaultSpec(opts.rootDir);

  async function ensureLoaded() {
    if (!spec._loaded) await spec.load();
  }

  return [
    {
      name: 'spec_create',
      description: [
        'PLANNER STEP (call BEFORE any code writes on multi-file projects).',
        'Create SPEC.md — a full PRD with components, the complete list of files',
        '(in dependency order), data model, API surface, tests, dependencies,',
        'env vars, and concrete acceptance criteria. Every field should be',
        'specific: file paths, function signatures, expected behaviors.',
        'Once written, switch to executor mode and implement file-by-file.',
      ].join(' '),
      parameters: {
        goal: { type: 'string', description: 'One-paragraph restatement of what the finished project must do', required: true },
        components: {
          type: 'array',
          description: 'Logical components/modules: [{id?, name, description}]',
        },
        files: {
          type: 'array',
          description: [
            'Concrete files to create, in dependency order: [{id?, path, purpose,',
            'exports?: string[], dependsOn?: string[]}]. List EVERY file needed.',
            'Includes source files, test files, config, README, etc.',
          ].join(' '),
          required: true,
        },
        dataModel: { type: 'array', description: '[{name, shape, notes}]' },
        api: { type: 'array', description: '[{name, signature, description, file}]' },
        tests: { type: 'array', description: '[{id?, target, type, command}]' },
        dependencies: { type: 'array', description: '[{name, version?, purpose}]' },
        envVars: { type: 'array', description: '[{name, purpose, default?, required?}]' },
        acceptance: { type: 'array', description: 'Concrete pass/fail criteria (list of strings)' },
        notes: { type: 'string' },
      },
      handler: async (params) => {
        await ensureLoaded();
        log.info('spec_create', { goal: (params.goal || '').slice(0, 80), files: (params.files || []).length });
        return spec.create(params);
      },
    },
    {
      name: 'spec_show',
      description: 'View the current spec (goal, file list, statuses). Call this before each file you implement.',
      parameters: {},
      handler: async () => {
        await ensureLoaded();
        if (!spec.exists()) return { ok: false, error: 'No spec exists yet. Call spec_create first (Planner step is mandatory before coding).' };
        return spec.summary();
      },
    },
    {
      name: 'spec_next_files',
      description: 'Show files whose dependencies are satisfied and are ready to implement next.',
      parameters: {},
      handler: async () => {
        await ensureLoaded();
        if (!spec.exists()) return { ok: false, error: 'No spec exists yet.' };
        return { nextFiles: spec.nextFiles(), canFinish: spec.canFinish() };
      },
    },
    {
      name: 'spec_file_started',
      description: 'Mark a file as in_progress (you are actively writing it now).',
      parameters: {
        file: { type: 'string', description: 'File id or path', required: true },
      },
      handler: async ({ file }) => {
        await ensureLoaded();
        return spec.updateFile(file, { status: SpecStatus.IN_PROGRESS });
      },
    },
    {
      name: 'spec_file_done',
      description: 'Mark a file IMPLEMENTED (just wrote it, not yet verified).',
      parameters: {
        file: { type: 'string', required: true },
      },
      handler: async ({ file }) => {
        await ensureLoaded();
        return spec.updateFile(file, { status: SpecStatus.IMPLEMENTED });
      },
    },
    {
      name: 'spec_file_verified',
      description: 'Mark a file VERIFIED (syntax/imports/tests for that file passed).',
      parameters: {
        file: { type: 'string', required: true },
      },
      handler: async ({ file }) => {
        await ensureLoaded();
        return spec.updateFile(file, { status: SpecStatus.VERIFIED });
      },
    },
    {
      name: 'spec_test_passed',
      description: 'Record that a test (from spec.tests) passed.',
      parameters: {
        testId: { type: 'string', required: true, description: 'Test id (e.g. "test_1")' },
      },
      handler: async ({ testId }) => {
        await ensureLoaded();
        const t = spec.tests.find((x) => x.id === testId);
        if (!t) throw new Error(`Test id "${testId}" not found in spec.`);
        t.status = SpecStatus.VERIFIED;
        spec.updatedAt = new Date().toISOString();
        if (spec.autoSave) await spec.save();
        return spec.summary();
      },
    },
    {
      name: 'spec_status',
      description: 'Rollup: progress %, files done/remaining, next up, and canFinish?',
      parameters: {},
      handler: async () => {
        await ensureLoaded();
        if (!spec.exists()) return { ok: false, error: 'No spec exists yet.' };
        const fin = spec.canFinish();
        return {
          summary: spec.summary(),
          canFinish: fin.ok,
          blocking: fin.ok ? [] : { files: fin.undoneFiles, tests: fin.undoneTests, nextFiles: fin.nextFiles },
        };
      },
    },
  ];
}
