# ScrappyAi Agent — Improvement TODO

## Phase 1: TODO / Task Checklist Enforcement
- [x] 1.1 Create `src/core/todo-manager.js` (persistent TODO.md parser/serializer)
- [x] 1.2 Add TODO tools (todo_create / todo_tick / todo_status / todo_untick / todo_add / todo_start / todo_mark_verified / todo_mark_tested / todo_skip)
- [x] 1.3 Wire TODO gate into AgentLoop: block FINAL until all items are [x] + tested
- [x] 1.4 Inject "MANDATORY FIRST STEP: create TODO.md" into default system prompt

## Phase 2: Planner–Executor Pattern
- [x] 2.1 Create `src/planning/spec.js` (PRD/Spec document model: components, files, API, DB, tests)
- [x] 2.2 Add spec tools (spec_create / spec_show / spec_next_files / spec_file_started / spec_file_done / spec_file_verified / spec_test_passed / spec_status)
- [x] 2.3 Wire Planner stage into FINAL gate: block FINAL until all files are IMPLEMENTED + VERIFIED
- [x] 2.4 Executor follows spec file-by-file (system prompt enforces it)

## Phase 3: Anti-Half-Baked-Code Rules
- [x] 3.1 Enumerate forbidden patterns (placeholders, "// TODO", "...", "rest of code", stubs) → `src/verification/completeness.js`
- [x] 3.2 Add "complete-file-or-don't-touch-it" rule to system prompt
- [x] 3.3 Mandatory post-write checks: write_file auto-runs completeness scan and reports errors in the result
- [x] 3.4 Bracket-balance / truncation / suspiciously-short-file heuristics

## Phase 4: Runtime Budget / Token / Step Defaults in .env
- [x] 4.1 Pick production defaults (SCRAPPYAI_MAX_STEPS=15, SCRAPPYAI_MAX_STEPS_MAX=80, SCRAPPYAI_MAX_RUNTIME_MS=600000, tokens=200k, etc.)
- [x] 4.2 Wire every budget dimension with sane defaults (readEnvInt helpers, no Infinity fallback)
- [x] 4.3 Document every knob in .env.example with recommended values
- [x] 4.4 SCRAPPYAI_STRICT_FINAL master switch for the anti-laziness gate

## Phase 5: Verification Loop Hardening
- [x] 5.1 FINAL gate blocks premature finishes while TODO/Spec is incomplete
- [x] 5.2 write_file scans for placeholder/partial code and reports errors in real time
- [x] 5.3 Default critic (evaluation) requires verification evidence before FINISH; write_file with completeness errors forces REPAIR
- [x] 5.4 verify_preflight tool runs an automated pre-final sweep (TODO + Spec + extra command checks)

## Phase 6: Wire-Up + Tests
- [x] 6.1 Register new tools in createDefaultToolRegistry / index.js exports
- [x] 6.2 Update AgentLoop to use TODO gate + pre-final verification
- [x] 6.3 Strengthened system prompt (Rule Zero, Planner/Executor phases, Completeness Rules)
- [x] 6.4 All 242 tests pass (including 13 new tests in tests/todo-gate.test.js)
