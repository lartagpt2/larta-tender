import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { assertTestOrigin, verifyIdentity } from './isolated-run.mjs';
const runId = '12345678-1234-4123-8123-123456789abc';
const identity = {
  runId,
  database: 'larta_test_run_' + runId.replaceAll('-', ''),
  databaseOid: '42',
  owner: 'test-owner',
};
test('D: protected database overrides refuse before any network connection', () => {
  for (const env of [
    { PGDATABASE: 'larta_test_task003' },
    { DATABASE_URL: 'postgres://localhost/larta_test_task003' },
    { PGOPTIONS: '-c search_path=public' },
  ]) {
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "import { isolatedRun } from './scripts/testing/isolated-run.mjs'; await isolatedRun('guard');",
      ],
      { encoding: 'utf8', env: { ...process.env, PGHOST: 'unreachable.invalid', ...env } },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /forbidden/i);
  }
});
test('E: protected API ports and foreign hosts rejected before HTTP', () => {
  for (const origin of [
    'http://127.0.0.1:3000',
    'http://127.0.0.1:5173',
    'http://127.0.0.1:11434',
    'http://example.com:43101',
    'https://127.0.0.1:43101',
  ])
    assert.throws(() => assertTestOrigin(origin));
  assert.doesNotThrow(() => assertTestOrigin('http://127.0.0.1:43101'));
});
test('identity requires database name, OID, owner and singleton run marker', async () => {
  const row = { database: identity.database, databaseOid: '42', owner: 'test-owner' };
  const marker = { run_id: runId, database_oid: '42' };
  const client = (r, m) => ({ query: async (sql) => ({ rows: sql.includes('pg_database') ? [r] : m }) });
  await verifyIdentity(client(row, [marker]), identity);
  for (const r of [
    { ...row, database: 'larta_test_task003' },
    { ...row, databaseOid: '43' },
    { ...row, owner: 'other' },
  ])
    await assert.rejects(() => verifyIdentity(client(r, [marker]), identity));
  for (const m of [
    [],
    [marker, marker],
    [{ ...marker, run_id: 'wrong' }],
    [{ ...marker, database_oid: '43' }],
  ])
    await assert.rejects(() => verifyIdentity(client(row, m), identity));
});

test('historical portal/model writers are closed before their entry points execute', () => {
  for (const file of [
    'scripts/seed-task008-demo.mjs',
    'scripts/task008-e2e-server.mjs',
    'scripts/task008-gate-d/run.mjs',
    'scripts/task008e/run.mjs',
    'scripts/task008f/run.mjs',
    'scripts/task008f/run-v2.mjs',
    'scripts/task008g/run.mjs',
    'scripts/smoke-task008.mjs',
  ]) {
    const result = spawnSync(process.execPath, [file, '--run', '--run-synthetic'], {
      encoding: 'utf8',
      env: { ...process.env, PGHOST: 'unreachable.invalid' },
    });
    assert.equal(result.status, 1, file);
    assert.match(result.stderr, /TASK-014/, file);
  }
});
