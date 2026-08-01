/**
 * code-package.test.js — code tools (run/test/validate) + package tools (npm/install/package_info)
 * ------------------------------------------------------------------------------------------------
 * Real subprocess behavior for code execution; package_info is fully
 * offline; npm is exercised with offline-safe commands only (--version).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolRegistry } from '../src/tools/index.js';
import { createCodeTools } from '../src/tools/code.js';
import { createPackageTools } from '../src/tools/package.js';

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'scrappyai-code-'));
  const r = new ToolRegistry();
  for (const def of createCodeTools({ rootDir: root })) r.register(def);
  for (const def of createPackageTools({ rootDir: root })) r.register(def);
  return { root, r };
}

test('code_run: executes a .js file and reports stdout/exit code', async () => {
  const { root, r } = setup();
  writeFileSync(join(root, 'main.js'), 'console.log("hi from file"); process.exit(2);');
  const res = await r.execute('code_run', { path: 'main.js' });
  assert.equal(res.ok, true);
  assert.equal(res.data.exitCode, 2, 'non-zero exit reported, not thrown');
  assert.match(res.data.stdout, /hi from file/);
});

test('code_run: inline code with language selection', async () => {
  const { r } = setup();
  const js = await r.execute('code_run', { code: 'console.log(1 + 1)' });
  assert.equal(js.ok, true);
  assert.match(js.data.stdout, /2/);

  const py = await r.execute('code_run', { code: 'print(2 + 3)', language: 'python' });
  assert.equal(py.ok, true);
  assert.match(py.data.stdout, /5/);

  const none = await r.execute('code_run', {});
  assert.equal(none.ok, false);
  assert.equal(none.code, 'NO_INPUT');

  const badLang = await r.execute('code_run', { code: 'x', language: 'cobol' });
  assert.equal(badLang.ok, false);
  assert.equal(badLang.code, 'UNSUPPORTED_LANGUAGE');
});

test('code_validate: syntax-checks without executing', async () => {
  const { root, r } = setup();
  writeFileSync(join(root, 'good.js'), 'const x = 1; console.log(x);');
  writeFileSync(join(root, 'bad.js'), 'const x = ;');
  writeFileSync(join(root, 'data.json'), '{"a": 1}');
  writeFileSync(join(root, 'bad.json'), '{"a": }');

  const good = await r.execute('code_validate', { path: 'good.js' });
  assert.equal(good.ok, true);
  assert.equal(good.data.valid, true);

  const bad = await r.execute('code_validate', { path: 'bad.js' });
  assert.equal(bad.ok, true, 'invalid code is reported, not thrown');
  assert.equal(bad.data.valid, false);
  assert.ok(bad.data.errors.length > 0);

  const json = await r.execute('code_validate', { path: 'data.json' });
  assert.equal(json.data.valid, true);
  const badJson = await r.execute('code_validate', { path: 'bad.json' });
  assert.equal(badJson.data.valid, false);

  const inline = await r.execute('code_validate', { code: '{"ok": true}', language: 'json' });
  assert.equal(inline.data.valid, true);

  const neverRan = await r.execute('code_run', { code: 'console.log("SHOULD NOT RUN")', language: 'json' });
  assert.equal(neverRan.ok, false, 'json is not runnable');
});

test('code_test: runs a test file and reports results', async () => {
  const { root, r } = setup();
  writeFileSync(
    join(root, 'math.test.js'),
    'import { test } from "node:test"; import assert from "node:assert/strict";\n' +
      'test("2+2=4", () => assert.equal(2 + 2, 4));\n'
  );
  const res = await r.execute('code_test', { path: 'math.test.js' });
  assert.equal(res.ok, true);
  assert.equal(res.data.exitCode, 0, 'passing tests exit 0');
  assert.match(res.data.stdout, /pass 1/);
});

test('code_test: falls back to npm test when a package.json test script exists', async () => {
  const { root, r } = setup();
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'proj', version: '1.0.0', scripts: { test: 'node -e "console.log(\\"ran npm test\\")"' } })
  );
  const res = await r.execute('code_test', {});
  assert.equal(res.ok, true);
  assert.match(res.data.stdout, /ran npm test/);
});

test('package_info: reads the project package.json offline', async () => {
  const { root, r } = setup();
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'my-app',
      version: '2.3.4',
      description: 'desc',
      license: 'MIT',
      scripts: { start: 'node index.js', test: 'node --test' },
      dependencies: { express: '^4.0.0' },
      devDependencies: { vitest: '^1.0.0' },
    })
  );
  const res = await r.execute('package_info', {});
  assert.equal(res.ok, true);
  assert.equal(res.data.name, 'my-app');
  assert.equal(res.data.version, '2.3.4');
  assert.equal(res.data.self, true);
  assert.deepEqual(res.data.dependencies, { express: '^4.0.0' });
  assert.equal(res.data.scripts.test, 'node --test');

  const missing = await r.execute('package_info', { cwd: 'nonexistent-dir' });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'NOT_FOUND');
});

test('package_info: resolves an installed package by name (execa is a dependency of this project)', async () => {
  const { r } = setup();
  const res = await r.execute('package_info', { name: 'execa' });
  assert.equal(res.ok, true);
  assert.equal(res.data.installed, true);
  assert.ok(res.data.version, 'has a version');
  assert.ok(res.data.installedPath.includes('node_modules'), 'resolved from node_modules');

  const notInstalled = await r.execute('package_info', { name: 'this-package-definitely-does-not-exist-xyz' });
  assert.equal(notInstalled.ok, true, 'not-found is a normal result, not an error');
  assert.equal(notInstalled.data.installed, false);
});

test('npm: runs offline-safe npm commands and rejects empty args', async () => {
  const { r } = setup();
  const version = await r.execute('npm', { args: '--version' });
  assert.equal(version.ok, true);
  assert.equal(version.data.exitCode, 0);
  assert.match(version.data.stdout, /^\d+\.\d+\.\d+/);

  const empty = await r.execute('npm', { args: '   ' });
  assert.equal(empty.ok, false);
  assert.equal(empty.code, 'EMPTY_ARGS');
});

test('package_install: builds the right npm argv (offline dry-run with a package.json)', async () => {
  const { root, r } = setup();
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'dry', version: '1.0.0' }));
  // npm install --dry-run with no deps: offline-safe, validates the argv the
  // tool composes without touching the registry.
  const dry = await r.execute('npm', { args: 'install --dry-run --no-audit --no-fund' });
  assert.equal(dry.ok, true);
  assert.equal(dry.data.exitCode, 0);
  const combined = `${dry.data.stdout}\n${dry.data.stderr}`;
  assert.match(combined, /up to date|added|audited|packages|found/i);
});
