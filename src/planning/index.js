/**
 * planning/index.js — public entry for the planning module
 * -----------------------------------------------
 * One import site for everything planning-related:
 *
 *   import { PlanningEngine, DAG, GoalDecomposer, TaskTree, DAGExecutor } from 'src/planning/index.js';
 *
 * Implementation lives in focused sibling modules: engine.js (plan CRUD +
 * progress summaries), dag.js / dag-executor.js / goal-decomposer.js /
 * task-tree.js (dependency-graph execution model).
 */
export { PlanningEngine, defaultPlanningEngine } from './engine.js';
export { DAG } from './dag.js';
export { GoalDecomposer } from './goal-decomposer.js';
export { TaskTree, TaskNode } from './task-tree.js';
export { DAGExecutor } from './dag-executor.js';
