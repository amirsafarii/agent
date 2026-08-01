/**
 * evaluation/index.js — Evaluation / Critic layer + Goal completion detector
 * ---------------------------------------------------------------------------
 * Adds the missing fourth stage to the think → act → observe loop:
 *
 *   think → act → observe → evaluate → continue / repair / finish
 *
 * The two concepts here are deliberately kept separate from the deterministic
 * verification layer (src/verification/):
 *
 *   Verification  — REAL, deterministic: does the file exist? does the test
 *                   pass? is the JSON valid? exit code 0? required text present?
 *   Evaluation    — REASONED: does this actually solve the user's goal? is the
 *                   output complete? did we misunderstand the requirement?
 *
 *                 ┌── Verification
 *   Observation ───┤
 *                 └── Evaluation  →  Decision (continue / repair / finish)
 *
 * This module exposes:
 *
 *   Evidence      — structured claim + evidence list (provenance): instead of
 *                   "I think it works", an agent can say "Verified: npm test →
 *                   152 passed". Each evidence item is {type, command, output}.
 *
 *   GoalState     — the goal completion detector. Requirements are tracked as
 *                   {description, satisfied, evidence}; before final the agent
 *                   can prove the goal is satisfied (satisfied vs unsatisfied).
 *
 *   EvaluationEngine — the critic. evaluate({goal, action, observation,
 *                   expected}) → {success, confidence, reason, next}. The
 *                   critic is pluggable (pass an LLM-backed `critic` fn); the
 *                   default is deterministic and never hallucinates a pass: a
 *                   claim only counts as satisfied when supported by
 *                   verification evidence.
 *
 * Pure JavaScript (ES modules). No TypeScript, no build step.
 */

import { createHash } from 'node:crypto';

/** Fixed next-step vocabulary an evaluation can return. */
export const EvalNext = Object.freeze({
  CONTINUE: 'continue', // keep acting, more work remains
  REPAIR: 'repair', // current approach failed, fix and retry
  FINISH: 'finish', // goal satisfied, produce final answer
});

/**
 * Build a claim with provenance.
 * @param {string} claim - the assertion being made (e.g. "server runs on port 3000")
 * @param {Array<Object>} [evidence] - list of {type, command, output, ...} supporting the claim
 * @returns {{claim: string, evidence: Object[]}}
 */
export function evidenceOf(claim, evidence = []) {
  const list = (evidence || []).map((e) => {
    if (!e || typeof e !== 'object') return { type: 'other', output: String(e) };
    const { type = 'other', command, output, path, exitCode, stdout, stderr } = e;
    return {
      type,
      ...(command != null ? { command } : {}),
      ...(path != null ? { path } : {}),
      ...(exitCode != null ? { exitCode } : {}),
      output: output ?? stdout ?? stderr ?? '',
    };
  });
  return { claim: String(claim), evidence: list };
}

/**
 * Goal completion detector. Requirements are checked one by one; `satisfied`
 * and `unsatisfied` always reflect the current verdict. A goal is only
 * "satisfied" when every requirement is satisfied with supporting evidence.
 */
export class GoalState {
  /**
   * @param {Object} [opts]
   * @param {string} [opts.goal]
   * @param {Array<Object>} [opts.requirements] - [{id, description}]
   */
  constructor({ goal = '', requirements = [] } = {}) {
    this.goal = String(goal);
    this.requirements = (requirements || []).map((r, i) => ({
      id: r.id != null ? String(r.id) : `req_${i + 1}`,
      description: String(r.description || r.text || r || ''),
      satisfied: false,
      evidence: [],
    }));
    this._refresh();
  }

  _refresh() {
    this.satisfied = this.requirements.filter((r) => r.satisfied);
    this.unsatisfied = this.requirements.filter((r) => !r.satisfied);
  }

  /** Add a requirement. @returns {this} */
  addRequirement(description, opts = {}) {
    this.requirements.push({
      id: String(opts.id || `req_${this.requirements.length + 1}`),
      description: String(description),
      satisfied: false,
      evidence: [],
    });
    this._refresh();
    return this;
  }

  /** Normalize evidence input: an array of items, or an evidenceOf() object. */
  static _evidenceItems(evidence) {
    if (Array.isArray(evidence)) return evidence;
    if (evidence && typeof evidence === 'object' && Array.isArray(evidence.evidence)) return evidence.evidence;
    return [];
  }

  /** Mark a requirement satisfied, attaching provenance. */
  markSatisfied(id, evidence = []) {
    const r = this.requirements.find((x) => x.id === id);
    if (!r) return this;
    r.satisfied = true;
    const items = GoalState._evidenceItems(evidence);
    if (items.length) r.evidence.push(...items);
    this._refresh();
    return this;
  }

  /** Mark a requirement unsatisfied (optionally with a reason). */
  markUnsatisfied(id, evidence = []) {
    const r = this.requirements.find((x) => x.id === id);
    if (!r) return this;
    r.satisfied = false;
    const items = GoalState._evidenceItems(evidence);
    if (items.length) r.evidence.push(...items);
    this._refresh();
    return this;
  }

  /** Can the goal be proven satisfied? (every requirement satisfied) */
  isSatisfied() {
    return this.requirements.length > 0 && this.unsatisfied.length === 0;
  }

  /** Goal-state summary suitable for the reasoner / final result. */
  summary() {
    return {
      goal: this.goal,
      satisfiedCount: this.satisfied.length,
      unsatisfiedCount: this.unsatisfied.length,
      requirements: this.requirements.map((r) => ({
        id: r.id,
        description: r.description,
        satisfied: r.satisfied,
        evidence: r.evidence,
      })),
      isSatisfied: this.isSatisfied(),
    };
  }

  toJSON() {
    return this.summary();
  }

  static fromJSON(data) {
    const gs = new GoalState({ goal: data?.goal, requirements: data?.requirements });
    for (const r of data?.requirements || []) {
      if (r.satisfied) gs.markSatisfied(r.id, r.evidence || []);
    }
    return gs;
  }
}

/** Clamp a number into [0, 1]. */
function clamp01(n) {
  return typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
}

/**
 * EvaluationEngine — the critic.
 *
 * `evaluate({goal, action, observation, expected, verification})` returns
 *   {success, confidence, reason, next}
 * where next ∈ EvalNext. Pass a custom async `critic` to override the default
 * heuristic with an LLM judgement; otherwise a deterministic default is used
 * that only declares success when verification evidence backs it up.
 */
export class EvaluationEngine {
  /**
   * @param {Object} [opts]
   * @param {Function} [opts.critic] async ({goal, action, observation, expected,
   *        verification}) => {success?, confidence?, reason?, next?} — if omitted,
   *        the deterministic default critic is used.
   */
  constructor(opts = {}) {
    this.critic = typeof opts.critic === 'function' ? opts.critic : defaultCritic;
  }

  /**
   * Evaluate the outcome of an act/observe cycle against the goal.
   * @param {Object} p
   * @param {string} p.goal
   * @param {Object} [p.action] the action that was taken
   * @param {*} [p.observation] the (uncompressed) tool result / observed state
   * @param {string|RegExp} [p.expected] expected outcome, if known
   * @param {Object} [p.verification] a verification suite result ({ok, passed, failed})
   * @returns {Promise<{success:boolean, confidence:number, reason:string, next:string}>}
   */
  async evaluate({ goal, action, observation, expected, verification }) {
    let out;
    try {
      out = await this.critic({ goal, action, observation, expected, verification });
    } catch (err) {
      out = { success: false, confidence: 0.1, reason: `critic error: ${err.message}` };
    }
    if (!out || typeof out !== 'object') {
      out = { success: false, confidence: 0.1, reason: 'critic returned no verdict' };
    }
    const success = out.success === true;
    const confidence = clamp01(out.confidence);
    const reason = String(out.reason || (success ? 'goal satisfied' : 'goal not yet satisfied'));
    // Normalize `next`; default is guided by success.
    let next = out.next;
    if (!Object.values(EvalNext).includes(next)) {
      next = success ? EvalNext.FINISH : EvalNext.REPAIR;
    }
    return { success, confidence, reason, next };
  }
}

/**
 * Deterministic default critic. No hallucination: a claim only becomes
 * "success" when there is positive verification evidence, or when the
 * observation literally matches the expected outcome. Everything else is a
 * low-confidence "continue" or "repair".
 */
async function defaultCritic({ goal, action, observation, expected, verification }) {
  // Verification (deterministic) is the highest-confidence signal.
  if (verification) {
    if (verification.ok === true) {
      return {
        success: true,
        confidence: 0.97,
        reason: `verification passed (${verification.passed ?? 0}/${verification.total ?? 0})`,
        next: EvalNext.FINISH,
      };
    }
    return {
      success: false,
      confidence: 0.25,
      reason: `verification failed (${verification.failed ?? 0} failing check(s))`,
      next: EvalNext.REPAIR,
    };
  }

  // If an expected outcome is given and the observation matches it.
  if (expected != null && observation != null) {
    const obsStr = typeof observation === 'string' ? observation : JSON.stringify(observation);
    let matched = false;
    if (expected instanceof RegExp) {
      matched = expected.test(obsStr);
    } else {
      matched = typeof expected === 'string' ? obsStr.includes(expected) : JSON.stringify(expected) === obsStr;
    }
    if (matched) {
      return {
        success: true,
        confidence: 0.9,
        reason: `observation matches expected outcome "${String(expected)}"`,
        next: EvalNext.FINISH,
      };
    }
    return {
      success: false,
      confidence: 0.3,
      reason: `observation does not match expected outcome "${String(expected)}"`,
      next: EvalNext.REPAIR,
    };
  }

  // No verifiable signal: the agent cannot prove the goal is met, so it should
  // not claim success. Continue acting.
  return {
    success: false,
    confidence: 0.1,
    reason: `no verification evidence for goal: "${goal || '(unspecified)'}"`,
    next: EvalNext.CONTINUE,
  };
}

/** Stable sha256 of a string — used for artifact checksums. */
export function sha256(text) {
  return createHash('sha256').update(String(text)).digest('hex');
}
