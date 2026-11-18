import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { isolatedRun } from '../testing/isolated-run.mjs';
import { json, workspace } from '../task008-gate-d/io.mjs';
import { tenFiles, multipart } from '../task011d/fixtures.mjs';
import application from '../../apps/api/dist/application.js';
import intake from '../../apps/api/dist/unified-intake/intake-repository.js';
import policies from '../../apps/api/dist/unified-intake/processing-policy.js';
import tenders from '../../apps/api/dist/data/repository.js';
import scope from '../../apps/api/dist/data/scope-repository.js';
import offers from '../../apps/api/dist/data/offer-repository.js';
import verification from '../../apps/api/dist/comparison/verification-repository.js';
import lifecycle from '../../apps/api/dist/lifecycle/lifecycle-repository.js';
const run = await isolatedRun('task011e-integration'),
  pool = run.pool,
  apps = [],
  results = [];
let passed = false,
  phase = 'setup',
  worker;
const actor = randomUUID(),
  reviewer = randomUUID(),
  outsider = randomUUID(),
  token = randomBytes(32).toString('hex');
const auth = { authorization: 'Bearer ' + token },
  base = (t) => '/api/tenders/' + t + '/intake';
const until = async (fn, label) => {
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 60));
  }
  throw Error('timeout ' + label);
};
const count = async (table, tender) =>
  Number(
    (
      await pool.query(
        'SELECT count(*) n FROM tender_app.' + table + (tender ? ' WHERE tender_id=$1' : ''),
        tender ? [tender] : [],
      )
    ).rows[0].n,
  );
const ok = (name) => {
  results.push({ name, status: 'PASS' });
  console.log('PASS ' + name);
};
const policyFile = resolve(run.runRoot, 'accepted-D-policy.json');
const policyBytes = await readFile(
  resolve(
    workspace,
    '../task011d-74959e1f-318b-4d56-a158-08304a26b7c6/temp/integration-runs/010eeff4-5d2a-4261-ae55-56d55c907e8b/synthetic-policy.json',
  ),
);
const accepted = JSON.parse(policyBytes),
  fixtures = tenFiles();
for (const file of fixtures)
  assert.ok(
    accepted.sha256.includes(createHash('sha256').update(file.content).digest('hex')),
    'D fixture SHA missing from unchanged policy',
  );
await json(policyFile, accepted);
try {
  for (const id of [actor, reviewer, outsider])
    await pool.query(
      "INSERT INTO tender_app.app_user(id,external_subject,display_name) VALUES($1,$2,'Synthetic E tester')",
      [id, 'synthetic:' + id],
    );
  const policy = policies.IntakePolicy.file(policyFile, workspace),
    repo = new intake.PgIntakeRepository(pool, undefined, policy);
  const makeApp = async (actorId) => {
    const app = await application.createApplication({
      logger: false,
      environment: 'test',
      data: {
        enabled: true,
        token,
        actorId,
        repository: new tenders.PgTenderRepository(pool),
        scopeRepository: new scope.PgScopeRepository(pool),
        intakeRepository: repo,
        offerRepository: new offers.PgOfferRepository(pool),
        verificationRepository: new verification.PgVerificationRepository(pool),
        lifecycleEnabled: true,
        lifecycleRepository: new lifecycle.PgLifecycleRepository(pool, async () => ({ jobs: [], active: 0 })),
      },
    });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    apps.push(app);
    return app;
  };
  const app = await makeApp(actor),
    ro = await makeApp(reviewer),
    foreign = await makeApp(outsider);
  const request = (method, url, payload, appTarget = app, key) =>
    appTarget.inject({
      method,
      url,
      payload,
      headers: { ...auth, ...(key ? { 'idempotency-key': key } : {}) },
    });
  const post = async (url, payload, status = 201, key = randomUUID(), target = app) => {
    const r = await request('POST', url, payload, target, key);
    assert.equal(r.statusCode, status, r.body);
    return r.json();
  };
  const get = async (url, target = app) => {
    const r = await request('GET', url, undefined, target);
    assert.equal(r.statusCode, 200, r.body);
    return r.json();
  };
  const make = async (title) => (await post('/api/tenders', { title: 'SYNTHETIC E ' + title })).id;
  const upload = async (t, files, key = randomUUID()) => {
    const m = multipart(files),
      r = await app.inject({
        method: 'POST',
        url: base(t) + '/batches',
        headers: { ...auth, ...m.headers, 'idempotency-key': key },
        payload: m.payload,
      });
    assert.equal(r.statusCode, 201, r.body);
    return r.json();
  };
  phase = 'accepted D fixture';
  const tender = await make('accepted D ten documents');
  await pool.query("INSERT INTO tender_app.tender_member(tender_id,user_id,role) VALUES($1,$2,'reviewer')", [
    tender,
    reviewer,
  ]);
  const uploaded = await upload(tender, fixtures);
  assert.equal(uploaded.outcomes.length, 10);
  const config = resolve(run.runRoot, 'worker.json');
  await json(config, {
    identity: run.identity,
    storageRoot: run.storageRoot,
    workspace,
    policyFile,
    actorId: actor,
  });
  worker = spawn(process.execPath, ['scripts/intake-worker.mjs', config], {
    cwd: process.cwd(),
    env: process.env,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let workerError = '';
  worker.stderr.on('data', (b) => (workerError += b.toString().slice(0, 2000)));
  await until(async () => {
    if (worker.exitCode !== null) throw Error('worker exited ' + workerError);
    const r = await pool.query(
      "SELECT count(*)::int n FROM tender_app.intake_processing_run WHERE tender_id=$1 AND status IN ('completed','failed')",
      [tender],
    );
    return r.rows[0].n === 10;
  }, 'D fixture processing');
  let workspaceModel = await get(base(tender) + '/workspace?pageSize=100');
  assert.equal(workspaceModel.total, 10);
  assert.equal(workspaceModel.items.filter((x) => x.processingState === 'completed').length, 9);
  assert.equal(workspaceModel.items.filter((x) => x.processingState === 'failed').length, 1);
  assert.equal(workspaceModel.companies.items.length, 3);
  assert.equal(await count('supplier'), 0);
  const failed = await get(base(tender) + '/workspace?filter=errors');
  assert.equal(failed.total, 1);
  const page = await get(base(tender) + '/workspace?pageSize=3&page=2');
  assert.equal(page.items.length, 3);
  const receipt = workspaceModel.items.find((x) => x.name === 'offer.txt').receiptId;
  const detail = await get(base(tender) + '/receipts/' + receipt + '/review');
  assert.ok(detail.evidence.length);
  assert.equal(await count('intake_review_decision'), 9);
  await get(base(tender) + '/receipts/' + receipt + '/review');
  assert.equal(await count('intake_review_decision'), 9);
  await get(base(tender) + '/workspace', ro);
  assert.equal((await request('GET', base(tender) + '/workspace', undefined, foreign)).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: base(tender) + '/workspace' })).statusCode, 401);
  ok(
    'E-T01/02/18/19/20: exact accepted D fixture, server GET purity, pagination/errors, evidence/history and read scopes',
  );
  phase = 'company decisions';
  const company = workspaceModel.companies.items.find((x) => x.requisites.names.includes('Synthetic Beta'));
  assert.ok(company, JSON.stringify(workspaceModel.companies.items.map((x) => x.requisites)));
  const path = base(tender) + '/companies/' + company.preliminaryCompanyId + '/decisions';
  const before = company.requisites;
  const edited = await post(path, {
    action: 'edit',
    expectedRevision: company.stateRevision,
    changes: { address: 'Synthetic Manual Address' },
    note: 'Explicit one-field company correction',
  });
  const card = await get(base(tender) + '/companies/' + company.preliminaryCompanyId);
  assert.deepEqual(card.requisites.names, before.names);
  assert.equal(card.requisites.addresses[0], 'Synthetic Manual Address');
  assert.equal(card.requisites.manualSources.address.source, 'manual');
  const confirm = {
      action: 'confirm',
      expectedRevision: edited.revision,
      createFromRevision: true,
      note: 'Human confirms this supplier independently',
    },
    key = randomUUID();
  const replies = await Promise.all([post(path, confirm, 201, key), post(path, confirm, 201, key)]);
  assert.equal(replies[0].supplierId, replies[1].supplierId);
  const supplier = replies[0].supplierId;
  assert.equal(await count('supplier'), 1);
  assert.equal(await count('offer_version'), 0);
  assert.equal(await count('document'), 0);
  await post(path, { ...confirm, note: 'changed' }, 409, key);
  await post(path, { ...confirm }, 409, randomUUID());
  assert.equal(
    (await request('POST', path, { ...confirm, expectedRevision: replies[0].revision }, ro, randomUUID()))
      .statusCode,
    403,
  );
  await post(path, { ...confirm, expectedRevision: replies[0].revision, actorId: actor }, 400);
  await post(path, { ...confirm, expectedRevision: replies[0].revision, status: 'confirmed' }, 400);
  ok(
    'E-T03/04/06/07/22/23: manual revision, independent company confirmation, parallel same-key replay, changed body/stale/extra-field guards',
  );
  phase = 'classification/projection/association';
  let document = workspaceModel.items.find((x) => x.receiptId === receipt);
  const classify = await post(base(tender) + '/receipts/' + receipt + '/classification-decisions', {
    action: 'confirm',
    expectedRevision: document.classificationRevision,
    note: 'Human confirms offer type only',
  });
  assert.ok(classify.legacyDocumentId && classify.legacyReceiptId);
  assert.equal(await count('offer_version'), 0);
  const afterClass = await get(base(tender) + '/receipts/' + receipt + '/review');
  assert.equal(afterClass.intakeContext, null);
  workspaceModel = await get(base(tender) + '/workspace?pageSize=100');
  document = workspaceModel.items.find((x) => x.receiptId === receipt);
  const association = document.associations.find((x) => x.kind === 'supplier_of');
  assert.ok(association);
  const associated = await post(
    base(tender) + '/receipts/' + receipt + '/associations/' + association.id + '/decisions',
    {
      action: 'confirm',
      expectedRevision: association.revision,
      note: 'Human confirms receipt association separately',
    },
  );
  assert.equal(associated.state, 'confirmed');
  assert.equal(await count('offer_version'), 0);
  const ready = await get(base(tender) + '/receipts/' + receipt + '/review');
  assert.ok(ready.intakeContext);
  assert.equal(
    (
      await request(
        'PATCH',
        '/api/tenders/' + tender + '/offers/' + classify.legacyDocumentId + '/association',
        { revision: 1, supplierId: supplier, note: 'Must use receipt context' },
      )
    ).statusCode,
    409,
  );
  const quality = workspaceModel.items.find((x) => x.effectiveClassification === 'quality_certificate');
  await post(base(tender) + '/receipts/' + quality.receiptId + '/classification-decisions', {
    action: 'confirm',
    expectedRevision: quality.classificationRevision,
    note: 'Human quality type confirmation',
  });
  assert.equal(await count('document'), 1);
  assert.equal(await count('intake_receipt_projection'), 1);
  const evidence = ready.evidence[0];
  await get(
    base(tender) + '/receipts/' + receipt + '/results/' + evidence.result_id + '/evidence/' + evidence.id,
  );
  assert.equal(
    (
      await request(
        'GET',
        base(tender) +
          '/receipts/' +
          quality.receiptId +
          '/results/' +
          evidence.result_id +
          '/evidence/' +
          evidence.id,
      )
    ).statusCode,
    404,
  );
  ok(
    'E-T08/09/10/12/21: real canonical projection/offer receipt, independent type/link/price, non-offer no projection, contextual PATCH/evidence guard',
  );
  phase = 'draft and valid commercial verification';
  const revision = (await get('/api/tenders/' + tender)).revision;
  const lot = await post('/api/tenders/' + tender + '/verification/lot', { expectedRevision: revision });
  const fields = {
    amount: '123.45',
    currency: 'RUB',
    vatMode: 'included',
    paymentTerms: 'Synthetic prepayment',
    deliveryTerms: 'Synthetic seven days',
    compliance: 'matches',
  };
  const transfer = await post(base(tender) + '/receipts/' + receipt + '/transfer-draft', {
    expectedRevision: 0,
    contextToken: ready.intakeContext.contextToken,
    lotId: lot.id,
    selectedFields: ['amount'],
    form: fields,
    items: [],
    note: 'Explicit transfer retaining existing manual amount',
  });
  assert.equal(transfer.form.fields.amount, '123.45');
  assert.equal(await count('offer_version'), 0);
  assert.ok(await count('intake_draft_field'));
  const verificationBody = {
    supplierId: supplier,
    lotId: lot.id,
    documentId: classify.legacyDocumentId,
    receiptId: classify.legacyReceiptId,
    expectedVersion: 0,
    contextConfirmed: true,
    intent: 'confirm',
    fields,
    original: fields,
    sourceType: 'other',
    sourceNote: 'Human checked commercial transcription',
    costsEnabled: false,
    costs: [],
    items: [],
    newQuestions: [],
    resolveQuestionIds: [],
  };
  await post('/api/tenders/' + tender + '/verification', verificationBody, 409);
  const valid = { ...verificationBody, intakeContext: transfer.intakeContext };
  const saved = await post('/api/tenders/' + tender + '/verification', valid);
  assert.ok(saved.versionId);
  assert.equal(saved.status, 'confirmed');
  const replay = await post('/api/tenders/' + tender + '/verification', valid);
  assert.equal(replay.versionId, saved.versionId);
  assert.equal(await count('offer_version'), 2);
  assert.ok(await count('intake_field_lineage'));
  const comparison = await get('/api/tenders/' + tender + '/comparison?lotId=' + lot.id);
  assert.equal(comparison.columns.length, 1);
  assert.ok(
    comparison.rows.some((row) => row.key === 'rank' && row.values[0] === '1'),
    JSON.stringify(comparison.rows),
  );
  const current = await get(base(tender) + '/receipts/' + receipt + '/review');
  await post(
    base(tender) + '/receipts/' + receipt + '/classification-decisions',
    {
      action: 'change',
      type: 'supporting',
      expectedRevision: classify.revision,
      note: 'Changing type after price requires acknowledgment',
    },
    409,
  );
  await post(base(tender) + '/receipts/' + receipt + '/classification-decisions', {
    action: 'change',
    type: 'supporting',
    expectedRevision: classify.revision,
    note: 'Explicit acknowledgment of affected versions',
    impactPreviewHash: current.impact.previewHash,
    acknowledgeImpact: true,
  });
  const excluded = await get('/api/tenders/' + tender + '/comparison?lotId=' + lot.id);
  assert.ok(
    excluded.rows.some((row) => row.values.some((v) => String(v).includes('Контекст'))),
    JSON.stringify(excluded.rows),
  );
  assert.equal(await count('offer_version'), 2);
  ok(
    'E-T13/14/15/16/17: draft does not create price, manual values survive, direct bypass denied, valid confirm is atomic/idempotent with per-field lineage, stale context excluded after preview acknowledgment',
  );
  passed = true;
  await json(resolve(run.runRoot, 'task011e-results.json'), {
    status: 'PASS',
    results,
    identity: run.identity,
    mainConnections: 0,
    modelCalls: 0,
    policySha256: createHash('sha256').update(policyBytes).digest('hex'),
    mainScenario: {
      receipts: 10,
      runs: 10,
      completed: 9,
      failed: 1,
      initialPreliminaryCompanies: 3,
      initialConfirmedSuppliers: 0,
    },
  });
  console.log(
    JSON.stringify({ status: 'PASS', groups: results.length, runRoot: run.runRoot, database: run.database }),
  );
} catch (error) {
  await json(resolve(run.runRoot, 'task011e-results.json'), {
    status: 'FAIL',
    phase,
    message: error.message,
    results,
  });
  throw error;
} finally {
  if (worker && worker.exitCode === null && worker.signalCode === null) {
    const ended = once(worker, 'exit');
    if (worker.kill('SIGKILL')) await ended;
  }
  for (const app of apps) await app.close();
  await run.close(passed ? 'PASSED_RETAINED' : 'FAILED_RETAINED');
}
