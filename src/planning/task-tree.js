/**
 * src/planning/task-tree.js — Hierarchical Task Tree
 * ---------------------------------------------------
 * Represents goals and subgoals as a parent-child hierarchical tree.
 *
 * Pure JavaScript (ES modules).
 */

import { createLogger } from '../logger.js';

const log = createLogger('planning:task-tree');

export class TaskNode {
  constructor({ id, title, description = '', status = 'pending' }) {
    this.id = String(id);
    this.title = String(title);
    this.description = String(description);
    this.status = status; // 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped'
    this.children = [];
    this.parentId = null;
  }
}

export class TaskTree {
  constructor(rootTitle = 'Root Goal') {
    this.root = new TaskNode({ id: 'root', title: rootTitle });
    /** @type {Map<string, TaskNode>} */
    this.nodes = new Map();
    this.nodes.set('root', this.root);
  }

  /**
   * Add a task to the task tree.
   * @param {Object} taskData
   * @param {string} [parentId='root']
   * @returns {TaskNode}
   */
  addTask(taskData, parentId = 'root') {
    const node = new TaskNode(taskData);
    const parent = this.nodes.get(String(parentId)) || this.root;

    node.parentId = parent.id;
    parent.children.push(node);
    this.nodes.set(node.id, node);

    log.info('addTask', { id: node.id, title: node.title, parentId: parent.id });
    return node;
  }

  /**
   * Get a node by ID.
   * @param {string} id
   * @returns {TaskNode|null}
   */
  getNode(id) {
    return this.nodes.get(String(id)) || null;
  }

  /**
   * Update status of a node and bubble completion state if applicable.
   * @param {string} id
   * @param {string} status
   */
  updateStatus(id, status) {
    const node = this.getNode(id);
    if (!node) return null;

    node.status = status;

    // Check parent auto-update
    if (node.parentId && node.parentId !== 'root') {
      const parent = this.getNode(node.parentId);
      if (parent && parent.children.length > 0) {
        const allCompleted = parent.children.every((c) => ['completed', 'skipped'].includes(c.status));
        if (allCompleted) parent.status = 'completed';
      }
    }

    return node;
  }

  /**
   * Format hierarchical view of task tree.
   * @returns {Object} tree summary
   */
  toTreeObject(node = this.root) {
    return {
      id: node.id,
      title: node.title,
      status: node.status,
      children: node.children.map((child) => this.toTreeObject(child)),
    };
  }
}
