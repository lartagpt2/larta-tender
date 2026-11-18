import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { assertDisposableIdentity, assertOwnedStorage, assertFreshDatabase } from './disposable-database.mjs';
const id = '12345678-1234-4123-8123-123456789abc';
test('only the exact UUID-derived database is accepted', () => {
  assert.doesNotThrow(() => assertDisposableIdentity('larta_test_run_' + id.replaceAll('-', ''), id));
  for (const database of [
    'postgres',
    'larta_test_task003',
    'larta_test_task009a_20261112124104406',
    'larta_test_run_other',
  ])
    assert.throws(() => assertDisposableIdentity(database, id));
  assert.throws(() => assertDisposableIdentity('larta_test_run_bad', '../../source'));
});
test('existing DB cannot be adopted or overwritten', () => {
  assert.doesNotThrow(() => assertFreshDatabase([]));
  assert.throws(() => assertFreshDatabase([{ oid: '1234' }]));
});
test('storage path must belong to this run, not adjacent runs or originals', () => {
  const root = resolve('temp', 'test-run-guards');
  assert.doesNotThrow(() => assertOwnedStorage(resolve(root, 'storage', 'ab', 'blob'), root));
  for (const path of [
    resolve(root, '..', 'storage-task004'),
    resolve(root, '..', 'other-run', 'storage'),
    resolve(root, 'storage', '..', 'manifest.json'),
  ])
    assert.throws(() => assertOwnedStorage(path, root));
});

test('historical restored-copy writer refuses execution before DB access', async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL('../task009a/validate-migrated-copy.mjs', import.meta.url)),
      '--run',
      '--database',
      'larta_test_task009a_20261112124104406',
    ],
    { encoding: 'utf8', env: { ...process.env, PGHOST: 'unreachable.invalid' } },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Restored-copy fixture creation is disabled/);
});
