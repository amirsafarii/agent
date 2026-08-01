# ScrappyAi

Minimal, dependency-free agent core. Pure JavaScript (ES modules) — no TypeScript, no build step.

```
src/
├── index.js                ← buildAgent() wiring: tools + 9router + memory + session log
├── core/
│   ├── loop/               ← the heart: think → act → observe (AgentLoop)
│   │   ├── agent-loop.js      orchestrator: guards, retry, adaptive budget, approval gate,
│   │   │                      Run≠Task, parallel tool_calls, end-to-end AbortSignal
│   │   ├── state-machine.js   LoopState + LoopStateMachine (audited transitions)
│   │   ├── stop-conditions.js prioritized Stop Condition Engine
│   │   ├── events.js          LoopEvents / TerminationReason / ActionType
│   │   ├── errors.js          LoopError
│   │   └── compression.js     tool-result compression + shared helpers
│   ├── context.js          ← context window: token budget + auto-compaction (ContextWindow)
│   ├── reasoner.js         ← pluggable LLM adapter + native tool_call_id history,
│   │                          + streaming (createReasoner) + AbortSignal → HTTP
│   ├── checkpoint-manager.js ← every checkpoint addressable by id, in memory + on disk
│   ├── session-logger.js   ← per-session events.jsonl + transcript.log on disk
│   ├── trace.js            ← Claude-Code-style colored terminal trace + scratchpad renderer
│   ├── logger.js           ← one structured logger everywhere (redaction built in)
│   └── repl.js             ← multi-turn REPL (/help /history /scratchpad /system /reset
│                              /approve /deny /exit)
├── clients/9router.js      ← OpenAI-compatible chat + chatStream (SSE) adapter
├── security/
│   ├── permissions.js      ← permission axes + profiles (readonly/developer/autonomous/admin)
│   │                          + ApprovalManager (tool/plan/step/session grants)
│   └── sandbox.js          ← realpath-based containment (blocks symlink escapes)
├── tools/
│   ├── registry.js         ← lifecycle-aware ToolRegistry (DISCOVERED→…→ACTIVE→REMOVED)
│   ├── lifecycle.js        ← ToolLifecycle states + metadata + metrics
│   └── {filesystem,shell,code,package,planning,verification,search}.js
├── planning/               ← engine.js (PlanningEngine) + task.js (Task/Run) +
│                              parallel-executor.js + DAG, goal-decomposer,
│                              task-tree, dag-executor (parallel waves)
├── verification/           ← engine.js (VerificationEngine) + verification-pipeline,
│                              validators
└── memory/                 ← seven-layer memory (session/workspace/episodic/semantic/
│                              long-term/tool/project), in-process or Redis
└── integration.js          ← [memory] injection before each turn, recording after
tests/
├── smoke.test.js           ← buildAgent() end to end, loadSystemPrompt, abort signal
├── reasoner.test.js        ← createReasoner + scripted client
├── loop-advanced.test.js   ← retry / exhaustion / fail-fast / timeout / max tokens / …
├── loop-checkpoint.test.js ← pause / resume / checkpoint / state machine / stop engine
├── loop-approval.test.js   ← tool approval gate / lifecycle hooks / CheckpointManager /
│                              SessionLogger
├── 9router.test.js         ← stream:false, NDJSON/SSE recovery, HTTP errors, mapping
├── tools.test.js           ← ToolRegistry + real shell/files behavior + stubbed search
├── planning.test.js        ← PlanningEngine + DAG + GoalDecomposer + TaskTree + DAGExecutor
├── verification.test.js    ← VerificationEngine + VerificationPipeline + validators
├── memory.test.js          ← all seven layers + extractor + wireMemory degrade
├── streaming.test.js       ← chatStream SSE accumulation + streamed AgentLoop turns
├── logger.test.js          ← redaction + clipping
└── repl.test.js            ← REPL commands + /approve /deny + streamed answers
docs/
└── LOOP.md                 ← full loop input/output schema (states, actions, results)
```

## Run tests

```
npm test
```
(equivalent to `node --test`, uses Node's built-in test runner — no extra deps. **182 tests, all green** — the suite exercises real subprocess/filesystem behavior and stubs only `fetch` for the network tools. Includes lifecycle, permissions, realpath sandbox, Task/Run, parallel executor, and end-to-end AbortSignal coverage.)

## Wiring it together

`AgentLoop` needs three things injected:

1. A `ContextWindow` instance — holds the running message trace (generic audit log).
2. A `ToolRegistry` instance — register your tools with `register({ name, description, parameters, handler, timeoutMs })`.
3. A `reasoner` function — `async (renderedContext, toolSchema) => action`, where `action` is one of:
   - `{ type: 'tool_call', tool, args, reasoning? }`
   - `{ type: 'final', content, reasoning? }`
   - `{ type: 'need_clarification', question, reasoning? }`

If the reasoner function also exposes `addUser(text)` and `addToolResult(toolCallId, result)` methods,
`AgentLoop.run()` calls them automatically alongside its own `ContextWindow` bookkeeping — that's how
`createReasoner()` (below) keeps a provider-native message history in sync (e.g. OpenAI-style
tool-calling APIs that require the tool result to echo back the matching `tool_call_id`).

### Quick and dirty: a raw reasoner function

```js
import { AgentLoop } from './src/core/loop/index.js';
import { ToolRegistry } from './src/tools/index.js';
import { ContextWindow } from './src/core/context.js';

const tools = new ToolRegistry();
tools.register({
  name: 'search',
  description: 'search the web',
  parameters: { query: { type: 'string', required: true } },
  handler: async ({ query }) => `results for ${query}`,
});

const context = new ContextWindow({ maxTokens: 8000 });

const reasoner = async (rendered, toolSchema) => {
  // call your LLM here with `rendered` (message history) and `toolSchema`
  // (tool name/description/parameters list), then map its output to an
  // action object.
  return { type: 'final', content: 'done' };
};

const loop = new AgentLoop({ context, tools, reasoner });
const result = await loop.run('find me something');
console.log(result);
```

### Recommended: `createReasoner()` from `src/core/reasoner.js`

This is the provider-agnostic adapter layer: you write a small `client.chat({ systemPrompt, messages, tools })`
function for your actual LLM (OpenAI, Anthropic, local model), and `createReasoner()` handles
normalizing its output into an `Action`, retrying transient failures, and maintaining the
native `tool_call_id`-correlated history the loop needs for multi-turn tool use.

```js
import { AgentLoop } from './src/core/loop/index.js';
import { ToolRegistry } from './src/tools/index.js';
import { ContextWindow } from './src/core/context.js';
import { createReasoner } from './src/core/reasoner.js';

const client = {
  async chat({ systemPrompt, messages, tools }) {
    // call your real LLM SDK here and map its response to one of:
    //   { type: 'tool_call', tool, args, id?, reasoning? }
    //   { type: 'final', content, reasoning? }
    //   { type: 'need_clarification', question, reasoning? }
    return { type: 'final', content: 'done' };
  },
};

const reasoner = createReasoner({ client, systemPrompt: 'You are ScrappyAi.' });
const loop = new AgentLoop({
  context: new ContextWindow({ maxTokens: 8000 }),
  tools: new ToolRegistry(),
  reasoner,
});

const result = await loop.run('find me something');
```

For wiring/dev without a real LLM yet, `createScriptedClient([...responses])` from `src/core/reasoner.js`
plays back a fixed sequence of responses — see `tests/reasoner.test.js`.

## Running it end to end

```bash
cp .env.example .env   # fill in NINEROUTER_BASE_URL / NINEROUTER_API_KEY / NINEROUTER_MODEL
npm install
npm start -- "what's in ./README.md?"
```

`src/index.js` wires `ContextWindow` + `ToolRegistry` (with the four tools below) + a reasoner built
on `src/clients/9router.js` into one `AgentLoop`, and runs a single prompt from argv. Import
`buildAgent()` / `createDefaultToolRegistry()` instead if you want to embed ScrappyAi in another
program (e.g. a Slack bot, a CLI with a REPL, a server).

## Tools registered by default (`src/tools/`) — 28 tools in 7 suites

**filesystem** (`tools/filesystem.js`) — all confined to the sandbox root
(`SCRAPPYAI_FILES_ROOT`, default cwd); `../` traversal and absolute paths
outside the root are rejected before any fs call:

| Tool | Notes |
|---|---|
| `read_file` | Read a UTF-8 text file (capped at 20k chars, `truncated` flag). |
| `write_file` | Create/overwrite/append (capped at 200k chars, creates parents). |
| `edit_file` | Targeted find/replace — literal or `useRegex`, `replace_all`, fails with `NOT_FOUND` instead of silently doing nothing. |
| `list_dir` | Flat or `recursive` (depth- and entry-capped), hidden excluded by default. |
| `search_files` | Glob patterns (`**/*.js`, `*.md`), optional content substring filter, result cap. |
| `make_dir` | `mkdir -p`. |
| `move_file` | Rename/move, cross-device safe (copy+unlink fallback). |
| `copy_file` | File or whole tree copy. |
| `delete_file` | Deletes files/dirs — **approval-gated** (`requiresApproval:true`), refuses the sandbox root and non-recursive dirs. |

**shell** (`tools/shell.js`):

| Tool | Notes |
|---|---|
| `shell` | Runs a command via `execa`, **not** through `/bin/sh` unless `useShell:true` — `&&`/`|`/`>` are literal args by default. Denylist (`rm`, `shutdown`, `reboot`, `mkfs`, `dd`), optional allowlist, `cwd` is checked against the sandbox root, per-call timeout, output truncation, never throws on non-zero exit. |
| `shell_spawn` | Background process (detached, stdio ignored), returns the pid immediately; tracked for later `shell_kill`. |
| `shell_kill` | Kill by pid (default SIGTERM); only pids `shell_spawn` started unless `force:true` — **approval-gated**. |
| `shell_which` | PATH resolution for a binary (no subprocess). |

**code** (`tools/code.js`):

| Tool | Notes |
|---|---|
| `code_run` | Executes a file or inline code with the right interpreter (`.js/.mjs/.cjs/.ts → node`, `.py → python3`, `.sh → bash`); bounded timeout, truncated output, exit codes reported not thrown. |
| `code_test` | `command` mode, single-file mode (`node --test` / `pytest`), or the package.json `test` script / bare `node --test`. |
| `code_validate` | Static checks only — `node --check`, JSON parse, `py_compile`; invalid code never runs. |

**package** (`tools/package.js`):

| Tool | Notes |
|---|---|
| `npm` | Any npm command inside the sandbox (`run build`, `ls`, ...), 120s timeout. |
| `package_install` | `npm install` / `npm install <pkgs>` with `dev`/`force` flags. |
| `package_info` | Offline metadata: the project's package.json or an installed package resolved from cwd (no registry call). |

**planning** (`tools/planning.js`):

| Tool | Notes |
|---|---|
| `plan_create` | Create a structured multi-step task execution plan with subtasks and dependency tracking. |
| `plan_update_task` | Update task status (`pending`, `in_progress`, `completed`, `failed`, `skipped`) or notes. |
| `plan_get` | Inspect current plan status, completion percentage, and next ready actionable tasks. |
| `plan_add_tasks` | Append new subtasks dynamically to an active plan as needs evolve. |

**verification** (`tools/verification.js`):

| Tool | Notes |
|---|---|
| `verify_file` | Assert file or directory existence, size, or required content/regex pattern. |
| `verify_command` | Assert command exit code and expected stdout/stderr output. |
| `verify_json` | Assert valid JSON syntax and verify required top-level keys. |
| `verify_suite` | Execute a batch suite of file, command, or JSON verification checks in sequence. |

**web**: `web_search` (`tools/search.js`) — SearXNG JSON API (`SEARXNG_BASE_URL`), all documented params, results capped (default 8).

### Sandbox + permissions

Everything file-shaped (filesystem, code, package, shell `cwd`) is confined
to one root — `SCRAPPYAI_FILES_ROOT` (defaults to the working directory) via
**realpath-based** containment (`security/sandbox.js`). A symlink inside the
sandbox that points at `/etc` is rejected (`SYMLINK_ESCAPE`) before any read.

Permission profiles (`SCRAPPYAI_PERMISSION_PROFILE` or `buildAgent({ profile })`):

| Profile | FS | Network | Shell | Package scripts |
|---|---|---|---|---|
| `readonly` | readonly | ✓ | ✗ | ✗ |
| `developer` (default) | sandbox | ✓ | restricted | install w/ `--ignore-scripts` |
| `autonomous` | sandbox | ✓ | restricted | install w/ `--ignore-scripts` |
| `admin` | host | ✓ | allow | lifecycle scripts allowed |

Destructive tools (`delete_file`, `shell_kill`, `package_install`) are
approval-gated out of the box. Approval is multi-level:

```js
agent.approveToolForSession('shell');   // this tool, rest of session
agent.approvePlan(planId);              // whole plan
agent.approveStep(planId, taskId);      // one step
// or denyToolForSession('shell')
```

Also: `SCRAPPYAI_REQUIRE_APPROVAL` (comma list or `*`) /
`buildAgent({ requireApprovalFor, onToolApproval, onPlanApproval })`.

### Tool lifecycle + metadata

Tools are no longer a bare `register → execute`. Every tool walks:

```
DISCOVERED → DRAFT → VALIDATING → TESTING → APPROVED
  → REGISTERED → ACTIVE → DEPRECATED → REMOVED
```

`register()` promotes builtins to `ACTIVE` automatically. Only `ACTIVE`
tools are advertised to the reasoner; `DEPRECATED` still runs (with a
warning); anything else is rejected with `TOOL_NOT_ACTIVE`. Each tool
carries metadata (`version`, `author`, `tags`, `category`, `risk`,
`permissions`, `sideEffects`, execution metrics).

### Run ≠ Task + parallel execution

A **Run** is one `agent.run()` invocation. A **Task** is a unit of work
inside it (goal, status, deps, inputs/outputs, attempts, artifacts,
subtasks). Plans attach Tasks to the active Run.

Independent work runs concurrently:

```js
import { parallel } from './src/planning/index.js';

await parallel([taskA, taskB, taskC], {
  concurrency: 4,
  signal,            // AbortSignal
  timeoutMs: 30_000, // overall
  taskTimeoutMs: 10_000,
  onError: 'collect', // fail-fast | continue | collect
  retry: { retries: 2, backoffMs: 100 },
});
```

The reasoner can also emit a parallel tool batch:

```js
{ type: 'tool_call', tools: [
  { tool: 'web_search', args: { q: 'A' } },
  { tool: 'web_search', args: { q: 'B' } },
  { tool: 'web_search', args: { q: 'C' } },
]}
```

### End-to-end cancellation

`agent.run(input, { signal })` propagates `AbortSignal` all the way down:

```
agent.run → AgentLoop → reasoner → HTTP (9router)
                     → ToolRegistry.execute → handler(args, { signal, context, logger, task, permissions, sandbox, tool })
                                            → child_process (execa cancelSignal) / fetch
```

Every tool handler receives the same rich context object.

### Agent-logic safeguards (loop.js)

- **Adaptive step budget** — `maxSteps` is a base, not a ceiling: with
  `adaptiveMaxSteps` (on by default in `buildAgent()`), the budget grows
  (doubling, up to `SCRAPPYAI_MAX_STEPS_MAX`, default 48) while the run
  keeps producing progress, so a 30-step task isn't cut short. Per-call
  override: `agent.run(input, { maxSteps })`. Disable with
  `SCRAPPYAI_ADAPTIVE_MAX_STEPS=false`.
- **Tool-overuse guard** — `maxToolCallsPerTool` (default 8) stops a run
  when one tool is called too many times, whatever the args — endless
  search variants get capped, legitimate multi-step work doesn't.
- **Similar-call warning** — near-duplicate calls (same tool, args equal
  after key-order normalization, non-consecutive) append a `[loop guard]`
  notice so the reasoner can pivot instead of repeating itself.
- **Fail-fast retries** — only generic execution errors are retried now;
  timeouts and network-shaped failures (`REQUEST_FAILED`, `HTTP_ERROR`,
  `ENOTFOUND`, `ETIMEDOUT`, ...) fail on the first attempt so the agent
  pivots immediately (see the Fallback Rule in the system prompt).
- **Stuck-loop detection** (unchanged) stops identical consecutive calls.

### System prompt rules (updated)

The built-in `DEFAULT_SYSTEM_PROMPT` now encodes the efficiency contract:
cheapest-sufficient-tool-first, **snippet sufficiency** (a web_search
snippet that answers is enough — no fetch/curl), the **Fallback Rule**
(network error/timeout → don't retry, rely on web_search or prior data),
and no repeated calls for the same data.

## `clients/9router.js`

`createReasoner()` only needs a `client.chat({ systemPrompt, messages, tools }) => RawResponse`
adapter — this file is that adapter for **9router**. It speaks the OpenAI-compatible
`/chat/completions` shape (native `tool_calls`, `tool_choice: "auto"`), which is what most
"LLM router" products (OpenRouter, local model gateways, etc.) expose.

**No API docs for 9router were supplied**, so this is a documented assumption, not a
confirmed contract. If the real API differs (auth header, endpoint path, tool_call JSON
shape), only `src/clients/9router.js` needs to change — `reasoner.js`, `loop.js`, and every
tool are provider-agnostic and untouched by that fix. Config is three required env vars:
`NINEROUTER_BASE_URL`, `NINEROUTER_API_KEY`, `NINEROUTER_MODEL`, plus one optional
`NINEROUTER_RESPONSE_FORMAT` (see `.env.example`).

### Fixed: "Unexpected non-whitespace character after JSON" (real-world 9router bug)

Reported live against a real 9router deployment. The request body never sent `stream`, and
the gateway defaulted to streaming — sending back multiple JSON objects concatenated (NDJSON)
or SSE `data:`-framed chunks instead of one clean object, so `res.json()` choked on whatever
came after the first complete object. Two fixes, both in `src/clients/9router.js`:

1. Every request now explicitly sends `stream: false`.
2. The response parser is defensive regardless: it tries a clean `JSON.parse` first, then
   falls back to SSE `data:` framing (keeps the last chunk), then to a balanced-brace scan
   that pulls out the first complete `{...}` object from concatenated JSON. Only if none of
   that works does it throw, with the first 200 characters of the body in the error so the
   real shape is visible immediately.

Covered by 6 new tests (`node --test`) exercising `stream:false`, NDJSON recovery, SSE
recovery, and the unrecoverable-body error path.

### Phase 1 — Core: system prompt + multi-turn REPL (memory between messages)

`node src/index.js` with **no argv prompt** now launches an interactive REPL instead of
printing a usage error. Every line you type becomes a user turn against the **same**
`AgentLoop` instance, so `ContextWindow` (the audit-trail history) and the reasoner's native
message history (what actually gets sent to 9router, including tool_call ids) both persist
across turns automatically — memory between messages falls out of reusing one agent, not from
any extra plumbing.

```
$ node src/index.js
ScrappyAi REPL — multi-turn, memory kept between messages. Type /help for commands, /exit to quit.
scrappyai> my name is yysafari86
ok, noted.
scrappyai> what's my name?
your name is yysafari86.
scrappyai> /history      # dump exactly what's being sent to the model
scrappyai> /tools        # list the 20 registered tools
scrappyai> /scratchpad   # full Thought/Action/Observation trail
scrappyai> /reset        # wipe memory, keep the system prompt, keep going
scrappyai> /exit
```

`node src/index.js "one-shot prompt"` (an argv prompt given) still runs exactly one turn and
exits — unchanged, for scripts/CI.

System prompt is one configurable knob (`src/index.js: loadSystemPrompt()`), resolved in this
order: an explicit override passed to `buildAgent({ systemPrompt })` > `SCRAPPYAI_SYSTEM_PROMPT_FILE`
(path to a text file, for long prompts) > `SCRAPPYAI_SYSTEM_PROMPT` (inline, for short ones) >
the built-in default. See `.env.example`.

### Memory (src/memory/, wired in via src/memory/integration.js)

`buildAgent()` now attaches a full seven-layer memory system by default —
**session**, **workspace**, **episodic**, **semantic**, **long-term**,
**tool**, and **project** memory (`src/memory/memory-manager.js` +
`src/memory/layers/*.js`) — on every agent it builds, unless
`SCRAPPYAI_MEMORY_ENABLED=false` or `buildAgent({ memory: false })`.

*Auto mode*, per the "simple yet powerful .env" requirement: with no
`SCRAPPYAI_REDIS_URL` set, every layer transparently runs on an in-process
store (`PulseStore`'s `EphemeralFallback`) — non-durable across restarts,
but session recall, long-term fact storage, semantic recall (via a
deterministic offline embedding, no API key needed — see
`src/memory/embeddings.js`), episodic recall, tool stats, and project
memory all just work with zero configuration. Set `SCRAPPYAI_REDIS_URL` to
upgrade to durable, cross-restart memory over the exact same code path; if
that Redis later becomes unreachable, the same layers degrade back to the
in-process fallback on their own — no flag to flip either way.

What actually happens on every `agent.run(userInput)` call, via
`wireMemory()` wrapping `.run()`:

1. **Before** the turn: this user's confirmed long-term facts, the top-k
   semantically relevant memories, and similar past episodes are fetched
   and injected as one `[memory]` system message into `ContextWindow` —
   the reasoner sees them as plain context; `loop.js` never knows memory
   exists.
2. **After** the turn: the user+assistant exchange is recorded into
   session memory, and a trigger-gated fact extractor
   (`src/memory/memory-extractor.js`) runs — it only spends a model call
   when a local regex thinks the message plausibly discloses a durable
   fact ("my name is...", "remember that...", "یادت باشه...", etc.), so
   plain chit-chat never costs a call. A promoted fact upserts by key
   (e.g. `user_name`) instead of duplicating, and a low-confidence guess
   can never silently overwrite something the user explicitly confirmed —
   it's parked as `pendingValue`/`requiresConfirmation` instead
   (`src/memory/layers/long-term-memory.js`).

Every step above is best-effort: a Redis hiccup or extraction failure
degrades that turn's context, it never breaks the turn (see the
`wireMemory: a memory backend failure degrades the turn instead of
breaking it` test).

Scoping — all optional env vars, sane defaults:

```
SCRAPPYAI_MEMORY_ENABLED=false   # fully disable memory (default: on)
SCRAPPYAI_REDIS_URL=redis://127.0.0.1:6379   # upgrade to durable memory
SCRAPPYAI_REDIS_PASSWORD=
SCRAPPYAI_MEMORY_LOG=false       # silence the memory layer's own logging
SCRAPPYAI_USER_ID=local          # whose long-term/semantic facts these are
SCRAPPYAI_SESSION_ID=            # unset = a fresh session id per process start
SCRAPPYAI_PROJECT_ID=            # unset = no project-scoped memory
```

### System prompt

`loadSystemPrompt()`'s resolution order (explicit override >
`SCRAPPYAI_SYSTEM_PROMPT_FILE` > `SCRAPPYAI_SYSTEM_PROMPT` > built-in
default) is unchanged, but the built-in default itself was rewritten to
actually describe the agent it is now shipped with: it names the
loop/tools/context/memory architecture, states the tool-use and
clarification rules explicitly, and — since memory is wired in by
default — tells the model how to treat the `[memory]` system message it
will now sometimes see (ground truth already known, use it, do not
re-ask for it, never contradict a confirmed fact silently).

### Logging (src/core/logger.js)

One structured logger, used by every component — `core/loop/`, `tools/`,
`core/context.js`, `core/reasoner.js`, `clients/9router.js`, `index.js`,
`core/repl.js`, `memory/integration.js`, and (via a thin
compat shim so its call sites didn't need rewriting) every memory layer
under `src/memory/`. There is exactly one logging mechanism in the codebase
now — no more ad hoc `console.error` sprinkled in `index.js` alongside the
memory system's own separate logger.

Every call is `log.<level>(event, fields)` — never a bare printf string —
so every line answers the same three questions: **what state** the
component was in when it fired, **what parameters** drove the call, and
**what output** came out (plus `durationMs` wherever timing is meaningful).
`event` is a short, grep-able, stable name like `"execute:start"` or
`"compact:done"`; `fields` is a plain object with the state/params/output
for that line.

What gets logged, end to end for one turn:

| component | events |
|---|---|
| `loop` | `run:start`, `step:start`, `step:think` (action type/tool/args), `step:act`, `step:observe` (ok/output/durationMs), `run:final`, `run:need_clarification`, `run:max_steps`, `run:aborted`, `step:think_failed`, `step:stuck_loop` |
| `tools` | `register`, `unregister`, `execute:start` (name/args), `execute:done` (ok/output-or-error/code/durationMs) |
| `tools:shell` / `tools:files` / `tools:search` | tool-specific start/done/failed pairs with the real command, path, or query and the real stdout/bytes-written/result count |
| `context` | `append` (role/tokens/usedTokens/budgetFraction), `compact:start`, `compact:done` (strategy/dropped-or-summarized count/before-after tokens), `compact:skip`, `compact:summarize_failed` |
| `reasoner` | `chat:start`, `chat:done` (responseType/tool/durationMs), `chat:retry`, `chat:failed` |
| `clients:9router` | `chat:request` (endpoint/model/messageCount/toolCount, apiKey always redacted), `chat:response` (status/durationMs/responseType/usage), `chat:request_failed`, `chat:http_error` |
| `index` | `buildAgent:done` (registered tools, maxTokens, memory backend, system prompt size), `buildAgent:failed`, `main:start`, `main:done` |
| `repl` | `repl:command`, `repl:turn:start`, `repl:turn:done`, `repl:turn:failed` |
| `memory-integration` | `inject:done` / `inject:failed` (facts/semantic/episodes counts), `record:done` / `record:failed`, `record:facts_promoted` |
| `memory:*` (session/workspace/episodic/semantic/long-term/tool/project/pulse-store/redis/memory-extractor) | same structured shape, via `memory/kernel/logger.js`'s shim over the shared logger |

Safety and hygiene, built into the logger itself rather than left to each
call site to remember:

- **Secrets never reach a log line.** Any field whose key looks like
  `apiKey`/`secret`/`password`/`authorization`/`accessToken`/`refreshToken`/
  a bare `token` is replaced with `"[REDACTED]"`, recursively through nested
  objects/arrays — this is a real redaction pass on the field values
  actually logged, not a naming convention someone has to follow. The
  pattern is deliberately narrow (not a bare `/key|token/` substring match)
  so it doesn't also swallow legitimate fields like `usedTokens`/`maxTokens`
  or a tool's `apiKey` *argument* that's actually plain text — only
  credential-shaped keys are redacted.
- **Long output is clipped, not dumped.** Strings over ~800 chars are
  truncated with a `"...[truncated N chars]"` marker and arrays over 20
  entries are capped, so one giant tool result or file read can't flood
  stdout — this also stops a huge blob from making pretty-printed logs
  unreadable.
- **A logging call can never break the thing it's observing.** Every
  callsite is either inside the same try/catch as the operation it's
  describing or comes after the operation has already completed
  successfully — logging is inert with respect to control flow, same
  principle as the pre-existing `onEvent` observability hooks in
  `loop.js`/`reasoner.js`.

Env knobs (all optional; see `.env.example`), read fresh on every log call
so tests/CI can flip them per-case without restarting anything:

```
SCRAPPYAI_LOG=false          # fully silence all logging (used by `npm test`)
SCRAPPYAI_LOG_LEVEL=debug    # debug | info | warn | error (default: info)
SCRAPPYAI_LOG_FORMAT=json    # json | pretty (default: pretty, human-readable)
```

`pretty` (the default) renders one line per event —
`2026-08-01T08:47:15.556Z INFO  [loop] step:observe  step=1 tool=add ok=true output=5 durationMs=0` —
readable straight off a terminal. `json` emits the same data as one JSON
object per line, for piping into a log aggregator. `SCRAPPYAI_MEMORY_LOG`
still exists as a memory-specific mute switch layered on top of
`SCRAPPYAI_LOG`, unchanged from before.

### `response_format` / structured output

You mentioned your 9router deployment supports the OpenAI `response_format` structured-output
param. It's now wired in as `NINEROUTER_RESPONSE_FORMAT` (e.g. `json_object`), but only applied
when the request has **no tools attached** — `response_format` and `tools`/function-calling are
mutually exclusive on every OpenAI-compatible gateway we're aware of (setting both is typically
either rejected or silently ignores one). Since ScrappyAi's tool-calling already goes through
the native `tools` mechanism (which *is* structured), `response_format` only matters for plain
final-answer turns. Leave it unset until you've confirmed the exact shape 9router expects
(`json_object` vs a full `json_schema` object) — happy to wire the exact schema in once you
share it.

### Streaming (roadmap item 4, done)

Final answers can stream token-by-token from the model (SSE) instead of arriving all at once.
Three layers, all optional:

- **Client** — `clients/9router.js` now also exposes `chatStream({ systemPrompt, messages, tools, onDelta, signal })`:
  the same request body with `stream: true`, but the response is read as a live SSE stream.
  `delta.content` chunks are emitted through `onDelta({ type: 'content', text })` as they
  arrive, and `delta.tool_calls` argument fragments are merged per index into one complete
  tool call. Defensive by default: a gateway that ignores `stream: true` and answers with a
  plain JSON object is parsed as-is, and anything after `data: [DONE]` is ignored.
- **Reasoner** — `createReasoner({ stream: true, onToken })` uses `client.chatStream()` when
  available (falls back to `chat()` otherwise) and normalizes the result to the exact same
  `Action` shape, so `AgentLoop` is streaming-agnostic. `onToken(text)` receives final-answer
  content chunks live (tool-call argument fragments are never forwarded). A REPL/UI attached
  after the agent was built can swap the sink at any time via `reasoner.setTokenSink(fn)`.
- **CLI** — set `SCRAPPYAI_STREAM=true` and the one-shot CLI / REPL print the final answer as
  it is generated (a single closing newline after the run). Off by default.

Covered by `tests/streaming.test.js` (10 tests) plus the SSE-recovery tests in
`tests/9router.test.js`.

## Status

Implemented and tested (**182 tests, `node --test`, all green**): `AgentLoop` (state machine,
stop-condition engine, adaptive step budget, tool-overuse + similar-call guards,
checkpoints/pause/resume, multi-level approval gate, Run≠Task, parallel tool_calls,
end-to-end AbortSignal, lifecycle hooks), lifecycle-aware `ToolRegistry` + metadata,
permission profiles + realpath sandbox, `ContextWindow`, `createReasoner` (turn-memory
sync + signal), the **28-tool default registry** (filesystem/shell/code/package/planning/
verification/web), `ParallelExecutor` + parallel DAG waves, the `9router` client
(chat + chatStream), seven-layer memory, checkpoint/session-log/trace/REPL, and
`index.js` wiring.

## Memory between turns — what was fixed

Two real bugs made "turn memory" silently fail:

1. **The `[memory]` system message never reached the model.** `wireMemory()` appends the
   injected facts to `ContextWindow`, but `createReasoner()`'s native history only mirrored
   user/assistant/tool turns — so the provider never saw the memory block. The reasoner now
   syncs dynamic system messages from the rendered context into its native history on every
   call: the current `[memory]` block replaces any older one (facts change), other system
   messages (`[loop guard]`, `[context summary]`) are added once, deduped.
2. **Fact extraction depended entirely on a model call.** If the LLM was down or returned
   nothing, nothing was remembered. The extractor now falls back to deterministic local
   patterns (name/email/phone/city/role/preference/birthday) — "my name is X" survives even
   with a broken model. `wireMemory()` also wraps `resume()`/`resumeWithApproval()` now, so
   approval-continued runs still get injection + recording, and memory events land in the
   session log like every other event.

## Roadmap

1. ✅ `core/reasoner.js` + the two-line loop hook
2. ✅ `tools/shell.js`, `tools/filesystem.js`, `tools/search.js`, `clients/9router.js`, `index.js` (this repo, done and tested)
3. ✅ A proper system prompt (built-in default rewritten — see "System prompt")
4. ✅ Streaming (`chatStream` SSE client + streamed reasoner + `SCRAPPYAI_STREAM` CLI/REPL)

## Open item for you to confirm

`clients/9router.js` assumes an OpenAI-compatible chat-completions API. If 9router's real
contract is different, tell me the auth scheme + request/response shape (or a docs link) and
I'll adjust just that one file.
