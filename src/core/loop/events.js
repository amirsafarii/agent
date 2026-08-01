/**
 * loop/events.js — loop events, termination reasons, action types
 * -----------------------------------------------
 * The fixed vocabularies of the agent loop, kept in one tiny dependency-free
 * module so every other loop module (agent-loop, state-machine, tests, UIs)
 * imports the exact same constants:
 *
 *   LoopEvents        every event AgentLoop can emit via onEvent(event, payload)
 *   TerminationReason every reason a run() can end (never free-text)
 *   ActionType        the Action `type` values a reasoner is allowed to return
 *
 * Pure JavaScript (ES modules).
 */

/** Every event AgentLoop can emit via the `onEvent(event, payload)` hook. */
export const LoopEvents = Object.freeze({
  STEP_START: 'step_start',
  THINK: 'think',
  ACT: 'act',
  TOOL_RETRY: 'tool_retry',
  OBSERVE: 'observe',
  FINAL: 'final',
  NEED_CLARIFICATION: 'need_clarification',
  ERROR: 'error',
  MAX_STEPS: 'max_steps_reached',
  TASK_TIMEOUT: 'task_timeout',
  MAX_TOKENS: 'max_tokens_exceeded',
  STUCK_LOOP: 'stuck_loop_detected',
  TOOL_FAILURE_EXHAUSTED: 'tool_failure_exhausted',
  PAUSED: 'paused',
  RESUMED: 'resumed',
  CHECKPOINT_CREATED: 'checkpoint_created',
  STATE_CHANGE: 'state_change',
  TOOL_APPROVAL_REQUESTED: 'tool_approval_requested',
  TOOL_APPROVAL_GRANTED: 'tool_approval_granted',
  TOOL_APPROVAL_REJECTED: 'tool_approval_rejected',
  LIFECYCLE_CREATED: 'lifecycle_created',
  LIFECYCLE_FAILED: 'lifecycle_failed',
  TOOL_OVERUSE: 'tool_overuse',
  SIMILAR_CALL: 'similar_call',
  BUDGET_EXTENDED: 'budget_extended',
  EVALUATE: 'evaluate',
  BUDGET_EXCEEDED: 'budget_exceeded',
});

/**
 * Fixed, exhaustive set of reasons a run() can end. Every terminal return
 * carries exactly one of these in `reason` — never a free-text guess.
 */
export const TerminationReason = Object.freeze({
  FINAL_ANSWER: 'final_answer',
  NEED_CLARIFICATION: 'need_clarification',
  MAX_STEPS: 'max_steps_reached',
  TASK_TIMEOUT: 'task_timeout',
  MAX_TOKENS: 'max_tokens_exceeded',
  STUCK_LOOP: 'stuck_loop_detected',
  TOOL_FAILURE_EXHAUSTED: 'tool_failure_exhausted',
  TOOL_OVERUSE: 'tool_overuse',
  ABORTED: 'aborted_by_signal',
  THINK_ERROR: 'think_phase_error',
  INVALID_ACTION: 'invalid_action',
  BUDGET_EXCEEDED: 'budget_exceeded',
  PAUSED: 'paused_by_request',
  AWAITING_TOOL_APPROVAL: 'awaiting_tool_approval',
});

/** Fixed set of Action `type` values a reasoner is allowed to return. */
export const ActionType = Object.freeze({
  TOOL_CALL: 'tool_call',
  FINAL: 'final',
  NEED_CLARIFICATION: 'need_clarification',
});
