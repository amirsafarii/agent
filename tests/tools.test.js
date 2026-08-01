/**
 * tools.test.js — ToolRegistry + the four default tools
 * ------------------------------------------------------
 * Registry: validation, timeout, unknown tools, safe errors, schema.
 * shell: real subprocess behavior — literal args (no shell), denylist,
 * allowlist, non-zero exit reporting, timeout. files: sandbox root
 * confinement, read/write/append, size caps. search: stubbed fetch,
 * result capping, param passthrough.
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolRegistry } from '../src/tools.js';
import { createShellTool } from '../src/tools/shell.js';
import { createFileTools } from '../src/tools/files.js';
import { createWebSearchTool } from '../src/tools/search.js';

function newRegistry() {
  const r = new ToolRegistry();
  r.register({
    name: 'add',
    description: 'add two numbers',
    parameters: { a: { type: 'number', required: true }, b: { type: 'number', required: true } },
    handler: async ({ a, b }) => a + b,
  });
  return r;
}

test('ToolRegistry: register/duplicate/unknown/validation', async () => {
  const r = newRegistry();
  assert.equal(r.has('add'), true);
  assert.equal(r.has('nope'), false);
  assert.throws(() => r.register({ name: 'add', description: 'dup', handler: async () => 0 }), /already registered/);
  assert.throws(() => r.register({ name: '', handler: async () => 0 }), /name/);
  assert.throws(() => r.register({ name: 'x' }), /handler/);

  const unknown = await r.execute('nope', {});
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, 'UNKNOWN_TOOL');

  const missing = await r.execute('add', { a: 1 });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'VALIDATION_ERROR');
  assert.match(missing.error, /Missing required argument "b"/);

  const wrongType = await r.execute('add', { a: 'x', b: 2 });
  assert.equal(wrongType.code, 'VALIDATION_ERROR');
  assert.match(wrongType.error, /must be of type "number"/);

  const ok = await r.execute('add', { a: 2, b: 3 });
  assert.equal(ok.ok, true);
  assert.equal(ok.data, 5);
  assert.equal(typeof ok.durationMs, 'number');
});

test('ToolRegistry: per-tool timeout returns TOOL_TIMEOUT', async () => {
  const r = new ToolRegistry();
  r.register({
    name: 'slow',
    description: 'never resolves in time',
    timeoutMs: 30,
    handler: () => new Promise(() => {}),
  });
  const result = await r.execute('slow', {});
  assert.equal(result.ok, false);
  assert.equal(result.code, 'TOOL_TIMEOUT');
});

test('ToolRegistry: handler errors are captured, never thrown', async () => {
  const r = new ToolRegistry();
  r.register({
    name: 'boom',
    description: 'throws',
    handler: async () => {
      const err = new Error('kaboom');
      err.code = 'CUSTOM_FAILURE';
      throw err;
    },
  });
  const result = await r.execute('boom', {});
  assert.equal(result.ok, false);
  assert.equal(result.code, 'CUSTOM_FAILURE');
  assert.equal(result.error, 'kaboom');
});

test('ToolRegistry: unregister and schema rendering', () => {
  const r = newRegistry();
  assert.equal(r.unregister('add'), true);
  assert.equal(r.unregister('add'), false);
  const r2 = newRegistry();
  const schema = r2.toSchema();
  assert.deepEqual(schema[0].name, 'add');
  assert.deepEqual(schema[0].parameters.a, { type: 'number', required: true });
  assert.equal('handler' in schema[0], false, 'schema is provider-shaped, no functions');
});

test('shell tool: runs a real command with literal args (no shell interpolation)', async () => {
  const r = new ToolRegistry();
  r.register(createShellTool({ cwd: process.cwd() }));
  const result = await r.execute('shell', { command: 'node -e "console.log(40+2)"' });
  assert.equal(result.ok, true);
  assert.equal(result.data.exitCode, 0);
  assert.match(result.data.stdout, /42/);
});

test('shell tool: metacharacters are literal without useShell', async () => {
  const r = new ToolRegistry();
  r.register(createShellTool({ cwd: process.cwd() }));
  // Without useShell:true, "echo a && echo b" runs `echo` with literal args
  // ["a", "&&", "echo", "b"] — the && is NOT a pipe.
  const result = await r.execute('shell', { command: 'echo a && echo b' });
  assert.equal(result.ok, true);
  assert.equal(result.data.stdout.trim(), 'a && echo b');
});

test('shell tool: denylist and allowlist are enforced', async () => {
  const r = new ToolRegistry();
  r.register(createShellTool({ cwd: process.cwd() }));
  const denied = await r.execute('shell', { command: 'rm -rf /tmp/x' });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'DENIED_BINARY');

  const r2 = new ToolRegistry();
  r2.register(createShellTool({ cwd: process.cwd(), allow: ['ls', 'cat'] }));
  const notAllowed = await r2.execute('shell', { command: 'node -v' });
  assert.equal(notAllowed.ok, false);
  assert.equal(notAllowed.code, 'NOT_ALLOWLISTED');
  const allowed = await r2.execute('shell', { command: 'ls -la' });
  assert.equal(allowed.ok, true);
});

test('shell tool: non-zero exit is reported, not thrown; empty command rejected', async () => {
  const r = new ToolRegistry();
  r.register(createShellTool({ cwd: process.cwd() }));
  const failed = await r.execute('shell', { command: 'node -e "process.exit(3)"' });
  assert.equal(failed.ok, true, 'reject:false means a non-zero exit is still a successful tool result');
  assert.equal(failed.data.exitCode, 3);

  const empty = await r.execute('shell', { command: '   ' });
  assert.equal(empty.ok, false);
  assert.equal(empty.code, 'EMPTY_COMMAND');
});

test('files tools: read/write/append inside the sandbox root', async () => {
  const root = mkdtempSync(join(tmpdir(), 'scrappyai-files-'));
  const r = new ToolRegistry();
  const { readTool, writeTool } = createFileTools({ rootDir: root });
  r.register(readTool);
  r.register(writeTool);

  const written = await r.execute('write_file', { path: 'sub/dir/note.txt', content: 'hello world' });
  assert.equal(written.ok, true);
  assert.equal(written.data.bytesWritten, 11);
  assert.ok(existsSync(join(root, 'sub', 'dir', 'note.txt')), 'parent dirs created');

  const read = await r.execute('read_file', { path: 'sub/dir/note.txt' });
  assert.equal(read.ok, true);
  assert.equal(read.data.content, 'hello world');

  await r.execute('write_file', { path: 'sub/dir/note.txt', content: '!', append: true });
  const afterAppend = await r.execute('read_file', { path: 'sub/dir/note.txt' });
  assert.equal(afterAppend.data.content, 'hello world!');
  assert.equal(afterAppend.data.totalChars, 12);
});

test('files tools: sandbox escapes are rejected before touching disk', async () => {
  const root = mkdtempSync(join(tmpdir(), 'scrappyai-files-'));
  const r = new ToolRegistry();
  const { readTool, writeTool } = createFileTools({ rootDir: root });
  r.register(readTool);
  r.register(writeTool);

  for (const path of ['../escape.txt', '/etc/passwd', 'a/../../escape.txt']) {
    const res = await r.execute('write_file', { path, content: 'x' });
    assert.equal(res.ok, false, `path ${path} rejected`);
    assert.equal(res.code, 'PATH_ESCAPE');
    const res2 = await r.execute('read_file', { path });
    assert.equal(res2.ok, false);
  }
  assert.ok(!existsSync(join(root, '..', 'escape.txt')));
});

test('files tools: read errors and write size cap are reported safely', async () => {
  const root = mkdtempSync(join(tmpdir(), 'scrappyai-files-'));
  const r = new ToolRegistry();
  const { readTool, writeTool } = createFileTools({ rootDir: root, maxWriteChars: 50 });
  r.register(readTool);
  r.register(writeTool);

  const missing = await r.execute('read_file', { path: 'nope.txt' });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'ENOENT');

  const tooBig = await r.execute('write_file', { path: 'big.txt', content: 'x'.repeat(51) });
  assert.equal(tooBig.ok, false);
  assert.equal(tooBig.code, 'WRITE_TOO_LARGE');
  assert.ok(!existsSync(join(root, 'big.txt')));
});

const originalFetch = global.fetch;
let searchCalls = [];

beforeEach(() => {
  searchCalls = [];
  global.fetch = async (url) => {
    searchCalls.push(url);
    return new Response(
      JSON.stringify({
        results: Array.from({ length: 12 }, (_, i) => ({
          title: `result ${i}`,
          url: `https://example.com/${i}`,
          content: `snippet ${i}`,
          engine: 'google',
          score: 1 - i / 20,
        })),
        suggestions: ['better query'],
      }),
      { status: 200 }
    );
  };
});

test.after(() => {
  global.fetch = originalFetch;
});

test('web_search: caps results and passes params through', async () => {
  const r = new ToolRegistry();
  r.register(createWebSearchTool({ maxResults: 3 }));
  const result = await r.execute('web_search', {
    q: 'nodejs',
    language: 'en',
    time_range: 'month',
    safesearch: 1,
    pageno: 2,
  });
  assert.equal(result.ok, true);
  assert.equal(result.data.numResults, 12, 'numResults reflects the full response');
  assert.equal(result.data.results.length, 3, 'only the cap is returned');
  assert.equal(result.data.results[0].title, 'result 0');
  assert.deepEqual(result.data.suggestions, ['better query']);

  const url = searchCalls[0];
  assert.match(url, /q=nodejs/);
  assert.match(url, /language=en/);
  assert.match(url, /time_range=month/);
  assert.match(url, /safesearch=1/);
  assert.match(url, /pageno=2/);
});

test('web_search: empty query rejected; http errors reported', async () => {
  const r = new ToolRegistry();
  r.register(createWebSearchTool());
  const empty = await r.execute('web_search', { q: '  ' });
  assert.equal(empty.ok, false);
  assert.equal(empty.code, 'EMPTY_QUERY');

  global.fetch = async () => new Response('nope', { status: 500 });
  const httpErr = await r.execute('web_search', { q: 'x' });
  assert.equal(httpErr.ok, false);
  assert.equal(httpErr.code, 'HTTP_ERROR');
});
