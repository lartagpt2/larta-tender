// Intentionally restricted: never upgrades an existing/shared database.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { config } from 'dotenv';
import pg from 'pg';
const root = fileURLToPath(new URL('../', import.meta.url));
const initial = await readFile(resolve(root, 'infra/migrations/001_initial.sql'), 'utf8');
const proposal = await readFile(resolve(root, 'infra/migrations/002_domain_foundation.sql'), 'utf8');
const digest = (text) => createHash('sha256').update(text).digest('hex');
const hash = digest(proposal);
const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
if (!args.includes('--apply')) {
  console.log(
    JSON.stringify(
      { mode: 'preview', migration: '002_domain_foundation.sql', sha256: hash, connectsToDatabase: false },
      null,
      2,
    ),
  );
} else {
  const database = value('--database');
  if (
    !args.includes('--database') ||
    !/^larta_test_[a-z0-9_]+$/.test(database ?? '') ||
    !args.includes('--reviewed-sha') ||
    value('--reviewed-sha') !== hash
  ) {
    throw new Error(
      'Requires --database larta_test_<name> and --reviewed-sha <current proposal SHA256> after human approval.',
    );
  }
  if (digest(initial) !== '053d98a74502db2bf246a6e7ea3e0ece04b00e89b566dc3b20bc3ab53860b323')
    throw new Error('Applied baseline checksum changed.');
  config({ path: resolve(root, '.env'), quiet: true });
  const client = new pg.Client({ database, connectionTimeoutMillis: 5000, statement_timeout: 30000 });
  try {
    await client.connect();
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(736003)');
    const objects = await client.query(
      "SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND c.relkind IN ('r','p','v','m','S','f') LIMIT 1",
    );
    const schemas = await client.query(
      "SELECT 1 FROM pg_namespace WHERE nspname NOT IN ('public','pg_catalog','information_schema') AND nspname NOT LIKE 'pg_toast%' AND nspname NOT LIKE 'pg_temp%' LIMIT 1",
    );
    if (objects.rowCount || schemas.rowCount)
      throw new Error('Test database must be empty; no automatic baseline or existing database upgrade.');
    await client.query(initial.replace(/^BEGIN;\s*$/m, '').replace(/^COMMIT;\s*$/m, ''));
    await client.query(proposal);
    await client.query(
      'CREATE TABLE tender_app.schema_migrations (name text PRIMARY KEY, sha256 char(64) NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    for (const [name, sql] of [
      ['001_initial.sql', initial],
      ['002_domain_foundation.sql', proposal],
    ])
      await client.query('INSERT INTO tender_app.schema_migrations(name,sha256) VALUES($1,$2)', [
        name,
        digest(sql),
      ]);
    await client.query('COMMIT');
    console.log(
      'Applied 001 and 002 atomically to the explicitly approved empty test database. No fixtures or runtime actor created.',
    );
  } catch {
    await client.query('ROLLBACK').catch(() => {});
    // Avoid logging server errors: they may include connection credentials or data.
    console.error('Migration failed; transaction rolled back. Inspect locally with the database owner.');
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}
