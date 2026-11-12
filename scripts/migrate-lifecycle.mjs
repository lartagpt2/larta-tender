// No connection in preview. Applying to existing DB is a separately approved operator action.
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const name = '003_tender_lifecycle.sql';
const sql = await readFile(resolve(root, 'infra/migrations', name), 'utf8');
const digest = (s) => createHash('sha256').update(s).digest('hex'),
  sha256 = digest(sql);
const args = process.argv.slice(2),
  value = (flag) => args[args.indexOf(flag) + 1];
if (!args.includes('--apply')) {
  console.log(
    JSON.stringify(
      { mode: 'preview', migration: name, sha256, connectsToDatabase: false, changesExistingData: false },
      null,
      2,
    ),
  );
} else {
  const database = value('--database');
  if (
    !args.includes('--database') ||
    !/^larta_test_(task003|task009a_\d+)$/.test(database ?? '') ||
    !args.includes('--reviewed-sha') ||
    value('--reviewed-sha') !== sha256 ||
    !args.includes('--approved-existing-database-upgrade')
  )
    throw Error(
      'Requires a separately approved test database, matching --reviewed-sha and --approved-existing-database-upgrade.',
    );
  config({ path: resolve(root, '.env'), quiet: true });
  if (!['localhost', '127.0.0.1'].includes(process.env.PGHOST)) throw Error('Local test server required.');
  const client = new pg.Client({
    database,
    connectionTimeoutMillis: 5000,
    statement_timeout: 30000,
    lock_timeout: 5000,
  });
  try {
    await client.connect();
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(736003)');
    if ((await client.query('SELECT current_database() db')).rows[0].db !== database)
      throw Error('Database mismatch');
    for (const previous of ['001_initial.sql', '002_domain_foundation.sql']) {
      const expected = digest(await readFile(resolve(root, 'infra/migrations', previous), 'utf8'));
      const applied = (
        await client.query('SELECT sha256::text FROM tender_app.schema_migrations WHERE name=$1', [previous])
      ).rows[0];
      if (applied?.sha256 !== expected) throw Error('Baseline schema not verified');
    }
    if ((await client.query('SELECT 1 FROM tender_app.schema_migrations WHERE name=$1', [name])).rowCount)
      throw Error('Already applied; no replay');
    await client.query(sql);
    await client.query('INSERT INTO tender_app.schema_migrations(name,sha256) VALUES($1,$2)', [name, sha256]);
    await client.query('COMMIT');
    console.log(
      'Approved additive migration committed. No classifications, lifecycle operations or capability grants applied.',
    );
  } catch {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Migration refused or failed; rolled back. Review locally with the database owner.');
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}
