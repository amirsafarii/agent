/**
 * index.js — wire everything together
 * -----------------------------------------------
 * Builds a ready-to-run ScrappyAi agent: ContextWindow + ToolRegistry
 * (shell, read_file, write_file, web_search) + a reasoner backed by the
 * 9router client, all driven by AgentLoop.
 *
 * Usage:
 *   node src/index.js "your prompt here"
 *
 * Or import buildAgent()/createDefaultToolRegistry() to embed ScrappyAi
 * inside another program.
 *
 * Pure JavaScript (ES modules).
 */

import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { AgentLoop } from './core/loop/index.js';
import { ContextWindow } from './core/context.js';
import { createReasoner } from './core/reasoner.js';
import { runRepl } from './core/repl.js';
import { createTraceRenderer } from './core/trace.js';
import { SessionLogger, attachSessionLogger } from './core/session-logger.js';
import { createLogger } from './core/logger.js';
import { buildSystemPrompt } from './core/system-prompt.js';
import { createNineRouterClient } from './clients/9router.js';
import {
  ToolRegistry,
  createFilesystemTools,
  createShellTool, createShellSpawnTool, createShellKillTool, createShellWhichTool,
  createCodeTools,
  createPackageTools,
  createPlanningTools,
  createTodoTools,
  createSpecTools,
  createVerificationTools,
  createWebSearchTool,
  createHttpTools,
} from './tools/index.js';
import { createPreflightTool } from './tools/todo.js';
import { PlanningEngine } from './planning/index.js';
import { Spec } from './planning/spec.js';
import { VerificationEngine } from './verification/index.js';
import { TodoManager } from './core/todo-manager.js';
import { BudgetManager } from './budget/budget-manager.js';
import { createMemory } from './memory/index.js';
import { wireMemory } from './memory/integration.js';
import { resolveProfile, ApprovalManager } from './security/permissions.js';
import { createSandbox, levelFromPermissions } from './security/sandbox.js';
import { randomUUID } from 'node:crypto';

const log = createLogger('index');

// Use the production-grade system prompt from core/system-prompt.js
const DEFAULT_SYSTEM_PROMPT = buildSystemPrompt({ agentName: 'ScrappyAi' });

/** Parse SCRAPPYAI_REQUIRE_APPROVAL ("tool1,tool2" or "*") into requireApprovalFor. */
function parseApprovalEnv() {
  const raw = process.env.SCRAPPYAI_REQUIRE_APPROVAL;
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (trimmed === '*') return '*';
  return trimmed.split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Read a numeric env var with a hard default. Returns `defaultVal` if the
 * var is unset, empty, or not a finite positive number — never NaN/undefined,
 * so callers always get a real number.
 */
function readEnvInt(name, defaultVal) {
  const raw = process.env[name];
  if (raw == null || raw === '') return defaultVal;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : defaultVal;
}

/** Read a boolean env var ("true"/"false"/"1"/"0") with a default. */
function readEnvBool(name, defaultVal) {
  const raw = process.env[name];
  if (raw == null || raw === '') return defaultVal;
  const s = String(raw).trim().toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true;
  if (s === 'false' || s === '0' || s === 'no' || s === 'off' || s === '') return false;
  return defaultVal;
}

/**
 * Resolve the system prompt to use, in priority order:
 *   1. explicit `override` argument (e.g. buildAgent({ systemPrompt }))
 *   2. SCRAPPYAI_SYSTEM_PROMPT_FILE — path to a text file, read fresh each call
 *   3. SCRAPPYAI_SYSTEM_PROMPT — inline string
 *   4. DEFAULT_SYSTEM_PROMPT
 *
 * Kept as a single, simple knob: no config format to learn, just one env var
 * for a short prompt or a file path for a long one.
 * @param {string} [override]
 * @returns {string}
 */
export function loadSystemPrompt(override) {
  if (typeof override === 'string' && override.trim()) return override;

  const filePath = process.env.SCRAPPYAI_SYSTEM_PROMPT_FILE;
  if (filePath) {
    try {
      const content = readFileSync(filePath, 'utf8').trim();
      if (content) return content;
    } catch (err) {
      throw new Error(
        `SCRAPPYAI_SYSTEM_PROMPT_FILE is set to "${filePath}" but could not be read: ${err.message}`
      );
    }
  }

  const inline = process.env.SCRAPPYAI_SYSTEM_PROMPT;
  if (typeof inline === 'string' && inline.trim()) return inline;

  return DEFAULT_SYSTEM_PROMPT;
}

/**
 * Register the default tool set on a ToolRegistry:
 *   filesystem: read_file, write_file, edit_file, list_dir, search_files,
 *               make_dir, move_file, copy_file, delete_file (sandboxed)
 *   shell:      shell (exec), shell_spawn, shell_kill, shell_which
 *   code:       code_run, code_test, code_validate
 *   package:    npm, package_install, package_info
 *   web:        web_search
 * @param {Object} [opts]
 * @param {import('./tools/registry.js').ToolRegistry} [opts.registry] reuse an existing registry instead of creating one
 * @param {string} [opts.filesRoot] sandbox root for all file/shell/code/package tools,
 *        default process.env.SCRAPPYAI_FILES_ROOT || cwd
 * @param {string} [opts.shellCwd]
 * @param {string|Object} [opts.profile='developer'] permission profile
 *   (readonly | developer | autonomous | admin)
 * @param {import('./security/sandbox.js').Sandbox} [opts.sandbox]
 * @param {import('./security/permissions.js').ApprovalManager} [opts.approvals]
 * @returns {import('./tools/registry.js').ToolRegistry}
 */
export function createDefaultToolRegistry(opts = {}) {
  const filesRoot = opts.filesRoot || process.env.SCRAPPYAI_FILES_ROOT || process.cwd();
  const profile = resolveProfile(opts.profile || process.env.SCRAPPYAI_PERMISSION_PROFILE || 'developer');
  const sandbox = opts.sandbox || createSandbox({
    rootDir: filesRoot,
    level: levelFromPermissions(profile.permissions),
    allowSymlinksOutside: profile.permissions.filesystem === 'host',
  });
  const approvals = opts.approvals || new ApprovalManager();

  const registry = opts.registry || new ToolRegistry({
    profile,
    sandbox,
    filesRoot,
    approvals,
  });
  // If caller passed a pre-built registry, still align profile/sandbox.
  if (opts.registry) {
    registry.setProfile?.(profile);
    registry.sandbox = sandbox;
    registry.approvals = approvals;
  }

  const shellOpts = { cwd: opts.shellCwd || filesRoot, sandboxRoot: filesRoot };

  // filesystem suite (9 tools, incl. read_file/write_file) — realpath sandbox
  for (const def of createFilesystemTools({ rootDir: filesRoot, sandbox })) registry.register(def);

  // shell suite (4 tools)
  registry.register(createShellTool(shellOpts));
  registry.register(createShellSpawnTool(shellOpts));
  registry.register(createShellKillTool());
  registry.register(createShellWhichTool());

  // code suite (3 tools)
  for (const def of createCodeTools({ rootDir: filesRoot })) registry.register(def);

  // package suite (3 tools) — lifecycle scripts gated by sandbox level
  for (const def of createPackageTools({ rootDir: filesRoot })) registry.register(def);

  // planning suite (4 tools — legacy plan_* tools)
  for (const def of createPlanningTools({ engine: opts.planningEngine })) registry.register(def);

  // TODO checklist tools (9 tools) — only registered when a TodoManager is
  // provided (buildAgent always passes one). Standalone uses of
  // createDefaultToolRegistry({ registry }) without a manager keep the
  // original minimal tool surface.
  if (opts.todoManager) {
    for (const def of createTodoTools({ manager: opts.todoManager, rootDir: filesRoot })) registry.register(def);
  }

  // Spec / PRD tools (Planner-Executor pattern) — same opt-in policy.
  if (opts.spec) {
    for (const def of createSpecTools({ spec: opts.spec, rootDir: filesRoot })) registry.register(def);
  }

  // verification suite (4 tools)
  for (const def of createVerificationTools({ rootDir: filesRoot, engine: opts.verificationEngine })) registry.register(def);

  // verify_preflight — automatic pre-final sweep (TODO + Spec + extra checks).
  // Registered if a todoManager was provided (it is, by default, via buildAgent).
  if (opts.todoManager) {
    registry.register(createPreflightTool({
      todoManager: opts.todoManager,
      spec: opts.spec,
      verificationEngine: opts.verificationEngine,
      rootDir: filesRoot,
    }));
  }

  registry.register(createWebSearchTool());

  // HTTP / network suite (http_get, http_post, http_request) — bounded by
  // timeout, max response size, and an allowed-domains allowlist when given.
  for (const def of createHttpTools({
    timeoutMs: opts.httpTimeoutMs ?? (Number(process.env.SCRAPPYAI_HTTP_TIMEOUT_MS) || undefined),
    maxResponseSize: opts.httpMaxResponseSize ?? (Number(process.env.SCRAPPYAI_HTTP_MAX_RESPONSE_SIZE) || undefined),
    allowedDomains: opts.httpAllowedDomains ?? (process.env.SCRAPPYAI_HTTP_ALLOWED_DOMAINS
      ? process.env.SCRAPPYAI_HTTP_ALLOWED_DOMAINS.split(',').map((s) => s.trim()).filter(Boolean)
      : undefined),
  })) registry.register(def);

  return registry;
}

/**
 * Build a fully wired AgentLoop, with persistent memory attached unless
 * SCRAPPYAI_MEMORY_ENABLED=false. See memory/index.js for the "auto mode"
 * backend selection (in-process by default, Redis when SCRAPPYAI_REDIS_URL
 * is set) and memory/integration.js for exactly what gets injected/recorded
 * per turn.
 * @param {Object} [opts]
 * @param {import('./tools/registry.js').ToolRegistry} [opts.tools] defaults to createDefaultToolRegistry()
 * @param {import('./core/context.js').ContextWindow} [opts.context]
 * @param {string} [opts.systemPrompt]
 * @param {Function} [opts.onEvent]
 * @param {string} [opts.userId] defaults to SCRAPPYAI_USER_ID env or "local" — identifies whose
 *        long-term/semantic memory this agent reads and writes.
 * @param {string} [opts.sessionId] defaults to SCRAPPYAI_SESSION_ID env or a fresh generated id —
 *        scopes session (turn-by-turn) memory; a new process gets a new session by default.
 * @param {string} [opts.projectId] defaults to SCRAPPYAI_PROJECT_ID env or null — scopes project memory.
 * @param {boolean} [opts.memory] pass false to force-disable memory for this instance regardless of env.
 * @param {string|Object} [opts.profile='developer'] permission profile (readonly|developer|autonomous|admin)
 * @returns {AgentLoop}
 */
export function buildAgent(opts = {}) {
  const systemPrompt = loadSystemPrompt(opts.systemPrompt);
  const profileName = opts.profile || process.env.SCRAPPYAI_PERMISSION_PROFILE || 'developer';
  const filesRoot = opts.filesRoot || process.env.SCRAPPYAI_FILES_ROOT || process.cwd();

  // Anti-laziness managers (shared between the tool suite and the loop's
  // FINAL gate). Callers can pass their own; otherwise we construct fresh
  // ones per agent so each agent.run() session starts with a clean slate.
  const todoManager = opts.todoManager || new TodoManager({ rootDir: filesRoot });
  const spec = opts.spec || new Spec({ rootDir: filesRoot });
  const verificationEngine = opts.verificationEngine || new VerificationEngine({ rootDir: filesRoot });
  const planningEngine = opts.planningEngine || new PlanningEngine();

  const tools = opts.tools || createDefaultToolRegistry({
    profile: profileName,
    filesRoot,
    planningEngine,
    verificationEngine,
    todoManager,
    spec,
  });
  const context =
    opts.context ||
    new ContextWindow({
      maxTokens: readEnvInt('SCRAPPYAI_MAX_TOKENS', 16000),
      systemPrompt,
    });

  const client = createNineRouterClient();
  const reasoner = createReasoner({
    client,
    systemPrompt,
    stream: opts.stream ?? String(process.env.SCRAPPYAI_STREAM).toLowerCase() === 'true',
    onToken: opts.onToken,
    onEvent: opts.onEvent,
  });

  // Resolved once, shared by memory scoping, the per-session log folder, and
  // this loop's CheckpointManager — so all three line up under the same id.
  const sessionId = opts.sessionId || process.env.SCRAPPYAI_SESSION_ID || `session_${Date.now()}_${randomUUID().slice(0, 8)}`;

  // Step budget: SCRAPPYAI_MAX_STEPS sets the base; SCRAPPYAI_ADAPTIVE_MAX_STEPS
  // (default ON) lets the loop grow the budget up to SCRAPPYAI_MAX_STEPS_MAX
  // while the run keeps producing progress, so complex tasks aren't cut short
  // by a fixed ceiling — but infinite loops still hit a hard cap.
  const maxSteps = readEnvInt('SCRAPPYAI_MAX_STEPS', 15);
  const adaptiveEnabled = readEnvBool('SCRAPPYAI_ADAPTIVE_MAX_STEPS', true);
  const adaptiveMax = readEnvInt('SCRAPPYAI_MAX_STEPS_MAX', 80);
  const maxToolCallsPerTool = readEnvInt('SCRAPPYAI_MAX_TOOL_CALLS_PER_TOOL', 20);
  const maxTaskTimeoutMs = readEnvInt('SCRAPPYAI_MAX_RUNTIME_MS', 600_000);

  // Independent BudgetManager (tokens/model/tool/network/subprocess/runtime/
  // dollars) wired into the loop's stop-condition engine. Every limit has a
  // sane hard default so the agent cannot silently loop/spend forever.
  const budgetManager = opts.budgetManager
    || new BudgetManager({
        maxModelCalls: readEnvInt('SCRAPPYAI_MAX_MODEL_CALLS', 60),
        maxToolCalls: readEnvInt('SCRAPPYAI_MAX_TOOL_CALLS', 200),
        maxNetworkCalls: readEnvInt('SCRAPPYAI_MAX_NETWORK_CALLS', 30),
        maxSubprocesses: readEnvInt('SCRAPPYAI_MAX_SUBPROCESSES', 30),
        maxRuntimeMs: maxTaskTimeoutMs,
        maxTokens: readEnvInt('SCRAPPYAI_BUDGET_TOKENS', 200_000),
      });

  const agent = new AgentLoop({
    context,
    tools,
    reasoner,
    maxSteps,
    adaptiveMaxSteps: adaptiveEnabled ? { max: adaptiveMax, growthFactor: 2 } : false,
    maxToolCallsPerTool,
    budgetManager,
    onEvent: opts.onEvent,
    requireApprovalFor: opts.requireApprovalFor ?? parseApprovalEnv(),
    onToolApproval: opts.onToolApproval,
    onPlanApproval: opts.onPlanApproval,
    lifecycleHooks: opts.lifecycleHooks,
    approvals: tools.approvals,
    parallelConcurrency: opts.parallelConcurrency || readEnvInt('SCRAPPYAI_PARALLEL_CONCURRENCY', 4),
    maxTaskTimeoutMs,
    checkpointDir: opts.checkpointDir ?? (process.env.SCRAPPYAI_CHECKPOINT_DIR
      ? `${process.env.SCRAPPYAI_CHECKPOINT_DIR}/${sessionId}`
      : undefined),
    // Anti-laziness gates:
    todoManager,
    specManager: spec,
    verificationEngine,
    strictFinal: opts.strictFinal !== false && String(process.env.SCRAPPYAI_STRICT_FINAL).toLowerCase() !== 'false',
  });
  // AgentLoop already exposes .context and .reasoner; stash the resolved
  // prompt too so the REPL's /system command can display it without
  // re-deriving it from env vars.
  agent.systemPrompt = systemPrompt;
  agent.sessionId = sessionId;

  // Full-fidelity per-session debug logs (independent of console log level) —
  // opt out with SCRAPPYAI_SESSION_LOG=false.
  if (opts.sessionLog !== false && String(process.env.SCRAPPYAI_SESSION_LOG).toLowerCase() !== 'false') {
    attachSessionLogger(agent, new SessionLogger({ sessionId }));
  }

  let memoryBackend = 'disabled';
  if (opts.memory !== false) {
    const memory = createMemory({ client });
    if (memory) {
      wireMemory(agent, {
        memoryManager: memory.memoryManager,
        extractor: memory.extractor,
        userId: opts.userId || process.env.SCRAPPYAI_USER_ID || 'local',
        sessionId,
        projectId: opts.projectId || process.env.SCRAPPYAI_PROJECT_ID || null,
        onEvent: opts.onEvent,
      });
      agent.memoryBackend = memory.backend;
      memoryBackend = memory.backend;
    }
  }

  log.info('buildAgent:done', {
    toolCount: tools.list().length,
    tools: tools.list().map((t) => t.name),
    maxTokens: context.maxTokens,
    memoryBackend,
    sessionId,
    systemPromptChars: systemPrompt.length,
  });

  return agent;
}

function buildAgentOrExit(opts = {}) {
  // Claude-Code-style trace on stderr: Thought / Tool Call / Observation /
  // Final Answer, colored, instead of raw event JSON — stdout stays reserved
  // for the actual final answer (see main()) so piping/scripting still works.
  const trace = createTraceRenderer({ output: process.stderr });
  try {
    return buildAgent({ onEvent: trace.onEvent, ...opts });
  } catch (err) {
    log.error('buildAgent:failed', { error: err.message });
    console.error(`Failed to build agent: ${err.message}`);
    console.error('Check your .env against .env.example (NINEROUTER_BASE_URL / NINEROUTER_API_KEY / NINEROUTER_MODEL).');
    process.exitCode = 1;
    return null;
  }
}

/** Whether SCRAPPYAI_STREAM=true (stream final answers to stdout as they are generated). */
function streamingEnabled() {
  return String(process.env.SCRAPPYAI_STREAM).toLowerCase() === 'true';
}

async function main() {
  const prompt = process.argv.slice(2).join(' ').trim();
  const streaming = streamingEnabled();
  log.info('main:start', { mode: prompt ? 'single-shot' : 'repl', streaming, promptChars: prompt.length });

  // No prompt on argv -> multi-turn REPL: same agent, same ContextWindow and
  // reasoner history for every line typed, so memory carries between turns.
  // The live token sink is attached by runRepl() itself (via
  // reasoner.setTokenSink), so it can track per-turn streaming state.
  if (!prompt) {
    const agent = buildAgentOrExit(streaming ? { stream: true } : {});
    if (!agent) return;
    await runRepl({
      agent,
      systemPrompt: agent.systemPrompt,
      onToken: streaming ? (t) => process.stdout.write(t) : undefined,
    });
    return;
  }

  // Prompt given on argv -> single-shot mode (unchanged, scriptable/CI-friendly).
  // With streaming on, the final answer prints token-by-token as the model
  // generates it; the trailing newline is emitted once the run completes.
  let streamed = false;
  const agent = buildAgentOrExit(
    streaming ? { stream: true, onToken: (t) => { streamed = true; process.stdout.write(t); } } : {}
  );
  if (!agent) return;

  const outcome = await agent.run(prompt);
  log.info('main:done', { status: outcome.status, steps: outcome.steps });
  if (outcome.status === 'final') {
    if (streamed) {
      process.stdout.write('\n');
    } else {
      console.log(outcome.content);
    }
  } else {
    console.error(`[loop ended: ${outcome.status}]`, outcome.question || outcome.error || '');
    process.exitCode = 1;
  }
}

// Robust "am I the entrypoint?" check: process.argv[1] can be relative
// ("src/index.js") or absolute, while import.meta.url is always a file://
// URL. Resolving both to absolute paths avoids the mismatch that silently
// skipped main() (and left a piped stdin dangling with nothing reading it)
// whenever this file was invoked as anything other than an absolute path.
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  main();
}

export {
  createPlanningTools,
  createTodoTools,
  createSpecTools,
  createVerificationTools,
  PlanningEngine,
  VerificationEngine,
};
export { TodoManager } from './core/todo-manager.js';
export { Spec } from './planning/spec.js';
export { checkCompleteness, formatCompletenessResult } from './verification/completeness.js';

export {
  resolveProfile,
  ApprovalManager,
  PROFILES,
  PermissionValue,
  RiskLevel,
  checkPermissions,
} from './security/permissions.js';
export { createSandbox, Sandbox, SandboxLevel } from './security/sandbox.js';
export {
  Task,
  TaskStatus,
  Run,
  ParallelExecutor,
  parallel,
  DAG,
  DAGExecutor,
  TaskTree,
  GoalDecomposer,
} from './planning/index.js';
export {
  ToolLifecycle,
  ToolRegistry,
  ToolError,
} from './tools/index.js';
export { createHttpTools } from './tools/index.js';

// Evaluation / Critic layer + Goal completion detector + Evidence (provenance)
export {
  EvaluationEngine,
  GoalState,
  EvalNext,
  evidenceOf,
  sha256,
} from './evaluation/index.js';
export { BudgetManager, BudgetUnits } from './budget/budget-manager.js';
export { ArtifactManager, ArtifactType } from './artifacts/artifact-manager.js';
export { buildSystemPrompt } from './core/system-prompt.js';

export default buildAgent;
