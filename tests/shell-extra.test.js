/**
 * shell-extra.test.js — shell_spawn / shell_kill / shell_which
 * ------------------------------------------------------------
 * Background process lifecycle (real subprocesses), policy checks, and
 * PATH resolution. All spawned processes are killed within the test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolRegistry } from '../src/tools/index.js';
import { createShellSpawnTool, createShellKillTool, createShellWhichTool, createShellTool } from '../src/tools/shell.js';

function registry() {
  const r = new ToolRegistry();
  r.register(createShellSpawnTool());
  r.register(createShellKillTool());
  r.register(createShellWhichTool());
  return r;
}

test('shell_which: resolves real binaries on PATH and reports misses', async () => {
  const r = registry();
  const found = await r.execute('shell_which', { command: 'node' });
  assert.equal(found.ok, true);
  assert.equal(found.data.found, true);
  assert.ok(found.data.path.endsWith('node') || found.data.path.endsWith('node.exe'), `got ${found.data.path}`);
  assert.ok(path.isAbsolute(found.data.path), 'resolved path is absolute');

  const miss = await r.execute('shell_which', { command: 'definitely_not_a_real_binary_xyz' });
  assert.equal(miss.data.found, false);
  assert.equal(miss.data.path, null);
});

test('shell_spawn starts a background process; shell_kill stops it', async () => {
  const r = registry();
  const spawned = await r.execute('shell_spawn', { command: 'node -e "setInterval(() => {}, 1000)"' });
  assert.equal(spawned.ok, true);
  assert.ok(Number.isInteger(spawned.data.pid) && spawned.data.pid > 0, 'got a real pid');
  assert.equal(typeof spawned.data.pid, 'number');

  // Process is alive right after spawn.
  let alive = true;
  try {
    process.kill(spawned.data.pid, 0);
  } catch (_err) {
    alive = false;
  }
  assert.equal(alive, true, 'background process is running');

  const killed = await r.execute('shell_kill', { pid: spawned.data.pid });
  assert.equal(killed.ok, true);
  assert.equal(killed.data.killed, true);

  // Second kill of the same pid: no longer tracked by shell_spawn.
  const again = await r.execute('shell_kill', { pid: spawned.data.pid });
  assert.equal(again.ok, false);
  assert.equal(again.code, 'NOT_TRACKED');
});

test('shell_kill refuses untracked pids unless force:true', async () => {
  const r = registry();
  const untracked = await r.execute('shell_kill', { pid: 999999 });
  assert.equal(untracked.ok, false);
  assert.equal(untracked.code, 'NOT_TRACKED');

  const badPid = await r.execute('shell_kill', { pid: -5 });
  assert.equal(badPid.ok, false);
  assert.equal(badPid.code, 'INVALID_PID');
});

test('shell_spawn enforces the denylist and empty-command check', async () => {
  const r = registry();
  const denied = await r.execute('shell_spawn', { command: 'rm -rf /tmp/x' });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'DENIED_BINARY');

  const empty = await r.execute('shell_spawn', { command: '   ' });
  assert.equal(empty.ok, false);
  assert.equal(empty.code, 'EMPTY_COMMAND');
});

test('shell tool rejects a cwd that escapes the sandbox root', async () => {
  const r = new ToolRegistry();
  r.register(createShellTool({ cwd: process.cwd(), sandboxRoot: process.cwd() }));
  const res = await r.execute('shell', { command: 'node -v', cwd: '/tmp' });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'CWD_ESCAPE');
});

test('shell network/timeout errors are NOT retried by the loop (fail fast -> pivot)', async () => {
  const { AgentLoop } = await import('../src/core/loop/index.js');
  const { ContextWindow } = await import('../src/core/context.js');
  const r = new ToolRegistry();
  let calls = 0;
  r.register({
    name: 'flaky_net',
    description: 'networky',
    handler: async () => {
      calls += 1;
      const err = new Error('connection refused');
      err.code = 'REQUEST_FAILED'; // network-shaped failure
      throw err;
    },
  });
  const script = [
    { type: 'tool_call', tool: 'flaky_net', args: {} },
    { type: 'tool_call', tool: 'flaky_net', args: {} },
    { type: 'final', content: 'pivoted to web_search' },
  ];
  let i = 0;
  const loop = new AgentLoop({
    context: new ContextWindow(),
    tools: r,
    toolRetry: { retries: 3, backoffMs: 1 },
    reasoner: async () => script[Math.min(i++, script.length - 1)],
  });
  const result = await loop.run('fetch remote');
  assert.equal(result.status, 'final');
  assert.equal(calls, 2, 'network failures fail fast — no retry attempts burned');
  const observe = result.stepMemory.filter((s) => s.phase === 'observe');
  assert.equal(observe.length, 2);
  assert.ok(observe.every((o) => o.attempts === 1), 'each call failed fast with 1 attempt');
});

test('shell tool: clean spawn env — nested `node --test` actually runs (no NODE_TEST_CONTEXT leak)', async () => {
  // The outer test process runs under `node --test`, so NODE_TEST_CONTEXT is
  // set in our env. If the shell tool leaked it into children, the nested
  // `node --test` would print "skipping running files" and silently run
  // NOTHING (exit code 0 either way) — verify real output made it through.
  const root = mkdtempSync(join(tmpdir(), 'scrappyai-shell-env-'));
  writeFileSync(
    join(root, 'inner.test.js'),
    "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('inner passes', () => { assert.equal(1, 1); });\n"
  );
  const r = new ToolRegistry();
  r.register(createShellTool({ cwd: root }));
  const res = await r.execute('shell', { command: `node --test ${join(root, 'inner.test.js')}` });
  assert.equal(res.ok, true);
  assert.equal(res.data.exitCode, 0);
  assert.match(res.data.stdout, /# pass 1/, 'nested test run must produce real TAP output, not be silently skipped');
});
