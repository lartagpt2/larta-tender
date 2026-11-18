import assert from 'node:assert/strict';
import pg from 'pg';
import { checked } from '../task008-gate-d/io.mjs';
import { createDisposableDatabase, assertDisposableIdentity } from './disposable-database.mjs';

export function assertTestOrigin(origin) {
  const url = new URL(origin);
  assert.equal(url.protocol, 'http:');
  assert.equal(url.hostname, '127.0.0.1');
  assert.ok(Number(url.port) >= 1024 && !['3000', '5173', '11434'].includes(url.port), 'Protected API/port');
  assert.equal(url.origin, origin);
}
export async function verifyIdentity(client, expected) {
  assertDisposableIdentity(expected.database, expected.runId);
  const row = (
    await client.query(
      'SELECT current_database() database,oid::text "databaseOid",pg_get_userbyid(datdba) owner FROM pg_database WHERE datname=current_database()',
    )
  ).rows[0];
  assert.deepEqual(row, {
    database: expected.database,
    databaseOid: expected.databaseOid,
    owner: expected.owner,
  });
  const markers = (await client.query('SELECT run_id::text,database_oid::text FROM test_control.run')).rows;
  assert.deepEqual(markers, [{ run_id: expected.runId, database_oid: expected.databaseOid }]);
}
export async function isolatedRun(label, runId) {
  // Reject overrides before even opening the administrative connection.
  for (const key of ['DATABASE_URL', 'PGSERVICE', 'PGSERVICEFILE', 'PGOPTIONS'])
    assert.ok(!process.env[key], 'Connection override forbidden: ' + key);
  assert.ok(
    !process.env.PGDATABASE,
    'Inherited PGDATABASE forbidden; credentials are read from ignored .env',
  );
  const run = await createDisposableDatabase(label, runId);
  const options = run.connection;
  for (const [key, value] of Object.entries({
    PGHOST: options.host,
    PGPORT: options.port,
    PGUSER: options.user,
    PGPASSWORD: options.password,
    PGDATABASE: run.database,
    STORAGE_ROOT: run.storageRoot,
    DOCUMENT_AI_ENABLED: 'false',
    TENDER_LIFECYCLE_ENABLED: 'false',
  })) {
    if (value !== undefined) process.env[key] = String(value);
  }
  const original = pg.Client.prototype.connect;
  pg.Client.prototype.connect = function (callback) {
    const work = async () => {
      assert.equal(this.connectionParameters.database, run.database, 'Foreign DB forbidden');
      assert.equal(this.connectionParameters.host, options.host, 'Foreign PostgreSQL host');
      assert.equal(Number(this.connectionParameters.port), options.port);
      assert.equal(this.connectionParameters.user, options.user);
      await original.call(this);
      try {
        await verifyIdentity(this, run.identity);
      } catch (error) {
        await this.end();
        throw error;
      }
    };
    if (callback) {
      work().then(() => callback(null), callback);
      return;
    }
    return work();
  };
  try {
    await verifyIdentity(run.pool, run.identity);
    await checked(run.storageRoot);
  } catch (error) {
    pg.Client.prototype.connect = original;
    await run.close('GUARD_FAILED_RETAINED');
    throw error;
  }
  const close = run.close;
  run.close = async (status) => {
    try {
      return await close(status);
    } finally {
      pg.Client.prototype.connect = original;
    }
  };
  return run;
}
