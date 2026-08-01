/**
 * kernel/logger.js — pino-style shim over the shared logger
 * -----------------------------------------------
 * The memory layers were lifted from a larger runtime that shared one
 * kernel logger (`childLogger(name)` -> `{info,warn,error}`, called
 * pino-style as `log.warn({ err, ... }, "message")` or `log.info("message")`).
 * Rather than keep a second, divergent logging implementation, this shim
 * now forwards every call into src/core/logger.js so memory-layer log lines get
 * the same structured shape (state/params/output, redaction, level
 * filtering via SCRAPPYAI_LOG_LEVEL, json/pretty via SCRAPPYAI_LOG_FORMAT)
 * as the core loop/tools/context/reasoner — one logger, one set of env
 * knobs, everywhere in ScrappyAi.
 *
 * SCRAPPYAI_MEMORY_LOG=false remains a memory-specific silence switch (on
 * top of the global SCRAPPYAI_LOG=false) so a Redis fallback stays quiet in
 * tests without turning off logging for the rest of the agent.
 */

import { createLogger } from '../../core/logger.js';

function memorySilenced() {
  return String(process.env.SCRAPPYAI_MEMORY_LOG).toLowerCase() === 'false';
}

/** Normalize the two pino call shapes memory layers use into {event, fields}. */
function toEventAndFields(args) {
  const [first, second] = args;
  if (typeof first === 'string') {
    return { event: first, fields: {} };
  }
  if (first && typeof first === 'object') {
    return { event: typeof second === 'string' && second ? second : 'log', fields: first };
  }
  return { event: 'log', fields: { args } };
}

export function childLogger(name) {
  const log = createLogger(`memory:${name}`);
  return {
    info: (...args) => {
      if (memorySilenced()) return;
      const { event, fields } = toEventAndFields(args);
      log.info(event, fields);
    },
    warn: (...args) => {
      if (memorySilenced()) return;
      const { event, fields } = toEventAndFields(args);
      log.warn(event, fields);
    },
    error: (...args) => {
      if (memorySilenced()) return;
      const { event, fields } = toEventAndFields(args);
      log.error(event, fields);
    },
  };
}

export default childLogger;
