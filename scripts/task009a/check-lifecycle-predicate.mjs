// Validates the exact proposed CHECK expression using SELECT only. Never applies a migration.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { repo, json } from '../task008-gate-d/io.mjs';
const sql = await readFile(resolve(repo, 'infra/migrations/003_tender_lifecycle.sql'), 'utf8');
const start = sql.indexOf("CHECK(classification <> 'synthetic'");
assert.ok(start >= 0);
const open = sql.indexOf('(', start);
let depth = 0,
  quoted = false,
  predicate = '';
for (let i = open; i < sql.length; i++) {
  if (sql[i] === "'") {
    if (quoted && sql[i + 1] === "'") {
      i++;
      continue;
    }
    quoted = !quoted;
  }
  if (quoted) continue;
  if (sql[i] === '(') depth++;
  if (sql[i] === ')' && --depth === 0) {
    predicate = sql.slice(open + 1, i);
    break;
  }
}
assert.ok(predicate.includes('classified_ocr_hash'));
const valid = {
  classification: 'synthetic',
  evidence: 'Synthetic evidence only',
  classified_by: '10000000-0000-4000-8000-000000000001',
  classified_at: '2026-11-13T00:00:00Z',
  classified_content_revision: 0,
  classified_ocr_hash: 'a'.repeat(64),
};
const cases = [
  { name: 'valid', ...valid, expected: true },
  ...['evidence', 'classified_by', 'classified_at', 'classified_content_revision', 'classified_ocr_hash'].map(
    (k) => ({ name: k + '_null', ...valid, [k]: null, expected: false }),
  ),
  { name: 'evidence_blank', ...valid, evidence: '          ', expected: false },
  { name: 'evidence_short', ...valid, evidence: 'short', expected: false },
  { name: 'hash_invalid', ...valid, classified_ocr_hash: 'invalid', expected: false },
  { name: 'hash_empty', ...valid, classified_ocr_hash: '', expected: false },
  ...['unclassified', 'working'].map((classification) => ({
    name: classification,
    classification,
    evidence: null,
    classified_by: null,
    classified_at: null,
    classified_content_revision: null,
    classified_ocr_hash: null,
    expected: true,
  })),
  {
    name: 'synthetic_all_null',
    classification: 'synthetic',
    evidence: null,
    classified_by: null,
    classified_at: null,
    classified_content_revision: null,
    classified_ocr_hash: null,
    expected: false,
  },
];
const sha256 = createHash('sha256').update(sql).digest('hex');
const args = process.argv.slice(2),
  value = (flag) => args[args.indexOf(flag) + 1];
if (!args.includes('--run')) {
  console.log(
    JSON.stringify(
      { mode: 'preview', sha256, cases: cases.length, connectsToDatabase: false, migrationApplied: false },
      null,
      2,
    ),
  );
} else {
  const database = args.includes('--database') ? value('--database') : '';
  assert.match(database, /^larta_test_task009a_\d+$/, 'Only a separately approved copy/test database');
  config({ path: resolve(repo, '.env'), quiet: true });
  assert.ok(['localhost', '127.0.0.1'].includes(process.env.PGHOST));
  const c = new pg.Client({
    host: '127.0.0.1',
    database,
    connectionTimeoutMillis: 5000,
    options: '-c default_transaction_read_only=on',
  });
  try {
    await c.connect();
    await c.query('BEGIN READ ONLY');
    assert.equal((await c.query('SELECT current_database() name')).rows[0].name, database);
    assert.equal((await c.query('SHOW transaction_read_only')).rows[0].transaction_read_only, 'on');
    // PostgreSQL CHECK accepts NULL as well as TRUE: IS NOT FALSE reproduces that behavior.
    const rows = (
      await c.query(
        `SELECT name,(${predicate}) AS predicate,(${predicate}) IS NOT FALSE AS check_accepts FROM jsonb_to_recordset($1::jsonb) AS x(name text,classification text,evidence text,classified_by uuid,classified_at timestamptz,classified_content_revision bigint,classified_ocr_hash text) ORDER BY name`,
        [JSON.stringify(cases)],
      )
    ).rows;
    for (const row of rows)
      assert.equal(row.check_accepts, cases.find((x) => x.name === row.name).expected, row.name);
    await c.query('ROLLBACK');
    const result = {
      at: new Date().toISOString(),
      database,
      sha256,
      migrationApplied: false,
      readOnly: true,
      cases: rows,
      status: 'PASS',
    };
    if (args.includes('--report')) await json(resolve(value('--report')), result);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await c.end();
  }
}
