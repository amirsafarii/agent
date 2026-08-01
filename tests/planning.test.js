import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlanningEngine, DAG, GoalDecomposer, TaskTree, DAGExecutor } from '../src/planning/index.js';
import { createPlanningTools } from '../src/tools/planning.js';
import { ToolRegistry } from '../src/tools/index.js';

test('DAG: cycle detection, topological sort, ready nodes', () => {
  const dag = new DAG();
  dag.addNode('1', { title: 'First' });
  dag.addNode('2', { title: 'Second' });
  dag.addNode('3', { title: 'Third' });

  dag.addEdge('1', '2');
  dag.addEdge('2', '3');

  assert.equal(dag.hasCycle(), false);
  assert.deepEqual(dag.topologicalSort(), ['1', '2', '3']);

  const initialReady = dag.getReadyNodes([]);
  assert.equal(initialReady.length, 1);
  assert.equal(initialReady[0].id, '1');

  const afterFirstReady = dag.getReadyNodes(['1']);
  assert.equal(afterFirstReady.length, 1);
  assert.equal(afterFirstReady[0].id, '2');

  assert.throws(() => dag.addEdge('3', '1'), /cycle/i);
});

test('GoalDecomposer & TaskTree: decompose goal into hierarchy & DAG', () => {
  const decomposer = new GoalDecomposer();
  const decomposed = decomposer.decompose({
    title: 'Deploy Service',
    tasks: [
      { id: '1', title: 'Write Dockerfile' },
      { id: '2', title: 'Build Image', deps: ['1'] },
      { id: '3', title: 'Push Image', deps: ['2'] },
    ],
  });

  assert.equal(decomposed.goalTitle, 'Deploy Service');
  assert.equal(decomposed.dag.nodes.size, 3);
  assert.equal(decomposed.taskTree.nodes.size, 4); // root + 3 tasks

  const treeObj = decomposed.taskTree.toTreeObject();
  assert.equal(treeObj.children.length, 3);
});

test('DAGExecutor: execute tasks in topological order', async () => {
  const dag = new DAG();
  dag.addEdge('A', 'B');
  dag.addEdge('B', 'C');

  const executedOrder = [];
  const executor = new DAGExecutor({
    dag,
    taskRunner: async (node) => {
      executedOrder.push(node.id);
      return { ok: true };
    },
  });

  const res = await executor.executeAll();
  assert.equal(res.ok, true);
  assert.deepEqual(executedOrder, ['A', 'B', 'C']);
});

test('PlanningEngine: create, update, progress, and next actionable tasks', () => {
  const engine = new PlanningEngine();

  const plan = engine.createPlan({
    title: 'Build Feature X',
    description: 'Implement feature X end-to-end',
    tasks: [
      { id: '1', title: 'Setup DB schema', status: 'pending' },
      { id: '2', title: 'Implement API endpoint', deps: ['1'], status: 'pending' },
      { id: '3', title: 'Write tests', deps: ['2'], status: 'pending' },
    ],
  });

  assert.ok(plan.planId);
  assert.equal(plan.title, 'Build Feature X');
  assert.equal(plan.progress.total, 3);
  assert.equal(plan.progress.completed, 0);
  assert.equal(plan.progress.percentage, 0);

  // Next actionable task should only be task '1' because tasks '2' and '3' depend on incomplete tasks
  assert.equal(plan.nextActionableTasks.length, 1);
  assert.equal(plan.nextActionableTasks[0].id, '1');

  // Complete task 1
  const updated1 = engine.updateTask({ taskId: '1', status: 'completed', notes: 'Schema migrated.' });
  assert.equal(updated1.progress.completed, 1);
  assert.equal(updated1.progress.percentage, 33);
  assert.equal(updated1.nextActionableTasks.length, 1);
  assert.equal(updated1.nextActionableTasks[0].id, '2');

  // Complete task 2 and 3
  engine.updateTask({ taskId: '2', status: 'completed' });
  const finalState = engine.updateTask({ taskId: '3', status: 'completed' });
  assert.equal(finalState.progress.completed, 3);
  assert.equal(finalState.progress.percentage, 100);
});

test('PlanningEngine: add subtasks dynamically', () => {
  const engine = new PlanningEngine();
  engine.createPlan({
    title: 'Refactor Codebase',
    tasks: [{ id: '1', title: 'Audit codebase' }],
  });

  const updated = engine.addTasks({
    tasks: [
      { id: '2', title: 'Extract utils', deps: ['1'] },
      { id: '3', title: 'Add docs', deps: ['2'] },
    ],
  });

  assert.equal(updated.progress.total, 3);
  assert.equal(updated.tasks.length, 3);
});

test('Planning tools: ToolRegistry integration and execution', async () => {
  const registry = new ToolRegistry();
  const engine = new PlanningEngine();
  const tools = createPlanningTools({ engine });

  for (const tool of tools) {
    registry.register(tool);
  }

  assert.equal(registry.has('plan_create'), true);
  assert.equal(registry.has('plan_update_task'), true);
  assert.equal(registry.has('plan_get'), true);
  assert.equal(registry.has('plan_add_tasks'), true);

  // Execute plan_create
  const createRes = await registry.execute('plan_create', {
    title: 'Tool Integration Test',
    tasks: [
      { id: '1', title: 'Step 1' },
      { id: '2', title: 'Step 2', deps: ['1'] },
    ],
  });

  assert.equal(createRes.ok, true);
  assert.equal(createRes.data.title, 'Tool Integration Test');

  // Execute plan_update_task
  const updateRes = await registry.execute('plan_update_task', {
    taskId: '1',
    status: 'completed',
    notes: 'Done step 1',
  });

  assert.equal(updateRes.ok, true);
  assert.equal(updateRes.data.progress.completed, 1);

  // Execute plan_get
  const getRes = await registry.execute('plan_get', {});
  assert.equal(getRes.ok, true);
  assert.equal(getRes.data.progress.total, 2);

  // Execute plan_add_tasks
  const addRes = await registry.execute('plan_add_tasks', {
    tasks: [{ id: '3', title: 'Step 3' }],
  });
  assert.equal(addRes.ok, true);
  assert.equal(addRes.data.progress.total, 3);
});
