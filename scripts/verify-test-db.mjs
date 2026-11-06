// Only synthetic data in an explicitly approved disposable database. Fixtures remain.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { config } from 'dotenv';
import pg from 'pg';
import repository from '../apps/api/dist/data/repository.js';
const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
const root = fileURLToPath(new URL('../', import.meta.url));
const hash = createHash('sha256')
  .update(await readFile(resolve(root, 'infra/migrations/002_domain_foundation.sql')))
  .digest('hex');
if (!args.includes('--run')) {
  console.log(
    'Preview only: no database connection. --run requires an approved disposable larta_test_<name> database; synthetic fixtures remain.',
  );
} else {
  const database = value('--database');
  if (
    !args.includes('--database') ||
    !/^larta_test_[a-z0-9_]+$/.test(database ?? '') ||
    !args.includes('--reviewed-sha') ||
    value('--reviewed-sha') !== hash
  )
    throw new Error('Explicit test database and reviewed migration checksum required.');
  config({ path: resolve(root, '.env'), quiet: true });
  const pool = new pg.Pool({ database, max: 4, connectionTimeoutMillis: 5000, statement_timeout: 10000 });
  const uuid = () => randomUUID();
  try {
    const ledger = await pool.query(
      "SELECT sha256 FROM tender_app.schema_migrations WHERE name='002_domain_foundation.sql'",
    );
    assert.equal(ledger.rows[0]?.sha256, hash, 'Reviewed migration must be applied first');
    const actor = uuid(),
      tender = uuid(),
      blob = 'a'.repeat(64),
      lot = uuid(),
      supplier = uuid(),
      pack = uuid(),
      offer = uuid(),
      version = uuid();
    // Unique synthetic blob per run; never reuse or mutate a real original.
    const sha = createHash('sha256').update(uuid()).digest('hex');
    await repository.transaction(pool, async (c) => {
      await c.query('INSERT INTO tender_app.app_user(id,external_subject,display_name) VALUES($1,$2,$3)', [
        actor,
        `synthetic:${actor}`,
        'Synthetic tester',
      ]);
      await c.query('INSERT INTO tender_app.tender(id,title,created_by,owner_id) VALUES($1,$2,$3,$3)', [
        tender,
        'Synthetic integration tender',
        actor,
      ]);
      await c.query('INSERT INTO tender_app.blob(sha256,storage_key,byte_size) VALUES($1,$2,1)', [
        sha,
        `synthetic/${uuid()}`,
      ]);
      await c.query(
        'INSERT INTO tender_app.lot(id,tender_id,name,ordinal,created_by) VALUES($1,$2,$3,1,$4)',
        [lot, tender, 'Synthetic lot', actor],
      );
      await c.query('INSERT INTO tender_app.supplier(id,legal_name) VALUES($1,$2)', [
        supplier,
        'Synthetic supplier',
      ]);
      await c.query('INSERT INTO tender_app.tender_supplier(tender_id,supplier_id) VALUES($1,$2)', [
        tender,
        supplier,
      ]);
      await c.query('INSERT INTO tender_app.offer_package(id,tender_id,supplier_id) VALUES($1,$2,$3)', [
        pack,
        tender,
        supplier,
      ]);
      await c.query(
        'INSERT INTO tender_app.offer(id,tender_id,supplier_id,lot_id,offer_package_id,created_by) VALUES($1,$2,$3,$4,$5,$6)',
        [offer, tender, supplier, lot, pack, actor],
      );
      await c.query(
        "INSERT INTO tender_app.offer_version(id,offer_package_id,version,created_by,offer_id,lot_id,tender_id,amount,currency,is_initial) VALUES($1,$2,1,$3,$4,$5,$6,'12345678901234.123456','RUB',true)",
        [version, pack, actor, offer, lot, tender],
      );
    });
    const key = uuid();
    const receive = (hash) =>
      repository.transaction(pool, (c) =>
        repository.receiveDocument(c, tender, key, hash, async (id) => {
          await c.query(
            "INSERT INTO tender_app.document(id,tender_id,purpose,original_name,mime_type,blob_sha256,uploaded_by) VALUES($1,$2,'specification','synthetic.txt','text/plain',$3,$4)",
            [id, tender, sha, actor],
          );
          await c.query(
            "INSERT INTO tender_app.audit_event(id,actor_id,tender_id,document_id,action) VALUES($1,$2,$3,$4,'document.received')",
            [uuid(), actor, tender, id],
          );
        }),
      );
    const [a, b] = await Promise.all([receive(blob), receive(blob)]);
    assert.equal(a, b);
    const count = await pool.query('SELECT count(*) FROM tender_app.document WHERE tender_id=$1', [tender]);
    assert.equal(count.rows[0].count, '1');
    await assert.rejects(receive('b'.repeat(64)), (error) => error.getStatus?.() === 409);
    const immutable = async (sql, values) => {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await assert.rejects(c.query(sql, values), (error) => error.code === '55000');
      } finally {
        await c.query('ROLLBACK');
        c.release();
      }
    };
    await immutable('UPDATE tender_app.document SET original_name=$1 WHERE id=$2', ['changed', a]);
    await immutable('DELETE FROM tender_app.audit_event WHERE tender_id=$1', [tender]);
    await immutable('UPDATE tender_app.offer_version SET amount=0 WHERE id=$1', [version]);
    await immutable('DELETE FROM tender_app.blob WHERE sha256=$1', [sha]);
    const amount = await pool.query('SELECT amount FROM tender_app.offer_version WHERE id=$1', [version]);
    assert.equal(amount.rows[0].amount, '12345678901234.123456');
    const scoped = new repository.PgTenderRepository(pool);
    await assert.rejects(scoped.get(uuid(), tender), (error) => error.getStatus?.() === 404);
    console.log(
      'PASS: real concurrent receipts, conflicting key, immutable original/audit/version/blob, exact NUMERIC, inaccessible tender. Synthetic fixtures remain in disposable test database.',
    );
  } catch {
    console.error(
      'Integration checks failed; inspect approved test database locally. No secrets are logged. Synthetic fixtures may remain.',
    );
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
