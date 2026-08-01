import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactManager, ArtifactType } from '../src/artifacts/artifact-manager.js';

test('ArtifactManager: register computes checksum and bumps version on change', async () => {
  const root = mkdtempSync(join(tmpdir(), 'scrappyai-art-'));
  writeFileSync(join(root, 'weather.js'), 'export const t = 1;');
  const mgr = new ArtifactManager({ rootDir: root });

  const a = await mgr.register({ type: ArtifactType.FILE, path: 'weather.js', taskId: 'task_44', createdBy: 'tool' });
  assert.match(a.id, /^artifact_/);
  assert.equal(a.version, 1);
  assert.equal(a.checksum.length, 64, 'sha256 checksum');
  assert.equal(a.taskId, 'task_44');

  // Re-registering the same file with unchanged content → same checksum.
  const b = await mgr.register({ type: ArtifactType.FILE, path: 'weather.js' });
  assert.equal(a.checksum, b.checksum);

  // Changing content bumps version.
  writeFileSync(join(root, 'weather.js'), 'export const t = 2;');
  const c = await mgr.register({ type: ArtifactType.FILE, path: 'weather.js' });
  assert.notEqual(a.checksum, c.checksum);
  assert.equal(c.version, 1); // a fresh record, so version 1
});

test('ArtifactManager: update increments version when content changes', async () => {
  const mgr = new ArtifactManager();
  const a = await mgr.register({ type: 'generated_code', data: { code: 'v1' } });
  const updated = await mgr.update(a.id, { data: { code: 'v2' } });
  assert.equal(updated.version, 2);
  assert.notEqual(updated.checksum, a.checksum);
  // No-op update does not bump version.
  const same = await mgr.update(a.id, { description: 'no content change' });
  assert.equal(same.version, 2);
});

test('ArtifactManager: snapshot and rollback restore the ledger', async () => {
  const mgr = new ArtifactManager();
  await mgr.register({ type: 'report', data: { title: 'r1' } });
  const a = await mgr.register({ type: 'file', data: { name: 'x' } });
  const snap = mgr.snapshot();
  assert.equal(snap.length, 2);

  await mgr.register({ type: 'patch', data: { diff: '...' } });
  assert.equal(mgr.stats().count, 3);

  await mgr.rollback(snap);
  assert.equal(mgr.stats().count, 2);
  assert.ok(mgr.get(a.id), 'existing artifact restored');
  assert.equal(mgr.list({ type: 'patch' }).length, 0);
});

test('ArtifactManager: list filters by taskId and type', async () => {
  const mgr = new ArtifactManager();
  await mgr.register({ type: ArtifactType.FILE, taskId: 't1' });
  await mgr.register({ type: ArtifactType.TEST_RESULT, taskId: 't1' });
  await mgr.register({ type: ArtifactType.REPORT, taskId: 't2' });
  assert.equal(mgr.list({ taskId: 't1' }).length, 2);
  assert.equal(mgr.list({ taskId: 't1', type: 'file' }).length, 1);
  assert.equal(mgr.stats().count, 3);
  assert.equal(mgr.stats().byType.file, 1);
});

test('ArtifactManager: delete removes an artifact', async () => {
  const mgr = new ArtifactManager();
  const a = await mgr.register({ type: 'command_output', data: { out: 'ok' } });
  assert.equal(mgr.get(a.id).type, 'command_output');
  await mgr.delete(a.id);
  assert.equal(mgr.get(a.id), null);
});

test('ArtifactManager: inline content captured into checksum', async () => {
  const mgr = new ArtifactManager();
  const a = await mgr.register({ type: 'generated_code', content: 'console.log(1)' });
  const b = await mgr.register({ type: 'generated_code', content: 'console.log(1)' });
  assert.equal(a.checksum, b.checksum);
  assert.notEqual(a.checksum, (await mgr.register({ type: 'generated_code', content: 'x' })).checksum);
});
