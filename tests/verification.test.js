import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VerificationEngine } from '../src/verification.js';
import { createVerificationTools } from '../src/tools/verification.js';
import { ToolRegistry } from '../src/tools.js';

test('VerificationEngine: file verification and path escape protection', async () => {
  const root = mkdtempSync(join(tmpdir(), 'scrappyai-verif-'));
  const engine = new VerificationEngine({ rootDir: root });

  writeFileSync(join(root, 'config.json'), '{"name": "test-app", "version": "1.0.0"}');

  // Existing file
  const exists = await engine.verifyFile({ path: 'config.json', mustExist: true });
  assert.equal(exists.ok, true);
  assert.equal(exists.isFile, true);

  // Content contains check
  const containsPass = await engine.verifyFile({ path: 'config.json', contains: 'test-app' });
  assert.equal(containsPass.ok, true);

  const containsFail = await engine.verifyFile({ path: 'config.json', contains: 'nonexistent-string' });
  assert.equal(containsFail.ok, false);

  // Missing file check
  const missing = await engine.verifyFile({ path: 'missing.txt', mustExist: true });
  assert.equal(missing.ok, false);

  // Path escape rejected
  assert.throws(() => engine._resolvePath('../escape.txt'), /Path escape detected/);
});

test('VerificationEngine: command execution verification', async () => {
  const engine = new VerificationEngine();

  // Passing command
  const pass = await engine.verifyCommand({
    command: 'node -e "console.log(\'hello verification\')"',
    expectedExitCode: 0,
    stdoutContains: 'hello verification',
  });
  assert.equal(pass.ok, true);

  // Exit code mismatch
  const exitFail = await engine.verifyCommand({
    command: 'node -e "process.exit(1)"',
    expectedExitCode: 0,
  });
  assert.equal(exitFail.ok, false);
  assert.equal(exitFail.exitCode, 1);
});

test('VerificationEngine: JSON validation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'scrappyai-verif-json-'));
  const engine = new VerificationEngine({ rootDir: root });

  writeFileSync(join(root, 'package.json'), '{"name": "my-pkg", "dependencies": {}}');

  // Valid JSON with required keys
  const valid = await engine.verifyJson({ path: 'package.json', requiredKeys: ['name', 'dependencies'] });
  assert.equal(valid.ok, true);

  // Missing required keys
  const missingKeys = await engine.verifyJson({ path: 'package.json', requiredKeys: ['name', 'scripts'] });
  assert.equal(missingKeys.ok, false);
  assert.deepEqual(missingKeys.missingKeys, ['scripts']);

  // Invalid JSON string
  const invalidJson = await engine.verifyJson({ jsonString: '{ bad json ' });
  assert.equal(invalidJson.ok, false);
});

test('VerificationEngine: suite execution', async () => {
  const root = mkdtempSync(join(tmpdir(), 'scrappyai-verif-suite-'));
  const engine = new VerificationEngine({ rootDir: root });

  writeFileSync(join(root, 'app.js'), 'console.log("ready");');

  const suiteRes = await engine.runSuite({
    checks: [
      { type: 'file', path: 'app.js', contains: 'ready' },
      { type: 'command', command: 'node app.js', stdoutContains: 'ready' },
      { type: 'json', jsonString: '{"status": "ok"}', requiredKeys: ['status'] },
    ],
  });

  assert.equal(suiteRes.ok, true);
  assert.equal(suiteRes.total, 3);
  assert.equal(suiteRes.passed, 3);
  assert.equal(suiteRes.failed, 0);
});

test('Verification tools: ToolRegistry integration and execution', async () => {
  const root = mkdtempSync(join(tmpdir(), 'scrappyai-verif-tools-'));
  const registry = new ToolRegistry();
  const tools = createVerificationTools({ rootDir: root });

  for (const tool of tools) {
    registry.register(tool);
  }

  assert.equal(registry.has('verify_file'), true);
  assert.equal(registry.has('verify_command'), true);
  assert.equal(registry.has('verify_json'), true);
  assert.equal(registry.has('verify_suite'), true);

  writeFileSync(join(root, 'data.json'), '{"active": true}');

  const fileRes = await registry.execute('verify_file', { path: 'data.json', contains: 'active' });
  assert.equal(fileRes.ok, true);

  const jsonRes = await registry.execute('verify_json', { path: 'data.json', requiredKeys: ['active'] });
  assert.equal(jsonRes.ok, true);
});
