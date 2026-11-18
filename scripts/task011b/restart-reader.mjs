import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { verifyIdentity } from '../testing/isolated-run.mjs';
import application from '../../apps/api/dist/application.js';
import tenders from '../../apps/api/dist/data/repository.js';
import scopes from '../../apps/api/dist/data/scope-repository.js';
import intake from '../../apps/api/dist/unified-intake/intake-repository.js';
const [identityText, tender, actor] = process.argv.slice(2),
  identity = JSON.parse(identityText);
assert.equal(process.env.PGDATABASE, identity.database);
assert.notEqual(identity.database, 'larta_test_task003');
const pool = new pg.Pool({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT),
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: identity.database,
});
let app;
try {
  await verifyIdentity(pool, identity);
  const token = randomBytes(32).toString('hex');
  app = await application.createApplication({
    logger: false,
    environment: 'test',
    data: {
      enabled: true,
      token,
      actorId: actor,
      repository: new tenders.PgTenderRepository(pool),
      scopeRepository: new scopes.PgScopeRepository(pool),
      intakeRepository: new intake.PgIntakeRepository(pool),
    },
  });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const result = await app.inject({
    method: 'GET',
    url: '/api/tenders/' + tender + '/intake/documents',
    headers: { authorization: 'Bearer ' + token },
  });
  assert.equal(result.statusCode, 200, result.body);
  console.log(result.body);
} finally {
  await app?.close();
  await pool.end();
}
