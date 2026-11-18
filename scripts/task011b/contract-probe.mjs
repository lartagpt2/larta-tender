import { verifyIdentity } from '../testing/isolated-run.mjs';
import { readFile } from 'node:fs/promises';
import { workspace } from '../task008-gate-d/io.mjs';
import policies from '../../apps/api/dist/unified-intake/processing-policy.js';
import workers from '../../apps/api/dist/unified-intake/intake-worker.js';
import stores from '../../apps/api/dist/storage/file-store.js';
import { drainUntilSettled } from '../task011c/regression-drain.mjs';
import assert from 'node:assert/strict';
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import pg from 'pg';
import { isolatedRun } from '../testing/isolated-run.mjs';
import { checked, json } from '../task008-gate-d/io.mjs';
import application from '../../apps/api/dist/application.js';
import tenders from '../../apps/api/dist/data/repository.js';
import scopes from '../../apps/api/dist/data/scope-repository.js';
import offers from '../../apps/api/dist/data/offer-repository.js';
import lifecycle from '../../apps/api/dist/lifecycle/lifecycle-repository.js';
import intake from '../../apps/api/dist/unified-intake/intake-repository.js';
import { mixedFiles, multipart, xlsx } from './fixtures.mjs';
if (!process.argv.includes('--run')) {
  console.log('Preview only. --run creates a new UUID disposable DB, never source DB.');
  process.exit(0);
}
const seenConnections = [],
  originalConnect = pg.Client.prototype.connect;
pg.Client.prototype.connect = function (...args) {
  seenConnections.push({
    database: this.connectionParameters.database,
    host: this.connectionParameters.host,
  });
  assert.notEqual(this.connectionParameters.database, 'larta_test_task003');
  return originalConnect.apply(this, args);
};
const run = await isolatedRun('task011b-integration'),
  pool = run.pool,
  apps = [],
  results = [];
let phase = 'setup',
  passed = false;
const sha = (b) => createHash('sha256').update(b).digest('hex');
const actor = randomUUID(),
  reviewer = randomUUID(),
  outsider = randomUUID(),
  token = randomBytes(32).toString('hex');
const auth = { authorization: 'Bearer ' + token };
try {
  for (const id of [actor, reviewer, outsider])
    await pool.query(
      "INSERT INTO tender_app.app_user(id,external_subject,display_name) VALUES($1,$2,'Synthetic intake tester')",
      [id, 'synthetic:' + id],
    );
  await verifyIdentity(pool, run.identity);
  assert.equal(process.env.NODE_ENV, 'test');
  const manifestBytes = await readFile(resolve(workspace, 'regression-only-B-contract-manifest.json'));
  assert.equal(sha(manifestBytes), '6f68e91d88f93c897f1a1bf9e7ff5f1afe26085990d102ad64e10cc732e4bc0d');
  const fixtureManifest = JSON.parse(manifestBytes);
  const policy = new policies.IntakePolicy(async () => {
    await verifyIdentity(pool, run.identity);
    return {
      mode: 'synthetic',
      enabled: true,
      sha256: fixtureManifest.fixtures.filter((f) => f.processingAllowed).map((f) => f.sha256),
    };
  });
  const repo = new intake.PgIntakeRepository(pool, undefined, policy),
    life = new lifecycle.PgLifecycleRepository(pool, async () => ({ jobs: [], active: 0 }));
  async function start(actorId = actor) {
    const app = await application.createApplication({
      logger: false,
      environment: 'test',
      data: {
        enabled: true,
        token,
        actorId,
        repository: new tenders.PgTenderRepository(pool),
        scopeRepository: new scopes.PgScopeRepository(pool),
        offerRepository: new offers.PgOfferRepository(pool),
        intakeRepository: repo,
        lifecycleRepository: life,
        lifecycleEnabled: true,
      },
    });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    apps.push(app);
    return app;
  }
  const owner = await start();
  await start(reviewer);
  await start(outsider);
  const req = (app, method, url, payload) => app.inject({ method, url, headers: auth, payload });
  const make = async (title) => {
    const r = await req(owner, 'POST', '/api/tenders', { title });
    assert.equal(r.statusCode, 201, r.body);
    return r.json().id;
  };
  const tender = await make('SYNTHETIC TASK011B main');
  await make('SYNTHETIC TASK011B foreign context');
  const base = '/api/tenders/' + tender;
  await pool.query("INSERT INTO tender_app.tender_member(tender_id,user_id,role) VALUES($1,$2,'reviewer')", [
    tender,
    reviewer,
  ]);
  const upload = async (files, key = randomUUID(), app = owner, path = base + '/intake/batches') => {
    for (const file of files)
      assert.ok(
        fixtureManifest.fixtures.some(
          (f) => f.name === file.name && f.bytes === file.content.length && f.sha256 === sha(file.content),
        ),
        'fixture provenance not yet verified: ' + file.name,
      );
    const form = multipart(files);
    const response = await app.inject({
      method: 'POST',
      url: path,
      headers: { ...auth, ...form.headers, 'idempotency-key': key },
      payload: form.payload,
    });
    if (response.statusCode === 201) {
      const worker = new workers.IntakeWorker(
        pool,
        repo,
        new stores.FileStore(run.storageRoot, workspace),
        'B-regression-' + randomUUID(),
      );
      await drainUntilSettled(repo, worker, pool, run.identity);
    }
    return response;
  };
  phase = 'ten mixed files';
  const files = mixedFiles(),
    key = randomUUID(),
    first = await upload(files, key);
  assert.equal(first.statusCode, 201, first.body);
  const output = first.json();
  assert.equal(output.outcomes.length, 10);
  assert.ok(output.outcomes.every((o) => o.status === 'accepted'));
  const listing = await req(owner, 'GET', base + '/intake/documents');
  assert.equal(listing.statusCode, 200, listing.body);
  const rows = listing.json();
  assert.equal(rows.length, 10);
  const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
  const expected = [
    'specification',
    'offer',
    'quality_certificate',
    'supporting',
    'unknown',
    'unknown',
    'unknown',
    'supporting',
    'offer',
    'specification',
  ];
  for (const [i, f] of files.entries()) assert.equal(byName[f.name].type, expected[i], f.name);
  await json(resolve(run.runRoot, 'B-initial-status-evidence.json'), {
    identity: run.identity,
    documents: rows,
    runs: (
      await pool.query(
        'SELECT id,receipt_id,status,stage,error_code,attempt_count FROM tender_app.intake_processing_run ORDER BY enqueue_order',
      )
    ).rows,
  });
  const formula = {
    name: 'formula.xlsx',
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    content: xlsx('SYNTHETIC', true),
  };
  assert.equal((await upload([formula])).statusCode, 201);
  const formulaRow = (await req(owner, 'GET', base + '/intake/documents'))
    .json()
    .find((x) => x.name === 'formula.xlsx');
  const contracts = [
    {
      originalLine: 129,
      subject: 'six.pdf processingStatus',
      expected: 'unsupported',
      actual: byName['six.pdf'].processingStatus,
      reason: byName['six.pdf'].reason,
    },
    {
      originalLine: 271,
      subject: 'formula.xlsx processingStatus',
      expected: 'unsupported',
      actual: formulaRow.processingStatus,
      reason: formulaRow.reason,
    },
    {
      originalLine: 131,
      subject: 'all initial rows coverage.model===false && coverage.ocr===false',
      expected: true,
      actual: rows.every((r) => r.coverage.model === false && r.coverage.ocr === false),
      affected: rows
        .filter((r) => r.coverage.model !== false || r.coverage.ocr !== false)
        .map((r) => ({ name: r.name, coverage: r.coverage })),
    },
  ].map((c) => ({ ...c, status: c.actual === c.expected ? 'PASS' : 'FAIL' }));
  await json(resolve(run.runRoot, 'B-contract-diagnostics.json'), {
    status: contracts.every((c) => c.status === 'PASS') ? 'PASS' : 'FAIL',
    identity: run.identity,
    contracts,
    formulaRow,
    initialDocuments: rows,
    modelCalls: 0,
  });
  // Diagnostic collection only: never substitutes expected values or marks failure as PASS.
  assert.ok(
    contracts.every((c) => c.status === 'PASS'),
    'original B/D contracts differ; see B-contract-diagnostics.json',
  );
  passed = true;
} catch (error) {
  console.error('FAIL phase=' + phase, error);
  await json(await checked(resolve(run.runRoot, 'task011b-api-results.json')), {
    status: 'FAIL',
    phase,
    message: error.message,
    results,
    connections: seenConnections,
  });
  throw error;
} finally {
  for (const app of apps) await app.close();
  await run.close(passed ? 'PASSED_RETAINED' : 'FAILED_RETAINED');
}
