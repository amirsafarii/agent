/**
 * verification/index.js — public entry for the verification module
 * -----------------------------------------------
 * One import site for everything verification-related:
 *
 *   import { VerificationEngine, VerificationPipeline, validateFile, ... } from 'src/verification/index.js';
 *
 * Implementation lives in focused sibling modules: engine.js (the
 * VerificationEngine + suite runner the verify_* tools use),
 * verification-pipeline.js (staged audit pipelines), validators.js (the
 * shared file/command/JSON check implementations).
 */
export { VerificationEngine, defaultVerificationEngine } from './engine.js';
export { VerificationPipeline } from './verification-pipeline.js';
export { validateFile, validateCommand, validateJson, assertPathInSandbox } from './validators.js';
