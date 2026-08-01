/**
 * clients/model-router.js - Configurable Model Routing
 * ----------------------------------------------------
 * Routes requests to the appropriate model based on taskType and complexity.
 */

export class ModelRouter {
  /**
   * @param {Object} [config]
   * @param {Object} [config.routes]
   * @param {string} [config.routes.simple]
   * @param {string} [config.routes.reasoning]
   * @param {string} [config.routes.coding]
   * @param {string} [config.routes.vision]
   */
  constructor(config = {}) {
    this.routes = {
      simple: config.routes?.simple || process.env.MODEL_SIMPLE || 'cheap-model',
      reasoning: config.routes?.reasoning || process.env.MODEL_REASONING || 'strong-model',
      coding: config.routes?.coding || process.env.MODEL_CODING || 'coding-model',
      vision: config.routes?.vision || process.env.MODEL_VISION || 'vision-model',
    };
  }

  /**
   * Selects the best model ID for the given task attributes.
   * @param {Object} criteria
   * @param {string} criteria.taskType - e.g. "code_repair", "vision", "simple", "reasoning"
   * @param {number} [criteria.complexity] - between 0.0 and 1.0
   * @returns {string} Model ID
   */
  select({ taskType, complexity }) {
    if (taskType === 'vision' || taskType === 'image' || taskType?.includes('vision')) {
      return this.routes.vision;
    }
    if (
      taskType === 'code' ||
      taskType?.includes('code') ||
      taskType?.includes('coding') ||
      taskType === 'code_repair'
    ) {
      return this.routes.coding;
    }
    if (
      taskType === 'reasoning' ||
      taskType === 'math' ||
      taskType?.includes('reasoning') ||
      (typeof complexity === 'number' && complexity >= 0.7)
    ) {
      return this.routes.reasoning;
    }
    return this.routes.simple;
  }
}

export default ModelRouter;
