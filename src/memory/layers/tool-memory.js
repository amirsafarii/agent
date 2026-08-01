// ── Tool Memory ──
// Per-tool execution history: recent calls, latency, success rate. Backs
// tool health monitoring and lets the orchestrator prefer tools with a
// track record for a given kind of task.

import { PulseStore } from '../pulse-store.js';

const TOOL_MEMORY_TTL = 14 * 24 * 3600; // 14 days

export class ToolMemory {
  constructor({ redisConnection }) {
    this.store = new PulseStore({ redisConnection, namespace: 'mem:tool', defaultTtl: TOOL_MEMORY_TTL, persist: false });
  }

  async recordExecution({ toolName, success, durationMs, error }) {
    return this.store.store({ type: 'execution', namespaceKey: toolName, toolName, success, durationMs, error: error ?? null });
  }

  async getStats(toolName, sampleSize = 100) {
    const executions = await this.store.search({ namespaceKey: toolName, type: 'execution', limit: sampleSize });
    if (executions.length === 0) return { toolName, samples: 0, successRate: null, avgDurationMs: null };

    const successes = executions.filter(e => e.success).length;
    const avgDurationMs = executions.reduce((sum, e) => sum + (e.durationMs ?? 0), 0) / executions.length;

    return {
      toolName,
      samples: executions.length,
      successRate: successes / executions.length,
      avgDurationMs: Math.round(avgDurationMs),
      lastError: executions.find(e => !e.success)?.error ?? null,
    };
  }
}
