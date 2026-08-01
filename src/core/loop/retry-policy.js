/**
 * core/loop/retry-policy.js - Configurable Retry Policies
 * --------------------------------------------------------
 * Implements RetryPolicy class with support for backoff, jitter, retryable errors,
 * and tool-specific default retry behaviors.
 */

export class RetryPolicy {
  /**
   * @param {Object} [options]
   * @param {number} [options.maxAttempts=3] - Total attempts (including the first try)
   * @param {string[]} [options.retryableErrors] - List of error codes that are retryable
   * @param {string} [options.backoff='exponential'] - Backoff strategy ('exponential', 'linear', 'fixed')
   * @param {boolean} [options.jitter=true] - Whether to apply random jitter
   * @param {number} [options.initialDelayMs=250] - Initial delay in milliseconds
   * @param {number} [options.maxDelayMs=5000] - Maximum delay in milliseconds
   */
  constructor(options = {}) {
    this.maxAttempts = options.maxAttempts !== undefined ? options.maxAttempts : (options.retries !== undefined ? options.retries + 1 : 3);
    this.retries = this.maxAttempts - 1;
    this.retryableErrors = options.retryableErrors || options.retryableCodes || ['TOOL_EXECUTION_ERROR', 'EXECUTION_ERROR'];
    this.backoff = options.backoff || 'exponential';
    this.jitter = options.jitter !== undefined ? options.jitter : false;
    this.initialDelayMs = options.initialDelayMs || options.backoffMs || 250;
    this.maxDelayMs = options.maxDelayMs || options.maxDelay || 5000;
  }

  /**
   * Decides whether to retry based on attempt count and error code.
   * @param {number} attempt - Current completed attempt count (e.g. 1 on first failure)
   * @param {string} code - Error code
   * @returns {boolean}
   */
  shouldRetry(attempt, code) {
    if (attempt >= this.maxAttempts) {
      return false;
    }
    return this.retryableErrors.includes(code);
  }

  /**
   * Computes retry delay based on backoff and jitter.
   * @param {number} attempt - Attempt count (e.g. 1 before first retry delay)
   * @returns {number} Delay in milliseconds
   */
  getDelay(attempt) {
    let delay = this.initialDelayMs;
    if (this.backoff === 'exponential') {
      delay = this.initialDelayMs * Math.pow(2, attempt - 1);
    } else if (this.backoff === 'linear') {
      delay = this.initialDelayMs * attempt;
    }

    if (delay > this.maxDelayMs) {
      delay = this.maxDelayMs;
    }

    if (this.jitter) {
      delay = Math.random() * delay;
    }

    return Math.max(0, Math.round(delay));
  }
}

// Default policies for specific tools
export const DEFAULT_TOOL_POLICIES = {
  web_search: new RetryPolicy({
    maxAttempts: 3,
    retryableErrors: ['TOOL_EXECUTION_ERROR', 'EXECUTION_ERROR', 'HTTP_ERROR', 'REQUEST_FAILED', 'TOOL_TIMEOUT'],
  }),
  npm: new RetryPolicy({
    maxAttempts: 2,
    retryableErrors: ['TOOL_EXECUTION_ERROR', 'EXECUTION_ERROR'],
  }),
  package_install: new RetryPolicy({
    maxAttempts: 2,
    retryableErrors: ['TOOL_EXECUTION_ERROR', 'EXECUTION_ERROR'],
  }),
  delete_file: new RetryPolicy({
    maxAttempts: 1, // never retry
    retryableErrors: [],
  }),
  payment: new RetryPolicy({
    maxAttempts: 1, // never retry automatic
    retryableErrors: [],
  }),
};

/**
 * Resolves a RetryPolicy for a given tool.
 * @param {string} toolName
 * @param {Object} [customPolicies] - Dict of custom tool-specific policies/configs
 * @param {Object|RetryPolicy} [defaultGlobalPolicy] - Falling back to this if no tool policy is found
 * @returns {RetryPolicy}
 */
export function getRetryPolicyForTool(toolName, customPolicies = {}, defaultGlobalPolicy = null) {
  if (customPolicies && customPolicies[toolName]) {
    const p = customPolicies[toolName];
    return p instanceof RetryPolicy ? p : new RetryPolicy(p);
  }

  if (DEFAULT_TOOL_POLICIES[toolName]) {
    return DEFAULT_TOOL_POLICIES[toolName];
  }

  if (defaultGlobalPolicy) {
    return defaultGlobalPolicy instanceof RetryPolicy ? defaultGlobalPolicy : new RetryPolicy(defaultGlobalPolicy);
  }

  return new RetryPolicy();
}
