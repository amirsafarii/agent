/**
 * loop/index.js — public entry for the agent-loop module
 * -----------------------------------------------
 * One import site for everything the think → act → observe loop exposes:
 *
 *   import { AgentLoop, LoopState, LoopEvents, TerminationReason, ActionType,
 *            LoopError, LoopStateMachine, StopConditionEngine } from 'src/core/loop/index.js';
 *
 * Implementation lives in focused sibling modules: agent-loop.js (the
 * orchestrator), state-machine.js, stop-conditions.js, events.js, errors.js,
 * compression.js.
 */
export { AgentLoop } from './agent-loop.js';
export { LoopEvents, TerminationReason, ActionType } from './events.js';
export { LoopError } from './errors.js';
export { LoopState, LoopStateMachine, statusToLoopState } from './state-machine.js';
export { StopConditionEngine } from './stop-conditions.js';
export { defaultCompressToolResult } from './compression.js';

export { AgentLoop as default } from './agent-loop.js';
