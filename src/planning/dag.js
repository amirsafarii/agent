/**
 * src/planning/dag.js — Directed Acyclic Graph (DAG) for Task Dependencies
 * -------------------------------------------------------------------------
 * Manages task nodes and dependency edges, ensuring cycle-free execution ordering.
 *
 * Pure JavaScript (ES modules).
 */

import { createLogger } from '../core/logger.js';

const log = createLogger('planning:dag');

export class DAG {
  constructor() {
    /** @type {Map<string, { id: string, data: Object }>} */
    this.nodes = new Map();
    /** @type {Map<string, Set<string>>} incoming edges: node -> set of parent dependency node ids */
    this.inEdges = new Map();
    /** @type {Map<string, Set<string>>} outgoing edges: node -> set of child dependent node ids */
    this.outEdges = new Map();
  }

  /**
   * Add a node to the DAG.
   * @param {string} id
   * @param {Object} [data={}]
   */
  addNode(id, data = {}) {
    const strId = String(id);
    if (!this.nodes.has(strId)) {
      this.nodes.set(strId, { id: strId, data });
      this.inEdges.set(strId, new Set());
      this.outEdges.set(strId, new Set());
    } else {
      this.nodes.get(strId).data = { ...this.nodes.get(strId).data, ...data };
    }
    return strId;
  }

  /**
   * Add a dependency edge: `parentId` must complete before `childId`.
   * @param {string} parentId dependency task
   * @param {string} childId dependent task
   */
  addEdge(parentId, childId) {
    const parent = String(parentId);
    const child = String(childId);

    if (parent === child) {
      throw new Error(`Self-dependency cycle detected on node "${parent}".`);
    }

    this.addNode(parent);
    this.addNode(child);

    this.outEdges.get(parent).add(child);
    this.inEdges.get(child).add(parent);

    if (this.hasCycle()) {
      // Revert edge
      this.outEdges.get(parent).delete(child);
      this.inEdges.get(child).delete(parent);
      throw new Error(`Adding edge from "${parent}" to "${child}" introduces a cycle in the DAG.`);
    }
  }

  /**
   * Check if DAG contains cycles using Kahn's algorithm.
   * @returns {boolean}
   */
  hasCycle() {
    const inDegree = new Map();
    for (const [id, parents] of this.inEdges.entries()) {
      inDegree.set(id, parents.size);
    }

    const queue = [];
    for (const [id, deg] of inDegree.entries()) {
      if (deg === 0) queue.push(id);
    }

    let visited = 0;
    while (queue.length > 0) {
      const curr = queue.shift();
      visited++;

      for (const child of this.outEdges.get(curr)) {
        const newDeg = inDegree.get(child) - 1;
        inDegree.set(child, newDeg);
        if (newDeg === 0) queue.push(child);
      }
    }

    return visited !== this.nodes.size;
  }

  /**
   * Get topological sort of node ids.
   * @returns {string[]} sorted node ids
   */
  topologicalSort() {
    if (this.hasCycle()) {
      throw new Error('Cannot perform topological sort on a DAG with cycles.');
    }

    const inDegree = new Map();
    for (const [id, parents] of this.inEdges.entries()) {
      inDegree.set(id, parents.size);
    }

    const queue = [];
    for (const [id, deg] of inDegree.entries()) {
      if (deg === 0) queue.push(id);
    }

    const sorted = [];
    while (queue.length > 0) {
      const curr = queue.shift();
      sorted.push(curr);

      for (const child of this.outEdges.get(curr)) {
        const newDeg = inDegree.get(child) - 1;
        inDegree.set(child, newDeg);
        if (newDeg === 0) queue.push(child);
      }
    }

    return sorted;
  }

  /**
   * Get nodes whose dependencies are all satisfied by `completedIds`.
   * @param {Set<string>|string[]} completed
   * @returns {Array<{ id: string, data: Object }>}
   */
  getReadyNodes(completed) {
    const completedSet = new Set(Array.from(completed).map(String));
    const ready = [];

    for (const [id, node] of this.nodes.entries()) {
      if (completedSet.has(id)) continue;

      const parents = this.inEdges.get(id);
      let allParentsDone = true;
      for (const p of parents) {
        if (!completedSet.has(p)) {
          allParentsDone = false;
          break;
        }
      }

      if (allParentsDone) {
        ready.push(node);
      }
    }

    return ready;
  }

  getNode(id) {
    return this.nodes.get(String(id)) || null;
  }

  serialize() {
    const nodes = [];
    for (const [id, node] of this.nodes.entries()) {
      nodes.push({ id, data: node.data, deps: Array.from(this.inEdges.get(id)) });
    }
    return { nodes };
  }

  static deserialize(data) {
    const dag = new DAG();
    if (data && Array.isArray(data.nodes)) {
      for (const item of data.nodes) {
        dag.addNode(item.id, item.data);
      }
      for (const item of data.nodes) {
        if (Array.isArray(item.deps)) {
          for (const dep of item.deps) {
            dag.addEdge(dep, item.id);
          }
        }
      }
    }
    return dag;
  }
}
