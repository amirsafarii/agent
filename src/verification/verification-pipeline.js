/**
 * src/verification/verification-pipeline.js — Verification Pipeline
 * --------------------------------------------------------------------
 * Executes sequential or parallel verification steps across file, command,
 * and JSON validators, producing an aggregate verification audit report.
 *
 * Pure JavaScript (ES modules).
 */

import { validateFile, validateCommand, validateJson } from './validators.js';
import { createLogger } from '../logger.js';

const log = createLogger('verification:pipeline');

export class VerificationPipeline {
  /**
   * @param {Object} [opts]
   * @param {string} [opts.rootDir] sandbox root directory
   */
  constructor(opts = {}) {
    this.rootDir = opts.rootDir || process.cwd();
    this.stages = [];
  }

  /**
   * Add a validation stage to the pipeline.
   * @param {Object} stageConfig
   */
  addStage(stageConfig) {
    if (!stageConfig || typeof stageConfig !== 'object') {
      throw new Error('Stage config must be an object.');
    }
    this.stages.push(stageConfig);
    return this;
  }

  /**
   * Run all pipeline stages.
   * @param {Object} [opts]
   * @param {boolean} [opts.stopOnFirstFailure=false]
   * @returns {Promise<Object>} pipeline summary report
   */
  async run(opts = {}) {
    const stopOnFirstFailure = opts.stopOnFirstFailure ?? false;
    const results = [];
    let passed = 0;
    let failed = 0;

    log.info('pipeline:start', { totalStages: this.stages.length });

    for (let i = 0; i < this.stages.length; i++) {
      const stage = this.stages[i];
      let res;

      const type = stage.type || (stage.command ? 'command' : stage.path ? (stage.requiredKeys ? 'json' : 'file') : 'file');

      if (type === 'file') {
        res = await validateFile({ rootDir: this.rootDir, ...stage });
      } else if (type === 'command') {
        res = await validateCommand({ rootDir: this.rootDir, ...stage });
      } else if (type === 'json') {
        res = await validateJson({ rootDir: this.rootDir, ...stage });
      } else {
        res = { ok: false, rule: 'unknown', error: `Unknown stage type "${type}".` };
      }

      results.push({ stageIndex: i, name: stage.name || `stage-${i + 1}`, ...res });

      if (res.ok) {
        passed++;
      } else {
        failed++;
        log.warn('stage:failed', { stageIndex: i, name: stage.name, error: res.error });
        if (stopOnFirstFailure) break;
      }
    }

    const overallOk = failed === 0;
    log.info('pipeline:done', { total: this.stages.length, passed, failed, ok: overallOk });

    return {
      ok: overallOk,
      totalStages: this.stages.length,
      executedStages: results.length,
      passed,
      failed,
      results,
    };
  }
}
