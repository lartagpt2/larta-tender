import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';
import { checked, workspace } from '../task008-gate-d/io.mjs';
import { verifyIdentity } from '../testing/isolated-run.mjs';
import { assertDisposableIdentity, assertOwnedStorage } from '../testing/disposable-database.mjs';
import policyModule from '../../apps/api/dist/unified-intake/processing-policy.js';
import intakeModule from '../../apps/api/dist/unified-intake/intake-repository.js';
import storeModule from '../../apps/api/dist/storage/file-store.js';
export async function runtime(file) {
  const path = await checked(resolve(file)),
    config = JSON.parse(await readFile(path, 'utf8'));
  assertDisposableIdentity(config.identity.database, config.identity.runId);
  assert.equal(process.env.PGDATABASE, config.identity.database);
  assert.equal(process.env.PGHOST, '127.0.0.1');
  assert.equal(process.env.DOCUMENT_AI_ENABLED, 'false');
  assert.ok(process.env.PGUSER && process.env.PGPASSWORD);
  await checked(config.storageRoot);
  assert.equal(resolve(config.workspace), workspace);
  assertOwnedStorage(config.storageRoot, resolve(workspace, 'temp/integration-runs', config.identity.runId));
  await checked(config.policyFile);
  const base = {
    host: process.env.PGHOST,
    port: Number(process.env.PGPORT),
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    database: config.identity.database,
    connectionTimeoutMillis: 5000,
    statement_timeout: 15000,
    query_timeout: 20000,
  };
  const original = pg.Client.prototype.connect;
  pg.Client.prototype.connect = function (callback) {
    const work = async () => {
      assert.equal(this.connectionParameters.database, base.database);
      assert.equal(this.connectionParameters.host, base.host);
      assert.equal(Number(this.connectionParameters.port), base.port);
      assert.equal(this.connectionParameters.user, base.user);
      await original.call(this);
      await verifyIdentity(this, config.identity);
    };
    if (callback) {
      work().then(() => callback(null), callback);
      return;
    }
    return work();
  };
  const pool = new pg.Pool({ ...base, max: 8 });
  await verifyIdentity(pool, config.identity);
  const policy = policyModule.IntakePolicy.file(config.policyFile, config.workspace);
  const repo = new intakeModule.PgIntakeRepository(pool, undefined, policy);
  const store = new storeModule.FileStore(config.storageRoot, config.workspace);
  return { config, pool, policy, repo, store };
}
