// New synthetic databases only. No cleanup/drop implementation: separate approval is required.
import assert from 'node:assert/strict';
import { readFile, mkdir, lstat, readdir, rename } from 'node:fs/promises';
import { resolve, relative, dirname, isAbsolute } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import pg from 'pg';
import { repo, workspace, checked, json } from '../task008-gate-d/io.mjs';
const sha = (v) => createHash('sha256').update(v).digest('hex');
export const applicationTables = [
  'accreditation_report',
  'app_user',
  'audit_event',
  'blob',
  'calculation_run',
  'comparison',
  'comparison_offer',
  'contact',
  'cost_component',
  'document',
  'document_receipt',
  'document_relation',
  'draft_message',
  'evidence_reference',
  'extracted_field',
  'extraction_run',
  'field_decision',
  'intake_association_head',
  'intake_association_revision',
  'intake_batch',
  'intake_classification_head',
  'intake_classification_revision',
  'intake_commercial_draft',
  'intake_commercial_result',
  'intake_company',
  'intake_company_revision',
  'intake_document',
  'intake_draft_field',
  'intake_evidence',
  'intake_field_lineage',
  'intake_identity_claim',
  'intake_legacy_projection',
  'intake_manual_source',
  'intake_match_proposal',
  'intake_observation_decision',
  'intake_organization_observation',
  'intake_organization_result',
  'intake_processing_checkpoint',
  'intake_processing_operation',
  'intake_processing_run',
  'intake_receipt',
  'intake_receipt_projection',
  'intake_result',
  'intake_review_decision',
  'intake_run_event',
  'intake_verification_context',
  'lifecycle_event',
  'lot',
  'lot_item',
  'offer',
  'offer_item',
  'offer_package',
  'offer_version',
  'schema_migrations',
  'specification_item',
  'stage_response',
  'supplier',
  'tender',
  'tender_capability',
  'tender_lifecycle',
  'tender_member',
  'tender_stage',
  'tender_supplier',
  'upload_batch',
];
export const migrationHashes = {
  '009_intake_observation_review.sql': '92ac6ef4b5359e48dcc0ed2cd064239d8b2c519fcabc8c6aa1a348950ead54e5',
  '008_organization_head_sqlstate.sql': 'f134b146c1e4f4a70096a77740a8c2a048eada4e56b7ce084df289f80663357f',
  '007_intake_business_bridge.sql': '56404d9ffc285dfa22b151222bfa4f8e5ac43e61efd17eca0d0e632c0c61c8ed',
  '006_intake_orchestration.sql': '1293e77a300323aebff5c1d80ed2f28ba6e979548d4a3d260e3510e1123d7310',
  '005_intake_organizations.sql': '600ef2c38c5457685e0dbd57af5f8d4feedefc7094e0c3843c8ec80823972a73',
  '004_unified_intake_foundation.sql': '0b81d88ad462a96c87e7c3a6609b824ccd533b1f0837fcbd413df7a15f98b3d1',
  '001_initial.sql': '053d98a74502db2bf246a6e7ea3e0ece04b00e89b566dc3b20bc3ab53860b323',
  '002_domain_foundation.sql': '896f8133b5f09da8e6fadc650c71d81165c115a6e6ad095df1279619f93e8764',
  '003_tender_lifecycle.sql': 'af1c943240ea3e53092fe3ed86041e522e6132a928b7b9c53dbc67118b5d6b53',
};
export function assertDisposableIdentity(database, runId) {
  assert.match(runId, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.equal(database, 'larta_test_run_' + runId.replaceAll('-', ''));
}
export function assertOwnedStorage(path, runRoot) {
  const rel = relative(resolve(runRoot, 'storage'), resolve(path));
  assert.ok(!rel.startsWith('..') && !isAbsolute(rel), 'Storage outside current run');
}
export function assertFreshDatabase(rows) {
  assert.equal(rows.length, 0, 'Database already exists; no adoption or overwrite');
}
async function atomicJson(path, value) {
  const temp = path + '.' + randomUUID() + '.tmp';
  await json(temp, value);
  await checked(path);
  await rename(temp, path);
}
async function fileManifest(storageRoot) {
  const records = [];
  async function walk(path) {
    await checked(path);
    let s;
    try {
      s = await lstat(path);
    } catch (e) {
      if (e.code === 'ENOENT') return;
      throw e;
    }
    if (s.isDirectory()) {
      for (const name of await readdir(path)) await walk(resolve(path, name));
    } else {
      assert.ok(s.isFile());
      assertOwnedStorage(path, dirname(storageRoot));
      records.push({
        path: relative(storageRoot, path).replaceAll('\\', '/'),
        bytes: s.size,
        sha256: sha(await readFile(path)),
      });
    }
  }
  await walk(storageRoot);
  return records.sort((a, b) => a.path.localeCompare(b.path));
}
export async function createDisposableDatabase(label, runId = randomUUID()) {
  assert.match(label, /^[a-z0-9_-]{1,40}$/);
  assert.ok(
    process.env.TASK014_PGUSER && process.env.TASK014_PGPASSWORD,
    'Explicit process-scoped disposable credentials required; no env-file fallback',
  );
  const env = {
    PGHOST: process.env.TASK014_PGHOST ?? '127.0.0.1',
    PGPORT: process.env.TASK014_PGPORT ?? '5432',
    PGUSER: process.env.TASK014_PGUSER,
    PGPASSWORD: process.env.TASK014_PGPASSWORD,
  };
  assert.ok(['127.0.0.1', 'localhost'].includes(env.PGHOST), 'Local PostgreSQL only');
  assert.equal(String(env.PGPORT || 5432), '5432');
  const database = 'larta_test_run_' + runId.replaceAll('-', '');
  assertDisposableIdentity(database, runId);
  const runRoot = resolve(workspace, 'temp/integration-runs', runId),
    storageRoot = resolve(runRoot, 'storage');
  await checked(runRoot);
  await mkdir(await checked(dirname(runRoot)), { recursive: true });
  await mkdir(runRoot, { recursive: false });
  await checked(storageRoot);
  await mkdir(storageRoot);
  const manifest = {
    version: 1,
    runId,
    label,
    testCase: label,
    database,
    databaseOid: null,
    owner: null,
    runRoot,
    storageRoot,
    createdAt: new Date().toISOString(),
    status: 'PREPARED',
    cleanup: { status: 'NOT_AUTHORIZED', implemented: false },
    migrations: {},
    credentialValuesIncluded: false,
  };
  const path = resolve(runRoot, 'manifest.json');
  await atomicJson(path, manifest);
  const config = {
    host: '127.0.0.1',
    port: 5432,
    user: env.PGUSER,
    password: env.PGPASSWORD,
    connectionTimeoutMillis: 5000,
    statement_timeout: 15000,
    application_name: 'isolated-' + runId,
    options: '',
    ssl: false,
  };
  const admin = new pg.Client({ ...config, database: 'postgres' });
  let created = false;
  try {
    await admin.connect();
    assertFreshDatabase((await admin.query('SELECT oid FROM pg_database WHERE datname=$1', [database])).rows);
    const rights = (
      await admin.query('SELECT current_user owner,rolcreatedb FROM pg_roles WHERE rolname=current_user')
    ).rows[0];
    assert.equal(rights.rolcreatedb, true);
    await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`);
    created = true;
    const identity = (
      await admin.query('SELECT oid::text,pg_get_userbyid(datdba) owner FROM pg_database WHERE datname=$1', [
        database,
      ])
    ).rows[0];
    manifest.databaseOid = identity.oid;
    manifest.owner = identity.owner;
    manifest.status = 'DATABASE_CREATED';
    await atomicJson(path, manifest);
  } catch (e) {
    manifest.status = created ? 'DATABASE_CREATED_INITIALIZATION_FAILED' : 'CREATION_REFUSED';
    manifest.failureCode = e.code ?? 'GUARD_OR_CONNECTION';
    await atomicJson(path, manifest);
    throw e;
  } finally {
    await admin.end();
  }
  const options = { ...config, database };
  const init = new pg.Client(options);
  try {
    await init.connect();
    assert.equal((await init.query('SELECT current_database() db')).rows[0].db, database);
    assert.equal(
      (
        await init.query(
          "SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema')",
        )
      ).rows[0].count,
      '0',
    );
    const verified = (
      await init.query(
        'SELECT oid::text,pg_get_userbyid(datdba) owner FROM pg_database WHERE datname=current_database()',
      )
    ).rows[0];
    assert.equal(verified.oid, manifest.databaseOid);
    assert.equal(verified.owner, manifest.owner);
    await init.query('BEGIN');
    for (const [name, expected] of Object.entries(migrationHashes).sort(([a], [b]) => a.localeCompare(b))) {
      const sql = await readFile(resolve(repo, 'infra/migrations', name), 'utf8');
      assert.equal(sha(sql), expected);
      await init.query(sql.replace(/^BEGIN;\s*$/m, '').replace(/^COMMIT;\s*$/m, ''));
      manifest.migrations[name] = expected;
    }
    await init.query(
      'CREATE TABLE tender_app.schema_migrations(name text PRIMARY KEY,sha256 char(64) NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())',
    );
    for (const [name, hash] of Object.entries(migrationHashes).sort(([a], [b]) => a.localeCompare(b)))
      await init.query('INSERT INTO tender_app.schema_migrations(name,sha256) VALUES($1,$2)', [name, hash]);
    // Instrumentation is installed ONLY in this new DB. Each change is recorded in the SAME transaction.
    await init.query(`CREATE SCHEMA test_control;
   CREATE TABLE test_control.run(run_id uuid PRIMARY KEY,database_oid oid NOT NULL,label text NOT NULL);
   CREATE TABLE test_control.change_event(sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,transaction_id bigint NOT NULL,table_name text NOT NULL,operation text NOT NULL,old_row jsonb,new_row jsonb,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp());
   CREATE FUNCTION test_control.record_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    INSERT INTO test_control.change_event(transaction_id,table_name,operation,old_row,new_row)
    VALUES(txid_current(),TG_TABLE_NAME,TG_OP,CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END,CASE WHEN TG_OP='DELETE' THEN NULL ELSE to_jsonb(NEW) END);
    IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF; END $$;`);
    await init.query('INSERT INTO test_control.run VALUES($1,$2,$3)', [runId, manifest.databaseOid, label]);
    const tables = (
      await init.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema='tender_app' AND table_type='BASE TABLE'",
      )
    ).rows;
    assert.deepEqual(
      tables.map((t) => t.table_name).sort(),
      applicationTables,
      'Unreviewed application tables',
    );
    manifest.applicationTables = [...applicationTables];
    for (const { table_name } of tables) {
      assert.match(table_name, /^[a-z_]+$/);
      await init.query(
        `CREATE TRIGGER test_run_provenance AFTER INSERT OR UPDATE OR DELETE ON tender_app.${table_name} FOR EACH ROW EXECUTE FUNCTION test_control.record_change()`,
      );
    }
    await init.query('COMMIT');
    manifest.status = 'READY';
    await atomicJson(path, manifest);
  } catch (e) {
    await init.query('ROLLBACK').catch(() => {});
    manifest.status = 'INITIALIZATION_FAILED';
    manifest.failureCode = e.code ?? 'GUARD_OR_CONNECTION';
    await atomicJson(path, manifest);
    throw e;
  } finally {
    await init.end();
  }
  const pool = new pg.Pool({ ...options, max: 8 });
  pool.on('connect', (c) => assert.equal(c.connectionParameters.database, database));
  async function capture(status) {
    const c = new pg.Client({ ...options, options: '-c default_transaction_read_only=on' });
    try {
      await c.connect();
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const identity = (
        await c.query(
          'SELECT oid::text,pg_get_userbyid(datdba) owner FROM pg_database WHERE datname=current_database()',
        )
      ).rows[0];
      assert.equal(identity.oid, manifest.databaseOid);
      assert.equal(identity.owner, manifest.owner);
      const marker = (await c.query('SELECT run_id::text,database_oid::text FROM test_control.run')).rows;
      assert.equal(marker.length, 1);
      assert.equal(marker[0].run_id, runId);
      assert.equal(marker[0].database_oid, manifest.databaseOid);
      const tables = (
        await c.query(
          "SELECT table_name FROM information_schema.tables WHERE table_schema='tender_app' AND table_type='BASE TABLE' ORDER BY table_name",
        )
      ).rows;
      const data = {};
      for (const { table_name } of tables) {
        assert.match(table_name, /^[a-z_]+$/);
        const primaryKey = (
          await c.query(
            'SELECT a.attname FROM pg_index i CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(n,pos) JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.n WHERE i.indrelid=$1::regclass AND i.indisprimary ORDER BY k.pos',
            ['tender_app.' + table_name],
          )
        ).rows.map((r) => r.attname);
        assert.ok(primaryKey.length);
        const rows = (
          await c.query(`SELECT to_jsonb(t) value FROM tender_app.${table_name} t ORDER BY to_jsonb(t)::text`)
        ).rows.map((r) => r.value);
        data[table_name] = { primaryKey, count: rows.length, sha256: sha(JSON.stringify(rows)), rows };
      }
      const changes = (await c.query('SELECT * FROM test_control.change_event ORDER BY sequence')).rows;
      for (const [table_name, table] of Object.entries(data)) {
        if (table_name === 'schema_migrations') continue;
        const inserted = changes.filter((e) => e.table_name === table_name && e.operation === 'INSERT');
        for (const row of table.rows)
          assert.ok(
            inserted.some((e) =>
              table.primaryKey.every((k) => JSON.stringify(e.new_row[k]) === JSON.stringify(row[k])),
            ),
            'Unrecorded fixture row',
          );
      }
      await c.query('ROLLBACK');
      await atomicJson(resolve(runRoot, 'database-manifest.json'), { runId, database, data, changes });
      const provenance = changes
        .filter((e) => e.operation === 'INSERT')
        .map((e) => {
          const caseEntry = manifest.tests?.find(
            (t) =>
              new Date(e.recorded_at) >= new Date(t.startedAt) &&
              new Date(e.recorded_at) <= new Date(t.endedAt),
          );
          const keys = data[e.table_name]?.primaryKey || [];
          return {
            runId,
            testCase: caseEntry?.testCase || manifest.label,
            table: e.table_name,
            primaryKey: Object.fromEntries(keys.map((k) => [k, e.new_row[k]])),
            recordedAt: e.recorded_at,
          };
        });
      await atomicJson(resolve(runRoot, 'provenance.json'), provenance);
      manifest.status = status;
      manifest.capturedAt = new Date().toISOString();
      manifest.testUsers = data.app_user?.rows.map((row) => row.id) || [];
      manifest.tableCounts = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v.count]));
      manifest.changeEvents = changes.length;
      manifest.files = await fileManifest(storageRoot);
      manifest.dataManifestSha256 = sha(await readFile(resolve(runRoot, 'database-manifest.json')));
      manifest.manifestComplete = true;
      await atomicJson(path, manifest);
      return manifest;
    } finally {
      await c.end();
    }
  }
  async function close(status = 'RETAINED') {
    await pool.end();
    return capture(status);
  }
  return {
    runId,
    database,
    runRoot,
    storageRoot,
    pool,
    connection: { ...options },
    identity: { runId, database, databaseOid: manifest.databaseOid, owner: manifest.owner },
    async annotate(values) {
      Object.assign(manifest, values);
      await atomicJson(path, manifest);
    },
    migrationHashes: { ...migrationHashes },
    capture,
    close,
  };
}
