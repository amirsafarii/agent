// ── Project Memory ──
// Durable, project-scoped context: goals, architecture decisions, known
// constraints, file-structure summaries. Rebuilt into agent context
// whenever a task is scoped to a project, so multi-day work on the same
// codebase doesn't re-explain itself every run.
//
// Hierarchical: facts and decisions are scoped `project > module > key`,
// not flat per-project. A project-wide fact uses `module: null` (or
// omitted); a module-scoped one (e.g. "module:memory uses Redis") is
// stored and retrievable independently, and `getSummary()` returns a
// nested `{ _root: {...}, modules: { memory: {...}, api: {...} } }` shape
// instead of one flat bag where an "api" decision and a "memory"
// constraint sit indistinguishably side by side.

import { PulseStore } from '../pulse-store.js';

export class ProjectMemory {
  constructor({ redisConnection }) {
    this.store = new PulseStore({ redisConnection, namespace: 'mem:project', defaultTtl: 0, persist: true });
  }

  _factNamespaceKey(projectId, module, key) {
    return module ? `${projectId}:${module}:${key}` : `${projectId}:${key}`;
  }

  async setFact(projectId, key, value, { module = null } = {}) {
    const namespaceKey = this._factNamespaceKey(projectId, module, key);
    const existing = await this.store.search({ projectId, namespaceKey, limit: 1 });
    if (existing[0]) return this.store.update(existing[0].id, { value });
    return this.store.store({ type: 'project_fact', projectId, module, namespaceKey, key, value, persist: true });
  }

  /** Flat list for back-compat callers; prefer getSummary() for the hierarchical view. */
  async getSummary(projectId) {
    const facts = await this.store.search({ projectId, type: 'project_fact', limit: 500 });
    return facts.reduce((acc, f) => { acc[f.key] = f.value; return acc; }, {});
  }

  /** `{ root: { key: value }, modules: { moduleName: { key: value } } }` */
  async getHierarchicalSummary(projectId) {
    const facts = await this.store.search({ projectId, type: 'project_fact', limit: 500 });
    const root = {};
    const modules = {};
    for (const f of facts) {
      if (f.module) {
        modules[f.module] = modules[f.module] ?? {};
        modules[f.module][f.key] = f.value;
      } else {
        root[f.key] = f.value;
      }
    }
    return { root, modules };
  }

  async recordDecision(projectId, decision, rationale, { module = null } = {}) {
    return this.store.store({ type: 'decision', projectId, module, decision, rationale, persist: true });
  }

  async getDecisions(projectId, { module, limit = 50 } = {}) {
    return this.store.search({ projectId, type: 'decision', module, limit });
  }

  /** A standing constraint the agent must never silently violate (e.g. "no TypeScript"). */
  async recordConstraint(projectId, constraint, { module = null } = {}) {
    return this.store.store({ type: 'constraint', projectId, module, constraint, persist: true });
  }

  async getConstraints(projectId, { module, limit = 100 } = {}) {
    return this.store.search({ projectId, type: 'constraint', module, limit });
  }
}
