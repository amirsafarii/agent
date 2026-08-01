/**
 * repl.js — Multi-turn REPL
 * -----------------------------------------------
 * Reads lines from `input`, feeds each as a user turn to the SAME AgentLoop
 * instance, and prints the outcome to `output`. Memory between turns is not
 * this file's job — it falls out for free because AgentLoop/ContextWindow/
 * the reasoner's native history all live on the single `agent` object passed
 * in and are never recreated between iterations.
 *
 * A handful of `/` slash-commands let the operator inspect or reset that
 * state without restarting the process:
 *
 *   /help              list commands
 *   /history           dump the rendered ContextWindow (what the model sees)
 *   /system            show the active system prompt
 *   /reset             clear ContextWindow + reasoner history, keep system prompt
 *   /exit, /quit       leave the REPL
 *
 * When the agent was built with streaming (SCRAPPYAI_STREAM=true), final
 * answers are written token-by-token as they are generated: pass the same
 * token sink back in via `onToken` and the final-answer line is not
 * re-printed after the run completes (a bare newline closes the streamed
 * line instead).
 *
 * Pure JavaScript (ES modules). No TypeScript, no build step, no readline
 * dependency beyond Node's built-in `node:readline/promises`.
 */

import { createInterface } from 'node:readline';
import { createLogger } from './logger.js';
import { renderScratchpad } from './trace.js';

const log = createLogger('repl');

const HELP_TEXT = [
  'Commands:',
  '  /help        show this message',
  '  /history     dump the rendered context window sent to the model',
  '  /scratchpad  dump the Agent Scratchpad (full Thought/Action/Observation trail, not the compressed context)',
  '  /tools       list the registered tools',
  '  /system      show the active system prompt',
  '  /reset       clear conversation memory (context + reasoner history), keep the system prompt',
  '  /approve     approve the tool call this session is currently awaiting approval for',
  '  /deny [reason]  deny it instead (the reasoner is told why and tries something else)',
  '  /exit        leave the REPL (alias: /quit)',
].join('\n');

/**
 * Run an interactive multi-turn loop against a single, already-built agent.
 *
 * @param {Object} opts
 * @param {import('./loop/index.js').AgentLoop} opts.agent - built via buildAgent(); reused across every turn.
 * @param {string} [opts.systemPrompt] - only used for the /system command's display.
 * @param {NodeJS.ReadableStream} [opts.input=process.stdin]
 * @param {NodeJS.WritableStream} [opts.output=process.stdout]
 * @param {string} [opts.prompt='> ']
 * @param {Function} [opts.onToken] - (text: string) => void; called with final-answer
 *        content chunks as they stream in when the agent streams. Also used to
 *        suppress the duplicate final-answer print (see header comment).
 * @returns {Promise<void>} resolves when the REPL exits (EOF or /exit)
 */
export async function runRepl({ agent, systemPrompt, input = process.stdin, output = process.stdout, prompt = 'scrappyai> ', onToken } = {}) {
  if (!agent || typeof agent.run !== 'function') {
    throw new TypeError('runRepl requires an "agent" with a .run(input) method.');
  }

  const rl = createInterface({ input, terminal: input.isTTY === true });
  output.write('ScrappyAi REPL — multi-turn, memory kept between messages. Type /help for commands, /exit to quit.\n');

  // readline's async iterator internally buffers lines that arrive before
  // they're consumed, unlike calling rl.question() in a loop (which can
  // silently drop lines emitted while nothing is listening yet). That
  // buffering is exactly what a piped/non-TTY input (tests, scripts) needs.
  const lines = rl[Symbol.asyncIterator]();

  // Set whenever a turn (or a /approve|/deny) ends with status
  // 'awaiting_tool_approval' — the exact checkpoint /approve and /deny act on.
  const session = { pendingApprovalCheckpoint: null, streamedThisTurn: false };

  // Attach the token sink to the agent's reasoner (if the agent streams) so
  // the REPL knows when the final answer already streamed to the output — in
  // that case printOutcome must not re-print it, just close the line.
  if (typeof onToken === 'function' && agent.reasoner && typeof agent.reasoner.setTokenSink === 'function') {
    agent.reasoner.setTokenSink((text) => {
      session.streamedThisTurn = true;
      try {
        onToken(text);
      } catch (_err) {
        // a broken token consumer must never break a turn
      }
    });
  }

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      output.write(prompt);
      const { value: line, done } = await lines.next();
      if (done) break;

      const trimmed = line.trim();
      if (!trimmed) continue;

      if (trimmed.startsWith('/')) {
        log.debug('repl:command', { line: trimmed });
        const stop = await handleCommand(trimmed, { agent, systemPrompt, output, session });
        if (stop) break;
        continue;
      }

      log.info('repl:turn:start', { input: trimmed });
      session.streamedThisTurn = false;
      try {
        const outcome = await agent.run(trimmed);
        log.info('repl:turn:done', { status: outcome.status, steps: outcome.steps });
        printOutcome(outcome, output, session);
      } catch (err) {
        log.error('repl:turn:failed', { error: err && err.message });
        output.write(`[error] ${err && err.message ? err.message : err}\n`);
      }
    }
  } finally {
    rl.close();
  }
}

async function handleCommand(line, { agent, systemPrompt, output, session }) {
  const [cmd, ...rest] = line.split(/\s+/);
  switch (cmd) {
    case '/exit':
    case '/quit':
      output.write('bye.\n');
      return true;
    case '/help':
      output.write(`${HELP_TEXT}\n`);
      return false;
    case '/system':
      output.write(`${systemPrompt || '(no system prompt set)'}\n`);
      return false;
    case '/history': {
      const rendered = agent.context.render();
      output.write(`${JSON.stringify(rendered, null, 2)}\n`);
      return false;
    }
    case '/scratchpad':
      output.write(`${renderScratchpad(agent.getStepMemory())}\n`);
      return false;
    case '/tools': {
      const list = agent.tools.list();
      output.write(
        `${list.map((t) => `  ${t.name}${t.requiresApproval ? ' (approval)' : ''} — ${(t.description || '').split('\n')[0]}`).join('\n')}\n`
      );
      return false;
    }
    case '/reset':
      agent.context.clear();
      if (typeof agent.reasoner.reset === 'function') agent.reasoner.reset();
      session.pendingApprovalCheckpoint = null;
      output.write('conversation memory cleared.\n');
      return false;
    case '/approve':
    case '/deny': {
      if (!session.pendingApprovalCheckpoint) {
        output.write('nothing is currently awaiting tool approval.\n');
        return false;
      }
      const approved = cmd === '/approve';
      const reason = approved ? undefined : rest.join(' ') || undefined;
      const checkpoint = session.pendingApprovalCheckpoint;
      session.pendingApprovalCheckpoint = null;
      try {
        const outcome = await agent.resumeWithApproval(checkpoint, approved, { reason });
        printOutcome(outcome, output, session);
      } catch (err) {
        output.write(`[error] ${err && err.message ? err.message : err}\n`);
      }
      return false;
    }
    default:
      output.write(`unknown command "${cmd}". Type /help for the list.\n`);
      return false;
  }
}

function printOutcome(outcome, output, session = {}) {
  switch (outcome.status) {
    case 'final':
      // If the answer already streamed token-by-token during the run, only
      // close the line — printing the content again would duplicate it.
      if (session.streamedThisTurn) {
        output.write('\n');
        return;
      }
      output.write(`${outcome.content}\n`);
      return;
    case 'need_clarification':
      output.write(`[clarify] ${outcome.question}\n`);
      return;
    case 'awaiting_tool_approval':
      session.pendingApprovalCheckpoint = outcome.checkpoint;
      output.write(
        `[awaiting approval] tool "${outcome.pendingApproval.tool}"(${JSON.stringify(outcome.pendingApproval.args)}) needs approval.\n` +
          'Type /approve to run it or /deny [reason] to reject it.\n'
      );
      return;
    case 'error':
      output.write(`[error] ${outcome.error}\n`);
      return;
    case 'max_steps':
      output.write('[loop ended: reached max steps without a final answer]\n');
      return;
    case 'aborted':
      output.write('[loop aborted]\n');
      return;
    default:
      output.write(`[loop ended: ${outcome.status}]\n`);
  }
}

export default runRepl;
