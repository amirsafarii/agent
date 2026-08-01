/**
 * filesystem.test.js — the 9-tool filesystem suite
 * -------------------------------------------------
 * read / write / edit / list / search / mkdir / move / copy / delete —
 * all confined to the sandbox root. Real filesystem behavior in a temp dir.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolRegistry } from '../src/tools.js';
import { createFilesystemTools } from '../src/tools/filesystem.js';

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'scrappyai-fs-'));
  const registry = new ToolRegistry();
  for (const def of createFilesystemTools({ rootDir: root })) registry.register(def);
  return { root, registry };
}

test('write_file + read_file round-trip with parent creation', async () => {
  const { root, registry } = setup();
  const w = await registry.execute('write_file', { path: 'a/b/c.txt', content: 'hello' });
  assert.equal(w.ok, true);
  assert.ok(existsSync(join(root, 'a', 'b', 'c.txt')));
  const r = await registry.execute('read_file', { path: 'a/b/c.txt' });
  assert.equal(r.data.content, 'hello');
});

test('edit_file: literal replace (first occurrence), replace_all, and NOT_FOUND', async () => {
  const { root, registry } = setup();
  await registry.execute('write_file', { path: 'x.txt', content: 'one two one' });

  const edited = await registry.execute('edit_file', { path: 'x.txt', old_text: 'one', new_text: '1' });
  assert.equal(edited.ok, true);
  assert.equal(edited.data.replaced, 1);
  assert.equal(readFileSync(join(root, 'x.txt'), 'utf8'), '1 two one');

  const all = await registry.execute('edit_file', { path: 'x.txt', old_text: '1', new_text: 'ONE', replace_all: true });
  assert.equal(all.data.replaced, 1);
  assert.equal(readFileSync(join(root, 'x.txt'), 'utf8'), 'ONE two one');

  await registry.execute('write_file', { path: 'x.txt', content: 'a a a' });
  const multi = await registry.execute('edit_file', { path: 'x.txt', old_text: 'a', new_text: 'b', replace_all: true });
  assert.equal(multi.data.replaced, 3);
  assert.equal(readFileSync(join(root, 'x.txt'), 'utf8'), 'b b b');

  const missing = await registry.execute('edit_file', { path: 'x.txt', old_text: 'zzz', new_text: 'y' });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'NOT_FOUND');
});

test('edit_file: regex mode', async () => {
  const { root, registry } = setup();
  await registry.execute('write_file', { path: 'r.txt', content: 'v1.0.0 and v2.0.0' });
  const res = await registry.execute('edit_file', { path: 'r.txt', old_text: 'v\\d+\\.0\\.0', new_text: 'vX', useRegex: true, replace_all: true });
  assert.equal(res.data.replaced, 2);
  assert.equal(readFileSync(join(root, 'r.txt'), 'utf8'), 'vX and vX');

  const bad = await registry.execute('edit_file', { path: 'r.txt', old_text: '(', new_text: 'x', useRegex: true });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'INVALID_REGEX');
});

test('list_dir: flat and recursive, hidden files excluded, caps respected', async () => {
  const { root, registry } = setup();
  await registry.execute('write_file', { path: 'top.txt', content: 't' });
  await registry.execute('write_file', { path: 'sub/nested.txt', content: 'n' });
  await registry.execute('write_file', { path: '.hidden', content: 'h' });

  const flat = await registry.execute('list_dir', {});
  assert.equal(flat.ok, true);
  assert.deepEqual(flat.data.entries.map((e) => e.name), ['sub', 'top.txt']);
  assert.equal(flat.data.entries.find((e) => e.name === 'top.txt').type, 'file');

  const recursive = await registry.execute('list_dir', { recursive: true });
  const names = recursive.data.entries.map((e) => e.path);
  assert.ok(names.includes('sub/nested.txt'));
  assert.ok(!names.includes('.hidden'), 'hidden excluded by default');
});

test('search_files: glob + content filter + caps', async () => {
  const { root, registry } = setup();
  await registry.execute('write_file', { path: 'src/index.js', content: 'const x = 1;' });
  await registry.execute('write_file', { path: 'src/util.js', content: 'const y = 2;' });
  await registry.execute('write_file', { path: 'README.md', content: 'docs only' });

  const js = await registry.execute('search_files', { pattern: '**/*.js' });
  assert.equal(js.data.resultCount, 2);
  assert.ok(js.data.results.every((r) => r.path.endsWith('.js')));

  const withText = await registry.execute('search_files', { pattern: '**/*', text: 'const y' });
  assert.equal(withText.data.resultCount, 1);
  assert.equal(withText.data.results[0].path, 'src/util.js');

  const none = await registry.execute('search_files', { pattern: '**/*.py' });
  assert.equal(none.data.resultCount, 0);

  const scoped = await registry.execute('search_files', { pattern: '*.md', path: 'src' });
  assert.equal(scoped.data.resultCount, 0, 'scope respected');
});

test('make_dir, move_file, copy_file', async () => {
  const { root, registry } = setup();
  const mk = await registry.execute('make_dir', { path: 'deep/a/b' });
  assert.equal(mk.ok, true);
  assert.ok(existsSync(join(root, 'deep', 'a', 'b')));

  await registry.execute('write_file', { path: 'orig.txt', content: 'mv me' });
  const mv = await registry.execute('move_file', { source: 'orig.txt', destination: 'moved/new.txt' });
  assert.equal(mv.ok, true);
  assert.ok(!existsSync(join(root, 'orig.txt')));
  assert.equal(readFileSync(join(root, 'moved', 'new.txt'), 'utf8'), 'mv me');

  const cp = await registry.execute('copy_file', { source: 'moved/new.txt', destination: 'moved/copy.txt' });
  assert.equal(cp.ok, true);
  assert.ok(existsSync(join(root, 'moved', 'copy.txt')));
});

test('delete_file: works on files, refuses non-empty dirs without recursive, refuses root', async () => {
  const { root, registry } = setup();
  await registry.execute('write_file', { path: 'bye.txt', content: 'x' });
  const del = await registry.execute('delete_file', { path: 'bye.txt' });
  assert.equal(del.ok, true);
  assert.ok(!existsSync(join(root, 'bye.txt')));

  await registry.execute('write_file', { path: 'dir/file.txt', content: 'x' });
  const noRecursive = await registry.execute('delete_file', { path: 'dir' });
  assert.equal(noRecursive.ok, false);
  assert.equal(noRecursive.code, 'IS_DIRECTORY');

  const recursive = await registry.execute('delete_file', { path: 'dir', recursive: true });
  assert.equal(recursive.ok, true);
  assert.ok(!existsSync(join(root, 'dir')));

  const rootDelete = await registry.execute('delete_file', { path: '.', recursive: true });
  assert.equal(rootDelete.ok, false);
  assert.equal(rootDelete.code, 'ROOT_DELETE');
});

test('every filesystem tool rejects sandbox escapes before touching disk', async () => {
  const { registry } = setup();
  const attempts = [
    ['read_file', { path: '../escape.txt' }],
    ['write_file', { path: '/etc/escape', content: 'x' }],
    ['edit_file', { path: '../escape.txt', old_text: 'a', new_text: 'b' }],
    ['list_dir', { path: '../..' }],
    ['search_files', { pattern: '*', path: '..' }],
    ['make_dir', { path: '../x' }],
    ['move_file', { source: '../a', destination: 'b' }],
    ['copy_file', { source: '../a', destination: 'b' }],
    ['delete_file', { path: '../x' }],
  ];
  for (const [tool, args] of attempts) {
    const res = await registry.execute(tool, args);
    assert.equal(res.ok, false, `${tool} rejects escape`);
    assert.equal(res.code, 'PATH_ESCAPE', `${tool} reports PATH_ESCAPE (got ${res.code})`);
  }
});

test('delete_file and the approval gate: a loop pauses for approval before deleting', async () => {
  const { root } = setup();
  await (await import('node:fs/promises')).writeFile(join(root, 'keep.txt'), 'x');

  const { AgentLoop } = await import('../src/loop.js');
  const { ContextWindow } = await import('../src/context.js');

  let calls = 0;
  const registry2 = new ToolRegistry();
  registry2.register({
    name: 'delete_file',
    description: 'delete',
    parameters: { path: { type: 'string', required: true }, recursive: { type: 'boolean' } },
    requiresApproval: true,
    handler: async () => {
      calls += 1;
      return 'deleted';
    },
  });
  const script = [
    { type: 'tool_call', tool: 'delete_file', args: { path: 'keep.txt' } },
    { type: 'final', content: 'done deleting' },
  ];
  let i = 0;
  const loop = new AgentLoop({
    context: new ContextWindow(),
    tools: registry2,
    reasoner: async () => script[Math.min(i++, script.length - 1)],
  });
  const result = await loop.run('delete it');
  assert.equal(result.status, 'awaiting_tool_approval');
  assert.equal(calls, 0, 'handler waits for approval');
  const resumed = await loop.resumeWithApproval(result.checkpoint, true);
  assert.equal(resumed.status, 'final');
  assert.equal(calls, 1, 'handler ran after approval');
});
