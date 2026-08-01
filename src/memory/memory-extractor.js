// ── Memory Extractor ──
// Turns a raw conversation turn into durable facts, the way a real agent
// remembers things: not "the last 40 messages happen to still be in the
// buffer", but an actual extraction step that looks at what the user just
// said, decides whether it contains something worth remembering (a name,
// a preference, a standing decision, a fact about the project), and
// promotes it into long-term + semantic memory keyed by userId — so it
// survives across sessions and across every mode (fast/light/deep) alike,
// not just within the one session it was said in.
//
// Two-stage to stay cheap: a fast local trigger check (no model call at
// all) decides whether a message plausibly contains a self-disclosure
// worth extracting; only then does it spend one small, temperature-0
// model call to pull a clean structured fact out of it. Plain chit-chat
// ("thanks", "ok", "what's 2+2") never reaches the model call.

import { childLogger } from './kernel/logger.js';

const log = childLogger('memory-extractor');

const TRIGGER_PATTERNS = [
  /\bmy name is\b/i, /\bcall me\b/i, /\bi(?:'m| am)\s+\d/i, /\bi work at\b/i, /\bi live in\b/i,
  /\bi prefer\b/i, /\bremember that\b/i, /\bremember,?\s+i\b/i, /\bfor future reference\b/i,
  /\bmy (?:favorite|favourite|birthday|email|phone|role|job|title)\b/i, /\bi'm allergic\b/i,
  /اسم(م| من)/, /من\s+[\u0600-\u06FF]{2,30}\s+هستم/, /یادت باشه/, /یادت بمونه/, /ترجیح می[‌ ]?دم/,
  /ترجیح میدم/, /کار می[‌ ]?کنم/, /زندگی می[‌ ]?کنم/, /شغلم/, /تولدم/, /ایمیلم/, /شماره[‌ ]?ام/,
];

const EXTRACTION_SYSTEM_PROMPT = `You extract durable personal facts about the USER from a chat message, for long-term memory.
Return ONLY a JSON array (no prose, no markdown fences). Each item: {"key": "snake_case_id", "value": "short factual statement", "tags": ["..."], "importance": 0.0-1.0, "confidence": 0.0-1.0, "source": "explicit"|"inferred"|"assumed"}.
Rules:
- Only include facts that are durable and about the user (identity, name, preferences, role, standing decisions, stable context) — never transient chit-chat, questions, or facts about the assistant.
- "key" must be stable/reusable across time for the same fact (e.g. "user_name", "user_role", "user_preference_language"). Use the same key every time the same kind of fact appears so it upserts instead of duplicating.
- "value" should read as a plain fact in the third person, e.g. "The user's name is Amir." not a quote.
- "source" MUST be "explicit" only when the user is stating this fact directly and unconditionally about themselves right now (e.g. "my name is Amir", "I prefer Python"). Use "inferred" when you're deducing it from context/behavior. Use "assumed" for hypotheticals, jokes, conditionals ("if my name were...", "let's pretend I..."), quoting someone else, or anything not a direct current statement about the user themselves.
- "confidence" reflects how sure you are this is true and durable: 1.0 for a plain direct statement, 0.5-0.7 for a reasonable inference, below 0.4 for a guess or something you're unsure survives past this turn. A hypothetical/conditional/joke MUST get source "assumed" and confidence below 0.3 — when in doubt about whether something is a genuine disclosure vs. a hypothetical, prefer "assumed" and low confidence over guessing "explicit".
- If there is nothing durable to extract, return [].
- Respond in the same language the fact was stated in for the "value" field.`;

// Facts below this confidence never get promoted at all — a low-confidence
// guess (hypothetical, heavily hedged, "assumed" source) shouldn't even
// reach long-term memory to become a pending-confirmation record; it's
// simply not durable enough to be worth storing yet.
const MIN_PROMOTION_CONFIDENCE = 0.35;

function localTriggerMatches(text) {
  return TRIGGER_PATTERNS.some(p => p.test(text));
}

/**
 * Deterministic, model-free extraction of the most common durable facts.
 * Only consulted when the trigger regexes matched AND the model call failed
 * or returned nothing — plain chit-chat never reaches this (the trigger
 * gate still applies). Facts are always source:'explicit', confidence 1:
 * the user is stating them directly, and no model is second-guessing.
 */
const LOCAL_FACT_PATTERNS = [
  {
    key: 'user_name',
    re: /\bmy name is\s+([A-Za-z\u0600-\u06FF][\w\u0600-\u06FF .'-]{1,60})/i,
    value: (m) => `The user's name is ${m[1].trim()}.`,
    importance: 0.9,
  },
  {
    key: 'user_email',
    re: /\bmy email is\s+([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i,
    value: (m) => `The user's email is ${m[1].trim()}.`,
    importance: 0.8,
  },
  {
    key: 'user_phone',
    re: /\bmy phone number is\s+([+\d][\d\s-]{6,20})/i,
    value: (m) => `The user's phone number is ${m[1].trim()}.`,
    importance: 0.8,
  },
  {
    key: 'user_city',
    re: /\bi live in\s+([A-Za-z\u0600-\u06FF][^.,!?\n]{1,60})/i,
    value: (m) => `The user lives in ${m[1].trim()}.`,
    importance: 0.7,
  },
  {
    key: 'user_role',
    re: /\bi work (?:as|at)\s+(?:an? |a )?([^.,!?\n]{2,60})/i,
    value: (m) => `The user works as ${m[1].trim()}.`,
    importance: 0.8,
  },
  {
    key: 'user_preference',
    re: /\bi prefer\s+([^.,!?\n]{2,60})/i,
    value: (m) => `The user prefers ${m[1].trim()}.`,
    importance: 0.7,
  },
  {
    key: 'user_birthday',
    re: /\bmy birthday is\s+([^.,!?\n]{3,40})/i,
    value: (m) => `The user's birthday is ${m[1].trim()}.`,
    importance: 0.7,
  },
];

function localExtractFacts(text) {
  const facts = [];
  for (const p of LOCAL_FACT_PATTERNS) {
    const m = p.re.exec(text);
    if (!m) continue;
    facts.push({
      key: p.key,
      value: p.value(m),
      tags: ['identity'],
      importance: p.importance,
      confidence: 1,
      source: 'explicit',
    });
  }
  return facts;
}

function safeParseFactArray(raw) {
  if (!raw || typeof raw !== 'string') return [];
  const trimmed = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = trimmed.indexOf('[');
  const end = trimmed.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return [];
  try {
    const parsed = JSON.parse(trimmed.slice(start, end + 1));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(f => f && typeof f.value === 'string' && f.value.trim().length > 0)
      .map(f => ({
        key: typeof f.key === 'string' && f.key.trim() ? f.key.trim().slice(0, 64) : undefined,
        value: f.value.trim().slice(0, 500),
        tags: Array.isArray(f.tags) ? f.tags.filter(t => typeof t === 'string').slice(0, 6) : [],
        importance: typeof f.importance === 'number' ? Math.max(0, Math.min(1, f.importance)) : 0.7,
        confidence: typeof f.confidence === 'number' ? Math.max(0, Math.min(1, f.confidence)) : 0.7,
        source: ['explicit', 'inferred', 'assumed'].includes(f.source) ? f.source : 'inferred',
      }));
  } catch {
    return [];
  }
}

export class MemoryExtractor {
  constructor({ memoryManager, providerRegistry }) {
    this.memoryManager = memoryManager;
    this.providerRegistry = providerRegistry;
  }

  /**
   * @param {{ userId: string, sessionId: string, projectId?: string, userMessage: string }} turn
   * @returns {Promise<{ checked: boolean, factsPromoted: number, facts: Array }>}
   */
  async extractFromTurn({ userId, projectId, sessionId, turnId, userMessage }) {
    const text = String(userMessage ?? '').trim();
    if (!text || !localTriggerMatches(text)) {
      return { checked: false, factsPromoted: 0, facts: [] };
    }

    let facts = [];
    let modelOk = true;
    try {
      const provider = this.providerRegistry.getDefault();
      const result = await provider.generate({
        model: 'fast',
        temperature: 0,
        maxTokens: 400,
        messages: [
          { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
          { role: 'user', content: text },
        ],
      });
      facts = safeParseFactArray(result.message?.content);
      if (facts.length === 0) modelOk = false; // nothing durable per the model
    } catch (err) {
      log.warn({ err: err.message, userId, sessionId }, 'Memory extraction model call failed — falling back to local patterns');
      modelOk = false;
    }

    // --- Local fallback: the model call failed or found nothing, but the
    // trigger regexes matched. Extract the common durable facts directly
    // with deterministic patterns (name/email/phone/city/role/preference),
    // so "my name is X" survives even with a broken/absent model — memory
    // between sessions must not depend on one upstream call.
    if (!modelOk) {
      facts = localExtractFacts(text);
      if (facts.length > 0) {
        log.info({ userId, sessionId, keys: facts.map(f => f.key) }, 'Local pattern extraction recovered durable facts');
      }
    }

    let promoted = 0;
    for (const fact of facts) {
      if (fact.confidence < MIN_PROMOTION_CONFIDENCE) {
        log.info({ userId, key: fact.key, confidence: fact.confidence, source: fact.source }, 'Dropped low-confidence extracted fact — not promoted');
        continue;
      }
      try {
        await this.memoryManager.promote({
          userId, projectId,
          text: fact.value,
          key: fact.key,
          tags: fact.tags,
          importance: fact.importance,
          confidence: fact.confidence,
          source: fact.source,
          turnId,
        });
        promoted++;
      } catch (err) {
        log.warn({ err: err.message, userId, key: fact.key }, 'Failed to promote extracted fact');
      }
    }

    if (promoted) {
      log.info({ userId, sessionId, count: promoted, keys: facts.map(f => f.key) }, 'Extracted and promoted durable facts from a turn');
    }

    return { checked: true, factsPromoted: promoted, facts };
  }
}
