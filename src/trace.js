/**
 * trace.js — Execution Trace terminal renderer
 * -----------------------------------------------
 * Turns AgentLoop's raw onEvent(event, payload) stream into a clean, colored,
 * Claude-Code-style terminal trace instead of dumped raw JSON:
 *
 *   ● Thought
 *     considering whether to search or answer directly...
 *
 *   ⚙ Tool Call  web_search({"query":"..."})
 *     ✔ done in 412ms
 *     ndjson, 4 results
 *
 *   ● Final Answer
 *     <the answer>
 *
 * Also renders the accumulated Step Memory as an "Agent Scratchpad" — the
 * durable, numbered Thought/Action/Observation/Final-Answer record of a run,
 * independent of the chat window (see LOOP.md → StepRecord).
 *
 * No dependency: colors are plain ANSI escapes, disabled automatically when
 * stdout is not a TTY or NO_COLOR is set, so piping to a file/CI stays clean.
 *
 * Pure JavaScript (ES modules).
 */

const RESET = '\x1b[0m';
const CODES = {
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  gray: '\x1b[90m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
  blue: '\x1b[34m',
};

function supportsColor(stream) {
  if (process.env.NO_COLOR) return false;
  if (process.env.SCRAPPYAI_TRACE_COLOR === 'false') return false;
  if (process.env.SCRAPPYAI_TRACE_COLOR === 'true') return true;
  return !!(stream && stream.isTTY);
}

function paint(colorEnabled, code, text) {
  return colorEnabled ? `${CODES[code]}${text}${RESET}` : text;
}

function indent(text, prefix = '    ') {
  return String(text)
    .split('\n')
    .map((l) => `${prefix}${l}`)
    .join('\n');
}

function shorten(value, max = 400) {
  const s = typeof value === 'string' ? value : safeJson(value);
  if (!s) return s;
  return s.length > max ? `${s.slice(0, max)}...[+${s.length - max} chars]` : s;
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch (_err) {
    return String(value);
  }
}

/**
 * Build a terminal trace renderer. Feed it as (or inside) an AgentLoop
 * onEvent hook: `onEvent: renderer.onEvent`.
 * @param {Object} [opts]
 * @param {NodeJS.WritableStream} [opts.output=process.stdout]
 * @param {boolean} [opts.color] force color on/off; default = auto-detect TTY.
 * @param {boolean} [opts.verbose=false] also print raw retry/state-change lines (noisy but complete).
 */
export function createTraceRenderer({ output = process.stdout, color, verbose = false } = {}) {
  const colorEnabled = color === undefined ? supportsColor(output) : !!color;
  const c = (code, text) => paint(colorEnabled, code, text);
  const write = (text) => output.write(`${text}\n`);

  function onEvent(event, payload = {}) {
    switch (event) {
      case 'think': {
        const { action } = payload;
        if (!action) return;
        if (action.type === 'tool_call') return; // rendered by the matching 'act' line instead
        write(`\n${c('bold', '●')} ${c('bold', 'Thought')}`);
        if (action.reasoning) write(indent(c('dim', shorten(action.reasoning))));
        return;
      }
      case 'act': {
        write(`\n${c('cyan', '⚙')} ${c('bold', 'Tool Call')}  ${c('cyan', payload.tool)}(${shorten(payload.args, 200)})`);
        return;
      }
      case 'tool_retry': {
        write(indent(c('yellow', `↻ retry ${payload.attempt} in ${payload.backoffMs}ms (${payload.code}: ${shorten(payload.error, 120)})`)));
        return;
      }
      case 'observe': {
        const ok = payload.result && payload.result.ok;
        const mark = ok ? c('green', '✔') : c('red', '✘');
        write(indent(`${mark} ${ok ? 'done' : 'failed'} in ${payload.durationMs}ms (attempts=${payload.attempts})`));
        write(indent(c('dim', shorten(ok ? payload.result.data : payload.result.error))));
        return;
      }
      case 'tool_approval_requested': {
        write(`\n${c('magenta', '⏸')} ${c('bold', 'Awaiting Tool Approval')}  ${c('magenta', payload.tool)}(${shorten(payload.args, 200)})`);
        return;
      }
      case 'tool_approval_granted':
        write(indent(c('green', '✔ approved')));
        return;
      case 'tool_approval_rejected':
        write(indent(c('red', `✘ rejected${payload.reason ? `: ${payload.reason}` : ''}`)));
        return;
      case 'final':
        write(`\n${c('bold', c('green', '● Final Answer'))}`);
        write(indent(payload.content));
        return;
      case 'need_clarification':
        write(`\n${c('bold', c('blue', '● Clarification Needed'))}`);
        write(indent(payload.question));
        return;
      case 'error':
        write(`\n${c('bold', c('red', `● Error (${payload.phase})`))}`);
        write(indent(shorten(payload.error)));
        return;
      case 'paused':
        write(`\n${c('yellow', '⏸ Paused')} at step ${payload.step}`);
        return;
      case 'resumed':
        write(`\n${c('blue', '▶ Resumed')} from step ${payload.fromStep}`);
        return;
      case 'max_steps_reached':
        write(`\n${c('yellow', `⚠ Max steps reached (${payload.steps})`)}`);
        return;
      case 'tool_failure_exhausted':
        write(`\n${c('red', `✘ Tool failure exhausted: ${payload.error}`)}`);
        return;
      case 'stuck_loop_detected':
        write(`\n${c('red', `✘ Stuck loop detected: ${payload.error}`)}`);
        return;
      case 'state_change':
        if (verbose) write(c('gray', `  · state -> ${payload.to}`));
        return;
      default:
        if (verbose) write(c('gray', `  · ${event} ${shorten(payload, 200)}`));
    }
  }

  return { onEvent, colorEnabled };
}

/**
 * Render a full StepRecord[] (AgentLoop.getStepMemory() / LoopResult.stepMemory)
 * as a numbered "Agent Scratchpad" — the durable Thought/Action/Observation/
 * Final-Answer trail, independent of the (compressed, token-budgeted) chat
 * context. Returns a plain string; print it yourself (`console.log`) or pass
 * `output` to write it directly.
 * @param {import('./loop.js').StepRecord[]} stepMemory
 * @param {Object} [opts]
 * @param {boolean} [opts.color]
 * @param {NodeJS.WritableStream} [opts.output]
 */
export function renderScratchpad(stepMemory, { color, output } = {}) {
  const colorEnabled = color === undefined ? supportsColor(output || process.stdout) : !!color;
  const c = (code, text) => paint(colorEnabled, code, text);
  const lines = [c('bold', `Agent Scratchpad (${stepMemory.length} step(s))`), ''];

  stepMemory.forEach((record, i) => {
    lines.push(c('dim', `— step ${record.step} · ${record.phase} —`));
    if (record.action && record.action.type === 'tool_call') {
      lines.push(`  ${c('cyan', 'Action')}: ${record.action.tool}(${shorten(record.action.args, 200)})`);
      if (record.action.reasoning) lines.push(`  ${c('gray', 'Thought')}: ${shorten(record.action.reasoning, 200)}`);
    }
    if (record.phase === 'observe' && record.result) {
      lines.push(`  ${c('green', 'Observation')}: ${shorten(record.result.ok ? record.result.data : record.result.error, 300)}`);
    }
    if (record.phase === 'final' && record.action) {
      lines.push(`  ${c('bold', c('green', 'Final Answer'))}: ${shorten(record.action.content, 400)}`);
    }
    if (record.error) lines.push(`  ${c('red', 'Error')}: ${shorten(record.error, 300)}`);
    if (i < stepMemory.length - 1) lines.push('');
  });

  const text = lines.join('\n');
  if (output) output.write(`${text}\n`);
  return text;
}

export default createTraceRenderer;
