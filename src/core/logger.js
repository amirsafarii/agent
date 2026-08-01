/**
 * core/logger.js — structured logger for ScrappyAi
 * -----------------------------------------------
 * One logger, used everywhere: the core loop, tools, context, reasoner,
 * clients/9router.js, index.js, repl.js, and (via a thin compat shim) the
 * memory layers. Every call site is one of `.debug/.info/.warn/.error(event,
 * fields)` — `event` is a short machine-stable name ("execute:start",
 * "step:think", "compact:done", ...) and `fields` is a plain object that
 * always answers three questions for that line: what state was the
 * component in, what parameters/input drove this, and what output/result
 * came out (plus timing, when relevant). Nothing gets logged as a bare
 * string with no structure — that's the whole point of having one logger
 * instead of ad hoc console.log calls scattered through the codebase.
 *
 * Env knobs (all optional, sane defaults — see .env.example):
 *   SCRAPPYAI_LOG=false          fully silence all logging (tests/CI)
 *   SCRAPPYAI_LOG_LEVEL=debug    debug | info | warn | error (default: info)
 *   SCRAPPYAI_LOG_FORMAT=json    json | pretty (default: pretty)
 *
 * Both are read fresh on every log call (not cached at import time) so
 * tests can flip them per-case and so a long-running process picks up an
 * env change without a restart.
 *
 * Secrets never leak into logs: any field whose key looks like
 * key/token/secret/password/authorization is replaced with "[REDACTED]"
 * recursively, and long strings are truncated so one giant tool result
 * doesn't flood stdout.
 *
 * Pure JavaScript (ES modules). No dependency — console is the only sink,
 * which keeps this usable standalone (tests, CI, a bare `node src/index.js`)
 * without wiring a log shipper first. Swap the sink later by replacing
 * `write()` if one is ever needed.
 */

const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40, silent: 100 });

// Deliberately specific rather than a bare /key|token/ substring match: a
// broad pattern would also swallow perfectly safe, high-signal fields like
// usedTokens/maxTokens/totalTokens (context-window token counts) or
// toolCallId. Only credential-shaped keys get redacted.
const SENSITIVE_KEY_PATTERN =
  /(api[-_]?key|secret|passwd|password|authorization|access[-_]?token|refresh[-_]?token|auth[-_]?token|session[-_]?token|bearer)/i;

function isSensitiveKey(key) {
  const normalized = String(key).toLowerCase();
  if (normalized === 'token') return true;
  return SENSITIVE_KEY_PATTERN.test(normalized);
}

const MAX_STRING_LEN = 800;
const MAX_DEPTH = 5;

function resolveLevel() {
  if (String(process.env.SCRAPPYAI_LOG).toLowerCase() === 'false') return LEVELS.silent;
  const raw = (process.env.SCRAPPYAI_LOG_LEVEL || 'info').toLowerCase();
  return Object.prototype.hasOwnProperty.call(LEVELS, raw) ? LEVELS[raw] : LEVELS.info;
}

function resolveFormat() {
  return (process.env.SCRAPPYAI_LOG_FORMAT || 'pretty').toLowerCase() === 'json' ? 'json' : 'pretty';
}

/** Deep-redact secrets and clip oversized strings so logs stay safe and readable. */
export function sanitize(value, depth = 0) {
  if (depth > MAX_DEPTH) return '[max depth]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return value.length > MAX_STRING_LEN
      ? `${value.slice(0, MAX_STRING_LEN)}...[truncated ${value.length - MAX_STRING_LEN} chars]`
      : value;
  }
  if (value instanceof Error) {
    return { name: value.name, message: value.message, code: value.code, stack: value.stack };
  }
  if (Array.isArray(value)) {
    const capped = value.length > 20 ? value.slice(0, 20) : value;
    const out = capped.map((v) => sanitize(v, depth + 1));
    if (value.length > 20) out.push(`...[+${value.length - 20} more]`);
    return out;
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = isSensitiveKey(k) ? '[REDACTED]' : sanitize(v, depth + 1);
    }
    return out;
  }
  return value; // number, boolean, function (rendered as-is/ignored by JSON.stringify)
}

function prettyLine(entry) {
  const { ts, level, component, event, ...rest } = entry;
  const bits = Object.entries(rest)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : safeStringify(v)}`)
    .join(' ');
  return `${ts} ${level.toUpperCase().padEnd(5)} [${component}] ${event}${bits ? `  ${bits}` : ''}`;
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch (_err) {
    return String(value);
  }
}

function sink(level) {
  if (level === 'error') return console.error;
  if (level === 'warn') return console.warn;
  return console.log;
}

function emit(component, level, event, fields) {
  const threshold = resolveLevel();
  if (LEVELS[level] < threshold) return null;

  const entry = {
    ts: new Date().toISOString(),
    level,
    component,
    event,
    ...sanitize(fields || {}),
  };

  const stream = sink(level);
  stream(resolveFormat() === 'json' ? JSON.stringify(entry) : prettyLine(entry));
  return entry;
}

/**
 * Create a logger scoped to one component (e.g. "loop", "tools:shell",
 * "memory:redis"). Every method takes a short event name plus a fields
 * object — never a bare printf-style string — so every log line is
 * grep-able/parseable the same way regardless of call site.
 *
 * @param {string} component
 */
export function createLogger(component) {
  return {
    debug: (event, fields) => emit(component, 'debug', event, fields),
    info: (event, fields) => emit(component, 'info', event, fields),
    warn: (event, fields) => emit(component, 'warn', event, fields),
    error: (event, fields) => emit(component, 'error', event, fields),
    /** Scoped child logger, e.g. createLogger('tools').child('shell') -> "tools:shell". */
    child: (subComponent) => createLogger(`${component}:${subComponent}`),
  };
}

export default createLogger;
