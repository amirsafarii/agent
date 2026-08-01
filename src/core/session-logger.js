/**
 * session-logger.js — per-session debug log files
 * -----------------------------------------------
 * `logger.js` writes to stdout/stderr only — great for `docker logs`/CI, bad
 * for "what exactly did this one session do six hours ago". SessionLogger
 * fixes that: every AgentLoop run tied to a sessionId gets its own folder
 * under `logs/<sessionId>/` with two files that are ALWAYS written
 * (independent of SCRAPPYAI_LOG/SCRAPPYAI_LOG_LEVEL, which only gate the
 * console):
 *
 *   events.jsonl     one JSON object per line, every onEvent(...) AgentLoop
 *                    ever emits for this session, plus tool/context
 *                    input/output when wireSessionLogger() sees them
 *                    (nothing summarized, nothing dropped — full fidelity)
 *   transcript.log   the same stream, rendered human-readable (one block per
 *                    step: Thought / Tool Call / Observation / Final Answer),
 *                    so `tail -f logs/<id>/transcript.log` is a legible replay
 *
 * Pure JavaScript (ES modules). fs/promises only, no dependency.
 */

import { mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from './logger.js';

const log = createLogger('session-logger');

const DEFAULT_ROOT = process.env.SCRAPPYAI_LOG_DIR || 'logs';

export class SessionLogger {
  /**
   * @param {Object} opts
   * @param {string} opts.sessionId
   * @param {string} [opts.rootDir] Defaults to SCRAPPYAI_LOG_DIR env or "logs".
   */
  constructor({ sessionId, rootDir = DEFAULT_ROOT } = {}) {
    if (!sessionId) throw new Error('SessionLogger requires a sessionId.');
    this.sessionId = sessionId;
    this.dir = join(rootDir, safeSegment(sessionId));
    this.eventsPath = join(this.dir, 'events.jsonl');
    this.transcriptPath = join(this.dir, 'transcript.log');
    try {
      mkdirSync(this.dir, { recursive: true });
    } catch (err) {
      log.warn('init:mkdir_failed', { dir: this.dir, error: err.message });
    }
    this._seq = 0;
    this._writeTranscript(`===== session ${sessionId} started ${new Date().toISOString()} =====\n`);
  }

  /**
   * Record one structured event. Never throws (a broken log write must never
   * take a running agent down with it).
   * @param {string} event
   * @param {object} payload
   * @param {'loop'|'tool'|'context'|'reasoner'|string} [source='loop']
   */
  log(event, payload = {}, source = 'loop') {
    this._seq += 1;
    const entry = { seq: this._seq, ts: new Date().toISOString(), source, event, payload };
    this._appendJsonl(entry);
    this._writeTranscript(renderTranscriptLine(entry));
    return entry;
  }

  /** Record a full StepRecord (see docs/LOOP.md) exactly as AgentLoop produced it — nothing trimmed. */
  logStep(record) {
    return this.log('step_record', record, 'loop');
  }

  _appendJsonl(entry) {
    try {
      appendFileSync(this.eventsPath, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch (err) {
      log.warn('write:events_failed', { error: err.message });
    }
  }

  _writeTranscript(line) {
    try {
      appendFileSync(this.transcriptPath, line.endsWith('\n') ? line : `${line}\n`, 'utf8');
    } catch (err) {
      log.warn('write:transcript_failed', { error: err.message });
    }
  }
}

function safeSegment(value) {
  return String(value).replace(/[^a-zA-Z0-9_.-]/g, '_') || 'session';
}

/** Human-readable one-to-a-few-line rendering of a single logged event, for transcript.log. */
function renderTranscriptLine({ ts, source, event, payload }) {
  const head = `[${ts}] (${source}) ${event}`;
  switch (event) {
    case 'think':
      return `${head}\n  action: ${payload.action ? payload.action.type : '?'}${payload.action && payload.action.tool ? ` -> ${payload.action.tool}` : ''}\n`;
    case 'act':
      return `${head}\n  tool: ${payload.tool}(${safeJson(payload.args)})\n`;
    case 'observe':
      return `${head}\n  tool: ${payload.tool} ok=${payload.result && payload.result.ok} attempts=${payload.attempts}\n  output: ${safeJson(payload.result && (payload.result.ok ? payload.result.data : payload.result.error))}\n`;
    case 'final':
      return `${head}\n  content: ${payload.content}\n`;
    case 'error':
      return `${head}\n  phase: ${payload.phase}  error: ${safeJson(payload.error)}\n`;
    default:
      return `${head}  ${safeJson(payload)}\n`;
  }
}

function safeJson(value) {
  try {
    const s = JSON.stringify(value);
    return s && s.length > 2000 ? `${s.slice(0, 2000)}...[truncated]` : s;
  } catch (_err) {
    return String(value);
  }
}

/**
 * Wire a SessionLogger onto an AgentLoop instance: forwards every onEvent
 * call and every recorded step to it, without replacing an existing
 * onEvent (both fire). Returns the loop for chaining.
 * @param {import('./loop/index.js').AgentLoop} loop
 * @param {SessionLogger} sessionLogger
 */
export function attachSessionLogger(loop, sessionLogger) {
  const previousOnEvent = loop.onEvent;
  loop.onEvent = (event, payload) => {
    sessionLogger.log(event, payload, 'loop');
    if (typeof previousOnEvent === 'function') previousOnEvent(event, payload);
  };
  loop.sessionLogger = sessionLogger;
  return loop;
}

export default SessionLogger;
