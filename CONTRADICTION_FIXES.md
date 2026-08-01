# Contradiction Fixes & System Prompt Improvement Report

## Summary
Identified and fixed **14 contradictions** across the core loop and supporting modules, plus a complete rewrite of the system prompt to production quality (Claude Code / Hermes Agent / Alfera Agent level).

---

## Contradictions Fixed

### 1. ❌ Retry Policy vs. System Prompt (CRITICAL)
**Files:** `src/core/loop/retry-policy.js`, `src/tools/registry.js`

**Contradiction:** The system prompt says "Fallback Rule: network error / timeout / DNS → do NOT retry, pivot immediately." But `retry-policy.js` had `web_search` retrying on `HTTP_ERROR`, `REQUEST_FAILED`, `TOOL_TIMEOUT`, and `registry.js` `RETRYABLE_ERROR_CODES` included `ECONNRESET`, `ECONNREFUSED`, `ETIMEDOUT`, `ENOTFOUND`, `REQUEST_FAILED`, `TIMEOUT` — ALL the errors the prompt says should NOT be retried.

**Fix:** Removed all network/timeout/DNS codes from retryable errors in both files. Only `TOOL_EXECUTION_ERROR` and `EXECUTION_ERROR` are retryable (generic execution failures that a retry might fix).

---

### 2. ❌ State Machine Silent Error Swallowing
**File:** `src/core/loop/agent-loop.js`

**Contradiction:** The design goal says "fails loud with an explicit termination reason rather than spinning silently forever." But `_safeTransition()` logged invalid transitions as `log.warn()` — effectively hiding state machine bugs.

**Fix:** Changed to `log.error()` and added `this._emit(LoopEvents.ERROR, ...)` so invalid transitions are surfaced through the observability pipeline.

---

### 3. ❌ Parallel Tool Call Fingerprinting
**File:** `src/core/loop/agent-loop.js`

**Contradiction:** `_fingerprint()` for parallel batches only used the first tool name and a list of tool names (not individual args). Two parallel batches with the same tool names but different args were treated as identical by the stuck-loop guard.

**Fix:** Rewrote `_fingerprint()` to include each tool's individual args using `normalizeArgs()` for parallel batches.

---

### 4. ❌ Parallel Tool Overuse Tracking
**File:** `src/core/loop/agent-loop.js`

**Contradiction:** The tool-overuse guard only tracked `action.tool` (first tool in parallel batch). Other tools in a parallel batch were never counted toward their overuse limits.

**Fix:** Changed the overuse guard to count EACH tool in a parallel batch, not just the first one.

---

### 5. ❌ Tool Overuse Guard Too Low for Adaptive Budget
**Files:** `src/core/loop/agent-loop.js`, `src/index.js`

**Contradiction:** Adaptive budget can grow to 80 steps, but `maxToolCallsPerTool` was only 8 (constant) / 12 (env default). A legitimate multi-file project calling `write_file` 13+ times would be killed even though the adaptive budget explicitly allowed more steps.

**Fix:** Bumped `DEFAULT_MAX_TOOL_CALLS_PER_TOOL` from 8 to 20 and the buildAgent default from 12 to 20.

---

### 6. ❌ Consecutive Tool Exhaustion Reset Logic
**File:** `src/core/loop/agent-loop.js`

**Contradiction:** `_consecutiveToolExhaustion` resets on ANY successful tool call. If tool A fails, tool B succeeds, tool A fails again — the counter resets and the loop never catches the alternating failure pattern.

**Fix:** Added a monotonic `_totalToolExhaustion` counter that never resets. The guard now fires on EITHER consecutive exhaustion OR total exhaustion (3x the consecutive limit), catching both patterns.

---

### 7. ❌ Context Compaction Futile Retry Loop
**File:** `src/core/context.js`

**Contradiction:** When `keepRecent` alone exceeds the token budget, compaction can't help — but `append()` called `_compact()` on every single message, wasting CPU and potentially corrupting context.

**Fix:** Added `_lastCompactFailed` flag. When compaction can't reduce usage below the threshold, subsequent appends skip compaction until the context is cleared or successfully compacted.

---

### 8. ❌ Budget Manager runtimeMs Inconsistency
**File:** `src/budget/budget-manager.js`

**Contradiction:** `exceeded()` used `Date.now() - startedAt` (wall-clock) for runtimeMs, but `usage.runtimeMs` returned the additive counter from `record()` calls. These measured different things, so `usage.runtimeMs` could show 500ms while the actual elapsed time was much higher.

**Fix:** `usage` getter now always returns `Date.now() - startedAt` for runtimeMs, ensuring consistency with the `exceeded()` check.

---

### 9. ❌ TODO Manager canFinish vs. summary Disagreement
**File:** `src/core/todo-manager.js`

**Contradiction:** `canFinish()` used a `looksLikeCode` regex to decide if a completed+verified item needs tests. `summary()` counted ALL completed+verified items as "untested" without the filter. So `summary().canFinish` could say `false` while `canFinish().ok` said `true`.

**Fix:** `summary()` now uses the same `looksLikeCode` heuristic and delegates to `canFinish()` for the `canFinish` field, ensuring both paths agree.

---

### 10. ❌ System Prompt Contradictions (COMPLETE REWRITE)
**File:** `src/core/system-prompt.js` (NEW), `src/index.js`

**Issues in the old prompt:**
- "ANTI-LAZINESS" framing was adversarial and unclear
- Fallback Rule was buried in a section, not prominent
- No explicit "when NOT to use a tool" guidance
- Clarification vs. inference rules were vague
- Output quality standards were implicit
- No explicit anti-patterns list
- Sections were not clearly delimited

**Fix:** Complete rewrite with:
- Explicit QUALITY GATES section (enforced by the loop)
- Prominent FALLBACK RULE section with clear do/don't
- Explicit "when to use / when NOT to use" tool guidance
- Clear clarification vs. inference decision tree
- Explicit output quality standards (must/must not)
- Anti-patterns list (instant failure behaviors)
- Clean section delimiters for readability

---

### 11. ❌ Checkpoint Missing totalToolExhaustion
**File:** `src/core/loop/agent-loop.js`

**Contradiction:** The new `_totalToolExhaustion` counter wasn't included in checkpoint snapshots, so resuming from a checkpoint would reset it to 0, losing the exhaustion history.

**Fix:** Added `totalToolExhaustion` to checkpoint snapshot and restore.

---

### 12. ❌ web_search Retry Policy Too Aggressive
**File:** `src/core/loop/retry-policy.js`

**Contradiction:** `web_search` had `maxAttempts: 3` and retried on network errors. Combined with the system prompt's "do NOT retry" rule, this created confusion about which rule to follow.

**Fix:** Reduced to `maxAttempts: 2` and removed network error codes from retryable list.

---

### 13. ❌ Context Compaction Success Flag Not Reset
**File:** `src/core/context.js`

**Contradiction:** After a failed compaction, the `_lastCompactFailed` flag was never reset on `clear()`, so a cleared context would still skip compaction.

**Fix:** Reset `_lastCompactFailed = false` in `clear()`.

---

### 14. ❌ Drop Strategy Compaction Success Detection
**File:** `src/core/context.js`

**Contradiction:** The drop strategy compaction always logged success even when it couldn't reduce usage below the threshold (e.g., when all remaining messages are protected).

**Fix:** Set `_lastCompactFailed` based on whether usage is still above the threshold after compaction.

---

## Files Modified

| File | Changes |
|------|---------|
| `src/core/loop/agent-loop.js` | Fixed fingerprinting, overuse tracking, exhaustion logic, state transitions, tool cap |
| `src/core/loop/retry-policy.js` | Removed network errors from retryable codes, fixed web_search policy |
| `src/tools/registry.js` | Fixed RETRYABLE_ERROR_CODES to exclude network errors |
| `src/core/context.js` | Added compaction failure tracking to prevent futile retries |
| `src/budget/budget-manager.js` | Fixed runtimeMs consistency between usage and exceeded() |
| `src/core/todo-manager.js` | Fixed canFinish/summary disagreement |
| `src/index.js` | Wired new system prompt, bumped tool-overuse default |
| `src/core/system-prompt.js` | **NEW** — Production-grade system prompt |
| `tests/smoke.test.js` | Updated assertions for new prompt and defaults |

## Test Results
**242/242 tests pass** after all changes.
