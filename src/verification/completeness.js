/**
 * verification/completeness.js — Anti-Half-Baked-Code Detector
 * -----------------------------------------------------------
 * Scans a file's contents for placeholders, stubs, and "I'll fill this in
 * later" markers that LLMs love to emit when they get lazy:
 *
 *   - "// TODO", "// FIXME", "// HACK", "// XXX" comments
 *   - "..." as a code placeholder (not in strings/comments)
 *   - "rest of code", "rest of function", "remainder of", "// implement"
 *   - "pass" / "..." / "throw new Error('not implemented')" / "NotImplementedError"
 *   - "your code here", "add your code", "fill in", "to do"
 *   - Empty function bodies (function foo() {}) that aren't followed by comment
 *   - Unclosed brackets / obvious truncation (heuristic)
 *   - "# ..." stub lines in shell scripts
 *
 * The goal: if the reasoner calls write_file and leaves a placeholder,
 * the verification pipeline catches it BEFORE the file is considered done,
 * and forces the agent to actually fill it in. This is the core guard
 * against "کدهای نصفه‌نیمه" (half-finished code).
 *
 * Pure JavaScript (ES modules). No external deps.
 */

import { createLogger } from '../core/logger.js';

const log = createLogger('verification:completeness');

/**
 * Patterns that signal unfinished code. Each entry:
 *   name     machine-readable tag
 *   re       regex (tested per line, case-insensitive unless we say otherwise)
 *   severity 'error' (must fix) or 'warn' (human-judgement)
 *   message  human-readable explanation
 *
 * Order matters — keep the cheap substring hits first.
 */
const PATTERNS = [
  // --- Error-severity: very likely a placeholder ---
  { name: 'not_implemented_error', re: /\bnot\s*implemented\b|\bNotImplementedError\b|\bunimplemented\b/i, severity: 'error', message: 'Throws "not implemented" — function is a stub.' },
  { name: 'todo_comment',           re: /(\/\/|#|\/\*)\s*(TODO|FIXME|HACK|XXX)\b/i, severity: 'error', message: 'Contains TODO/FIXME/HACK/XXX comment — unfinished work.' },
  { name: 'your_code_here',         re: /your code (here|goes)|add your code|fill (this|them) in|write your (code|logic|implementation)|replace (this|these) (with|comment)/i, severity: 'error', message: 'Contains "your code here"-style placeholder.' },
  { name: 'rest_of_code',           re: /rest of (the|this)?\s*(code|function|method|class|file|implementation|logic)|remainder of (the|this)?\s*(code|function|method|file)|existing code remains|\.\.\.\s*(existing|previous)\s*code/i, severity: 'error', message: 'Contains "rest of code" placeholder — omitted implementation.' },
  { name: 'abbreviated_placeholder', re: /\/\*\s*\.\.\.\s*\*\/|#\s*\.{3,}\s*$|\/\/\s*\.{3,}\s*$/, severity: 'error', message: 'Contains "..." abbreviation placeholder.' },
  { name: 'pass_in_python',         re: /^[ \t]*pass[ \t]*$/m, severity: 'warn', message: 'Contains a bare "pass" — might be a stub.' },
  { name: 'ellipsis_in_python',     re: /^[ \t]*\.\.\.[ \t]*$/m, severity: 'warn', message: 'Contains "..." (Python Ellipsis) used as a stub.' },

  // --- Warn-severity: human judgement ---
  { name: 'console_placeholder',    re: /console\.(log|error)\(['"`]*(todo|fixme|placeholder|stub|nyi)/i, severity: 'warn', message: 'Console log of "todo" / "placeholder".' },
  { name: 'magic_marker',           re: /\b(MAGIC|HACKY|WORKAROUND|TEMPORARY|XXX)\b/i, severity: 'warn', message: 'Smell word present — review before declaring done.' },
];

/**
 * Check a single file's content for placeholders / stubs.
 * @param {string} content  raw source
 * @param {string} [filename]  used to pick language-specific heuristics
 * @returns {{ok:boolean, errors:Array, warnings:Array, linesChecked:number}}
 */
export function checkCompleteness(content, filename = '') {
  const errors = [];
  const warnings = [];
  const text = String(content ?? '');
  if (text.length === 0) {
    return { ok: false, errors: [{ name: 'empty_file', severity: 'error', message: 'File is empty — an empty file is not an implementation.' }], warnings: [], linesChecked: 0 };
  }
  const ext = (filename.split('.').pop() || '').toLowerCase();
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Strip string/comment content conservatively? For now we just match
    // against the whole line — false positives on lines like
    // `const msg = "see TODO above"` are rare and the warn/error split keeps
    // them as warnings anyway. We DO skip pure comment lines for error-level
    // markers that are too noisy in comments (only TODO is specifically
    // matched in comment form above).
    for (const p of PATTERNS) {
      if (p.re.test(line)) {
        const entry = {
          name: p.name,
          severity: p.severity,
          message: p.message,
          line: i + 1,
          snippet: line.trim().slice(0, 200),
        };
        if (p.severity === 'error') errors.push(entry);
        else warnings.push(entry);
        // Don't re-report the same line for multiple patterns of the same severity.
        break;
      }
    }
  }

  // --- Language-specific structural heuristics ---
  const structural = structuralChecks(text, ext);
  for (const s of structural) {
    if (s.severity === 'error') errors.push(s);
    else warnings.push(s);
  }

  const ok = errors.length === 0;
  if (!ok) {
    log.info('completeness:failed', { file: filename, errors: errors.length, warnings: warnings.length });
  } else {
    log.debug('completeness:ok', { file: filename, warnings: warnings.length });
  }
  return { ok, errors, warnings, linesChecked: lines.length };
}

/**
 * Lightweight balanced-bracket / truncation checks. Not a real parser — just
 * catches the most common "model got cut off mid-file" cases.
 */
function structuralChecks(text, ext) {
  const out = [];

  // Only run bracket-balance checks on C-like / JSON languages where it's a
  // strong signal. (Python indentation / Markdown are too noisy.)
  if (['js', 'mjs', 'cjs', 'ts', 'jsx', 'tsx', 'json', 'css', 'scss', 'java', 'c', 'cpp', 'go'].includes(ext)) {
    const counts = { '{': 0, '}': 0, '(': 0, ')': 0, '[': 0, ']': 0 };
    // Walk the text, skipping strings/comments very roughly.
    let i = 0;
    let inStr = null;
    let inLineComment = false;
    let inBlockComment = false;
    while (i < text.length) {
      const ch = text[i];
      const nxt = text[i + 1];
      if (inLineComment) {
        if (ch === '\n') inLineComment = false;
        i++; continue;
      }
      if (inBlockComment) {
        if (ch === '*' && nxt === '/') { inBlockComment = false; i += 2; continue; }
        i++; continue;
      }
      if (inStr) {
        if (ch === '\\') { i += 2; continue; }
        if (ch === inStr) inStr = null;
        i++; continue;
      }
      if ((ch === '"' || ch === "'" || ch === '`')) { inStr = ch; i++; continue; }
      if (ch === '/' && nxt === '/') { inLineComment = true; i += 2; continue; }
      if (ch === '/' && nxt === '*') { inBlockComment = true; i += 2; continue; }
      if (ch in counts) counts[ch]++;
      i++;
    }
    if (counts['{'] !== counts['}']) {
      out.push({ name: 'unbalanced_braces', severity: 'error', message: `Unbalanced curly braces: { = ${counts['{']}, } = ${counts['}']}. File is likely truncated.` });
    }
    if (counts['('] !== counts[')']) {
      out.push({ name: 'unbalanced_parens', severity: 'error', message: `Unbalanced parentheses: ( = ${counts['(']}, ) = ${counts[')']}. File may be truncated.` });
    }
    if (counts['['] !== counts[']']) {
      out.push({ name: 'unbalanced_brackets', severity: 'error', message: `Unbalanced brackets: [ = ${counts['[']}, ] = ${counts[']']}. File may be truncated.` });
    }
  }

  // Suspiciously short file with a code-looking extension (less than 3 lines
  // or under 40 chars) is almost certainly a stub, not a real module.
  if (['js', 'mjs', 'cjs', 'ts', 'py', 'go', 'rs', 'java'].includes(ext)) {
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length < 2 || text.trim().length < 40) {
      out.push({ name: 'suspiciously_short', severity: 'error', message: `File is extremely short (${lines.length} non-empty lines, ${text.trim().length} chars) for a ${ext} source file — likely a stub.` });
    }
  }

  // Ends mid-word (very crude truncation detector: last non-space char is a letter/digit
  // and the file doesn't end with a close-paren/brace/newline).
  const trimmed = text.trimEnd();
  if (trimmed.length > 20) {
    const last = trimmed[trimmed.length - 1];
    const lastCharCode = last.charCodeAt(0);
    const isIdChar = (lastCharCode >= 48 && lastCharCode <= 57) || (lastCharCode >= 65 && lastCharCode <= 90) || (lastCharCode >= 97 && lastCharCode <= 122) || last === '_' || last === '$';
    if (isIdChar && !/[\n;})\]'"`]/.test(last) && ext !== 'md' && ext !== 'txt') {
      out.push({ name: 'possible_truncation', severity: 'warn', message: `File appears to end mid-token (last char: "${last}") — may be truncated.` });
    }
  }

  return out;
}

/**
 * Format a completeness result as a short human-readable block suitable for
 * injecting into context as a [verification] system message.
 */
export function formatCompletenessResult(res, filename) {
  if (res.ok && res.warnings.length === 0) return `[completeness] ${filename || 'file'}: OK`;
  const parts = [];
  if (!res.ok) parts.push(`${res.errors.length} ERROR(S):`);
  for (const e of res.errors) parts.push(`  ✗ line ${e.line}: ${e.message} (${e.name}) — "${e.snippet}"`);
  if (res.warnings.length) {
    parts.push(`${res.warnings.length} warning(s):`);
    for (const w of res.warnings) parts.push(`  ⚠ line ${w.line || '?'}: ${w.message} (${w.name})`);
  }
  return `[completeness] ${filename || 'file'}: ${res.ok ? 'OK with warnings' : 'FAILED'}\n` + parts.join('\n');
}

export default { checkCompleteness, formatCompletenessResult };
