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
import { AgentLoop } from './loop.js';
import { ContextWindow } from './context.js';
import { ToolRegistry } from './tools.js';
import { createReasoner } from './reasoner.js';
import { createNineRouterClient } from './clients/9router.js';
import { createShellTool } from './tools/shell.js';
import { createFileTools } from './tools/files.js';
import { createWebSearchTool } from './tools/search.js';
import { runRepl } from './repl.js';
import { createMemory } from './memory/index.js';
import { wireMemory } from './memory-integration.js';
import { createLogger } from './logger.js';
import { createTraceRenderer } from './trace.js';
import { SessionLogger, attachSessionLogger } from './session-logger.js';
import { randomUUID } from 'node:crypto';

const log = createLogger('index');

const DEFAULT_SYSTEM_PROMPT = [
  'You are ScrappyAi, an autonomous coding/research agent built on a minimal, ',
  'auditable core: a think -> act -> observe loop, a validated tool registry, ',
  'a token-budgeted context window, and a persistent, layered memory system ',
  '(session, long-term facts, semantic recall, past episodes).',
  '',
  'Operating rules:',
  '- Use a tool when it materially helps (reading/writing files, running a ',
  '  command, searching the web); answer directly otherwise. Never claim a ',
  '  tool ran when it did not.',
  '- Ask a clarifying question instead of guessing when the request is ',
  '  genuinely ambiguous; do not stall on things you can reasonably infer.',
  '- A "[memory]" system message, when present, lists facts you have ',
  '  already confirmed about this user/project and relevant past turns or ',
  '  episodes. Treat it as ground truth you already know - use it, do not ',
  '  re-ask for it, and never contradict a confirmed fact without saying so.',
  '- Be direct and concrete. State what you did and what remains; do not ',
  '  narrate your own reasoning process or pad answers with filler.',
].join('\n');

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
 * Register the default tool set (shell, read_file, write_file, web_search)
 * on a ToolRegistry.
 * @param {Object} [opts]
 * @param {import('./tools.js').ToolRegistry} [opts.registry] reuse an existing registry instead of creating one
 * @param {string} [opts.filesRoot] sandbox root for read_file/write_file, default process.env.SCRAPPYAI_FILES_ROOT || cwd
 * @param {string} [opts.shellCwd]
 * @returns {import('./tools.js').ToolRegistry}
 */
export function createDefaultToolRegistry(opts = {}) {
  const registry = opts.registry || new ToolRegistry();
  const filesRoot = opts.filesRoot || process.env.SCRAPPYAI_FILES_ROOT || process.cwd();

  registry.register(createShellTool({ cwd: opts.shellCwd }));

  const { readTool, writeTool } = createFileTools({ rootDir: filesRoot });
  registry.register(readTool);
  registry.register(writeTool);

  registry.register(createWebSearchTool());

  return registry;
}

/**
 * Build a fully wired AgentLoop, with persistent memory attached unless
 * SCRAPPYAI_MEMORY_ENABLED=false. See memory/index.js for the "auto mode"
 * backend selection (in-process by default, Redis when SCRAPPYAI_REDIS_URL
 * is set) and memory-integration.js for exactly what gets injected/recorded
 * per turn.
 * @param {Object} [opts]
 * @param {import('./tools.js').ToolRegistry} [opts.tools] defaults to createDefaultToolRegistry()
 * @param {import('./context.js').ContextWindow} [opts.context]
 * @param {string} [opts.systemPrompt]
 * @param {Function} [opts.onEvent]
 * @param {string} [opts.userId] defaults to SCRAPPYAI_USER_ID env or "local" — identifies whose
 *        long-term/semantic memory this agent reads and writes.
 * @param {string} [opts.sessionId] defaults to SCRAPPYAI_SESSION_ID env or a fresh generated id —
 *        scopes session (turn-by-turn) memory; a new process gets a new session by default.
 * @param {string} [opts.projectId] defaults to SCRAPPYAI_PROJECT_ID env or null — scopes project memory.
 * @param {boolean} [opts.memory] pass false to force-disable memory for this instance regardless of env.
 * @returns {AgentLoop}
 */
export function buildAgent(opts = {}) {
  const systemPrompt = loadSystemPrompt(opts.systemPrompt);
  const tools = opts.tools || createDefaultToolRegistry();
  const context =
    opts.context ||
    new ContextWindow({
      maxTokens: Number(process.env.SCRAPPYAI_MAX_TOKENS) || 8000,
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

  const agent = new AgentLoop({
    context,
    tools,
    reasoner,
    onEvent: opts.onEvent,
    requireApprovalFor: opts.requireApprovalFor,
    onToolApproval: opts.onToolApproval,
    lifecycleHooks: opts.lifecycleHooks,
    checkpointDir: opts.checkpointDir ?? (process.env.SCRAPPYAI_CHECKPOINT_DIR
      ? `${process.env.SCRAPPYAI_CHECKPOINT_DIR}/${sessionId}`
      : undefined),
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

export default buildAgent;
