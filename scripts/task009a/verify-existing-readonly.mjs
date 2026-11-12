// Existing application DB: metadata/count reads only. Never runs migrations or API writes.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { config } from 'dotenv';
import pg from 'pg';
import { repo, json } from '../task008-gate-d/io.mjs';
config({ path: resolve(repo, '.env'), quiet: true });
assert.equal(process.env.PGDATABASE, 'larta_test_task003');
assert.ok(['localhost', '127.0.0.1'].includes(process.env.PGHOST));
const c = new pg.Client({ options: '-c default_transaction_read_only=on', connectionTimeoutMillis: 5000 });
try {
  await c.connect();
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const readOnly = (await c.query('SHOW transaction_read_only')).rows[0].transaction_read_only;
  assert.equal(readOnly, 'on');
  const status = (
    await c.query(
      "SELECT current_database() db,to_regclass('tender_app.tender_lifecycle')::text AS lifecycle_table,(SELECT count(*)::int FROM tender_app.tender) tenders,(SELECT count(*)::int FROM tender_app.document) documents,(SELECT count(*)::int FROM tender_app.blob) blobs",
    )
  ).rows[0];
  assert.equal(status.lifecycle_table, null, 'No lifecycle migration may have been applied to existing DB');
  const testDatabases = (
    await c.query(
      "SELECT datname FROM pg_database WHERE datname LIKE 'larta_test_task009a_%' ORDER BY datname",
    )
  ).rows.map((r) => r.datname);
  await c.query('ROLLBACK');
  const result = {
    at: new Date().toISOString(),
    transactionReadOnly: readOnly,
    ...status,
    testDatabases,
    testDatabasesRetained: true,
    existingMigrationApplied: false,
  };
  await json(resolve(repo, 'docs/testing/TASK-009A-IMPLEMENTATION/existing-readonly.json'), result);
  console.log(JSON.stringify(result, null, 2));
} finally {
  await c.end();
}
