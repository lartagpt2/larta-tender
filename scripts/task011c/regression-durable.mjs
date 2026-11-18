import { verifyFixtures } from './verify-fixtures.mjs';
import { drainUntilSettled } from './regression-drain.mjs';
import baseAssert from 'node:assert/strict';
const assertionResults = [];
let recording = false;
function checkedAssertion(target, args, label) {
  if (!recording) return Reflect.apply(target, baseAssert, args);
  const group = phase,
    location = (new Error().stack ?? '')
      .split('\n')
      .filter(
        (s) =>
          s.includes('regression-durable.mjs:') &&
          !s.includes('checkedAssertion') &&
          !s.includes('Object.apply') &&
          !s.includes('Object.get'),
      )
      .at(-1);
  const record = (status, error) => {
    const item = { group, assertion: label, status, location, ...(error ? { message: error.message } : {}) };
    assertionResults.push(item);
    if (error) failures.push({ phase: group, assertion: label, message: error.message, location });
  };
  try {
    const value = Reflect.apply(target, baseAssert, args);
    if (value && typeof value.then === 'function')
      return value.then(
        (v) => {
          record('PASS');
          return v;
        },
        (e) => {
          record('FAIL', e);
          throw e;
        },
      );
    record('PASS');
    return value;
  } catch (e) {
    record('FAIL', e);
    throw e;
  }
}
const assert = new Proxy(baseAssert, {
  apply(target, _this, args) {
    return checkedAssertion(target, args, 'assert');
  },
  get(target, key) {
    const value = target[key];
    return typeof value === 'function'
      ? function (...args) {
          return checkedAssertion(value, args, String(key));
        }
      : value;
  },
});

import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pg from 'pg';
import { isolatedRun, verifyIdentity } from '../testing/isolated-run.mjs';
import { regressionPolicy } from './regression-policy.mjs';
import workers from '../../apps/api/dist/unified-intake/intake-worker.js';
import stores from '../../apps/api/dist/storage/file-store.js';
import policies from '../../apps/api/dist/unified-intake/processing-policy.js';
import { workspace } from '../task008-gate-d/io.mjs';
import { json } from '../task008-gate-d/io.mjs';
import application from '../../apps/api/dist/application.js';
import tenders from '../../apps/api/dist/data/repository.js';
import intake from '../../apps/api/dist/unified-intake/intake-repository.js';
import organizations from '../../apps/api/dist/unified-intake/organizations.js';
import { tenFiles, txt, asPdf, seller, inn, alpha, beta, multipart } from './fixtures.mjs';
if (!process.argv.includes('--run')) {
  console.log('Preview only; --run creates a NEW retained UUID disposable DB.');
  process.exit(0);
}
process.env.NODE_ENV = 'test';
const connections = [],
  connect = pg.Client.prototype.connect;
pg.Client.prototype.connect = function (...args) {
  const database = this.connectionParameters.database;
  connections.push(database);
  assert.notEqual(database, 'larta_test_task003');
  return connect.apply(this, args);
};
const fixtureVerification = await verifyFixtures();
const run = await isolatedRun('task011c-durable-regression'),
  pool = run.pool,
  results = [],
  apps = [];
let passed = false,
  phase = 'setup';
const sha = (v) => createHash('sha256').update(v).digest('hex'),
  actor = randomUUID(),
  reviewer = randomUUID(),
  outsider = randomUUID(),
  token = randomBytes(32).toString('hex'),
  auth = { authorization: 'Bearer ' + token };
const ok = (name) => {
  const failed = failures.some((f) => f.phase === phase);
  results.push({ name, status: failed ? 'FAIL' : 'PASS' });
  console.log((failed ? 'FAIL ' : 'PASS ') + name);
};
const nativePolicy = await regressionPolicy(pool, run.identity),
  mockPolicy = await regressionPolicy(pool, run.identity, true);
const repo = new intake.PgIntakeRepository(pool, undefined, nativePolicy);
const ioCounts = { get: 0, put: 0, extract: 0 };
for (const method of ['get', 'put']) {
  const original = stores.FileStore.prototype[method];
  stores.FileStore.prototype[method] = function (...args) {
    ioCounts[method]++;
    return original.apply(this, args);
  };
}
const extractOriginal = intake.PgIntakeRepository.prototype.workerExtract;
intake.PgIntakeRepository.prototype.workerExtract = function (...args) {
  ioCounts.extract++;
  return extractOriginal.apply(this, args);
};
const store = new stores.FileStore(run.storageRoot, workspace),
  appRepos = new Map(),
  failures = [];
await assert.rejects(regressionPolicy(pool, null), /disposable_identity_required/);
await assert.rejects(
  policies.IntakePolicy.file(resolve(workspace, 'regression-only-C-manifest.json'), workspace).current(),
  /invalid_or_unapproved_processing_policy/,
);
let drainChain = Promise.resolve();
const drain = (repository = repo) => {
  const pending = drainChain.then(async () => {
    await verifyIdentity(pool, run.identity);
    const worker = new workers.IntakeWorker(pool, repository, store, 'C-regression-' + randomUUID());
    await drainUntilSettled(repository, worker, pool, run.identity);
  });
  drainChain = pending.catch(() => {});
  return pending;
};
const batchMethod = repo.batch.bind(repo);
repo.batch = async (...args) => {
  try {
    return await batchMethod(...args);
  } catch (error) {
    // This harness processes only controlled synthetic fixtures. Do not log payload/credentials.
    console.error('SYNTHETIC API diagnostic', error.code ?? '', error.message, error.where ?? '');
    throw error;
  }
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
async function start(actorId = actor, repository = repo) {
  const app = await application.createApplication({
    logger: false,
    environment: 'test',
    enableOpenApi: true,
    data: {
      enabled: true,
      token,
      actorId,
      repository: new tenders.PgTenderRepository(pool),
      intakeRepository: repository,
    },
  });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  apps.push(app);
  appRepos.set(app, repository);
  return app;
}
try {
  for (const id of [actor, reviewer, outsider])
    await pool.query(
      "INSERT INTO tender_app.app_user(id,external_subject,display_name) VALUES($1,$2,'Synthetic C tester')",
      [id, 'synthetic:' + id],
    );
  var owner = await start(),
    readOnly = await start(reviewer),
    other = await start(outsider);
  var request = async (app, method, url, payload) => {
    const response = await app.inject({
      method,
      url,
      headers: {
        ...auth,
        ...(method === 'POST' && url.endsWith('/reprocess') ? { 'idempotency-key': randomUUID() } : {}),
      },
      payload,
    });
    if (method === 'POST' && url.endsWith('/reprocess') && response.statusCode === 201)
      await drain(appRepos.get(app));
    return response;
  };
  var make = async (label) => {
    const r = await request(owner, 'POST', '/api/tenders', { title: 'SYNTHETIC TASK011C ' + label });
    assert.equal(r.statusCode, 201, r.body);
    return r.json().id;
  };
  var url = (tender) => '/api/tenders/' + tender + '/intake';
  var upload = async (tender, files, key = randomUUID(), app = owner) => {
    const form = multipart(files);
    const response = await app.inject({
      method: 'POST',
      url: url(tender) + '/batches',
      headers: { ...auth, ...form.headers, 'idempotency-key': key },
      payload: form.payload,
    });
    if (response.statusCode === 201) await drain(appRepos.get(app));
    return response;
  };
  var get = async (tender, path = '/companies', app = owner) => {
    const r = await request(app, 'GET', url(tender) + path);
    assert.equal(r.statusCode, 200, r.body);
    return r.json();
  };
  var accepted = async (tender, files, key, app) => {
    const r = await upload(tender, files, key, app);
    assert.equal(r.statusCode, 201, r.body);
    assert.ok(
      r.json().outcomes.every((o) => o.status === 'accepted'),
      r.body,
    );
    return r.json();
  };
  var tender = await make('10 to 3 to 0'),
    foreign = await make('foreign context');
  await pool.query("INSERT INTO tender_app.tender_member(tender_id,user_id,role) VALUES($1,$2,'reviewer')", [
    tender,
    reviewer,
  ]);
  try {
    phase = 'main runtime 10 to 3 to 0';
    recording = true;
    for (const table of [
      'supplier',
      'tender_supplier',
      'intake_company',
      'intake_organization_observation',
      'intake_evidence',
    ])
      assert.equal(await count(table), 0, table);
    var files = tenFiles(),
      key = randomUUID(),
      batch = await accepted(tender, files, key),
      registry = await get(tender),
      rows = await get(tender, '/documents');
    await json(resolve(run.runRoot, 'C-main-processing.json'), {
      documents: rows,
      registry,
      runs: (
        await pool.query(
          'SELECT id,status,stage,error_code,coverage FROM tender_app.intake_processing_run WHERE tender_id=$1',
          [tender],
        )
      ).rows,
    });
    assert.equal(batch.outcomes.length, 10);
    assert.equal(rows.length, 10);
    assert.equal(registry.items.length, 3);
    assert.equal(registry.unassignedReceipts.length, 2);
    assert.deepEqual(registry.items.map((c) => c.receiptCount).sort(), [2, 3, 3]);
    assert.ok(
      registry.items.every(
        (c) => c.confirmedSupplierId === null && c.supplierRole && c.reviewState === 'proposed',
      ),
      JSON.stringify(registry.items),
    );
    for (const table of ['supplier', 'tender_supplier', 'offer_version', 'document', 'offer'])
      assert.equal(await count(table), 0, table);
    assert.equal(await count('intake_identity_claim', tender), 3);
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int n FROM tender_app.intake_association_revision WHERE state<>'proposed'",
        )
      ).rows[0].n,
      0,
    );
    for (const file of files) {
      const row = rows.find((r) => r.name === file.name);
      assert.ok(row, file.name);
      const download = await request(
        owner,
        'GET',
        url(tender) + '/originals/' + row.originalId + '/download',
      );
      assert.equal(sha(download.rawPayload), sha(file.content));
      const history = await get(tender, '/receipts/' + row.receiptId);
      assert.ok(history.revisions.length && history.organizationResults.length);
      assert.ok(history.organizations.every((o) => o.extraction_method === 'native_labeled'));
      for (const observation of history.organizations)
        for (const [field, eid] of Object.entries(observation.evidence_by_field)) {
          const e = history.evidence.find((e) => e.id === eid);
          assert.ok(e, 'missing ' + field);
          assert.equal(e.resultId, observation.classification_result_id);
          assert.equal(e.sourceSha, row.blobSha256);
        }
    }
    var originals = (
      await pool.query('SELECT * FROM tender_app.intake_document WHERE tender_id=$1 ORDER BY id', [tender])
    ).rows;
    var receipts = (
      await pool.query('SELECT * FROM tender_app.intake_receipt WHERE tender_id=$1 ORDER BY id', [tender])
    ).rows;
    var initial = (
      await pool.query(
        'SELECT * FROM tender_app.intake_classification_revision WHERE tender_id=$1 AND revision=1 ORDER BY id',
        [tender],
      )
    ).rows;
    var evidenceBefore = (
      await pool.query('SELECT * FROM tender_app.intake_evidence WHERE tender_id=$1 ORDER BY id', [tender])
    ).rows;
    baseAssert.equal(
      failures.filter((f) => f.phase === phase).length,
      0,
      '10-to-3-to-0 must pass before participant seeding',
    );
    var mainAcceptance = {
      status: 'PASS',
      documents: rows.length,
      preliminaryCompanies: registry.items.length,
      supplier: await count('supplier'),
      tenderSupplier: await count('tender_supplier'),
      recordedAt: new Date().toISOString(),
    };
    await json(resolve(run.runRoot, 'C-main-acceptance-before-controls.json'), mainAcceptance);
    ok(
      '10 actual mixed PDF/TXT/XLSX/EML files -> 3 preliminary companies -> 0 confirmed/business suppliers; 2 unassigned receipts; per-field evidence and exact original SHA',
    );
  } catch (error) {
    failures.push({ phase, message: error.message, stack: error.stack });
    console.error('FAIL_GROUP ' + phase + ': ' + error.message);
  }
  try {
    phase = 'idempotency and concurrency';
    assert.equal((await upload(tender, files, key)).statusCode, 200);
    var beforeCounts = await count('intake_company', tender);
    var orgResult = (
      await pool.query(
        'SELECT id FROM tender_app.intake_organization_result WHERE tender_id=$1 ORDER BY id LIMIT 1',
        [tender],
      )
    ).rows[0].id;
    try {
      await Promise.all([
        repo.replayOrganizations(actor, tender, orgResult),
        repo.replayOrganizations(actor, tender, orgResult),
      ]);
    } catch (error) {
      failures.push({ phase, assertion: 'parallel organization replay succeeds', message: error.message });
    }
    assert.equal(await count('intake_company', tender), beforeCounts);
    var concurrent = await make('concurrent'),
      concurrentKey = randomUUID();
    var replies = await Promise.all([
      upload(concurrent, [txt('a.txt', seller('Synthetic Concurrent'))]),
      upload(concurrent, [asPdf('b.pdf', seller('Synthetic Concurrent'))]),
    ]);
    assert.ok(
      replies.every((r) => r.statusCode === 201),
      replies.map((r) => r.body).join('\n'),
    );
    assert.equal(await count('intake_company', concurrent), 1);
    assert.equal(await count('intake_organization_observation', concurrent), 2);
    assert.equal(await count('intake_identity_claim', concurrent), 1);
    assert.equal(await count('intake_association_head', concurrent), 2);
    var same = await Promise.all([
      upload(concurrent, [txt('c.txt', seller('Synthetic Concurrent'))], concurrentKey),
      upload(concurrent, [txt('c.txt', seller('Synthetic Concurrent'))], concurrentKey),
    ]);
    assert.deepEqual(same.map((r) => r.statusCode).sort(), [200, 201]);
    assert.equal(await count('intake_company', concurrent), 1);
    assert.equal(await count('intake_organization_observation', concurrent), 3);
    var receipt = rows.find((r) => r.name === 'two.txt');
    var reprocessed = await request(
      owner,
      'POST',
      url(tender) + '/receipts/' + receipt.receiptId + '/reprocess',
      { expectedRunRevision: receipt.runRevision, reason: 'Synthetic explicit C reprocess' },
    );
    assert.equal(reprocessed.statusCode, 201, reprocessed.body);
    assert.equal(await count('intake_company', tender), 3);
    assert.equal(
      (
        await request(owner, 'POST', url(tender) + '/receipts/' + receipt.receiptId + '/reprocess', {
          expectedRunRevision: receipt.runRevision,
          reason: 'Synthetic stale',
        })
      ).statusCode,
      409,
    );
    await assert.rejects(
      repo.replayOrganizations(
        actor,
        tender,
        (
          await pool.query(
            'SELECT id FROM tender_app.intake_organization_result WHERE receipt_id=$1 ORDER BY created_at LIMIT 1',
            [receipt.receiptId],
          )
        ).rows[0].id,
      ),
    );
    assert.deepEqual(
      (await pool.query('SELECT * FROM tender_app.intake_document WHERE tender_id=$1 ORDER BY id', [tender]))
        .rows,
      originals,
    );
    assert.deepEqual(
      (await pool.query('SELECT * FROM tender_app.intake_receipt WHERE tender_id=$1 ORDER BY id', [tender]))
        .rows,
      receipts,
    );
    assert.deepEqual(
      (
        await pool.query(
          'SELECT * FROM tender_app.intake_classification_revision WHERE tender_id=$1 AND revision=1 ORDER BY id',
          [tender],
        )
      ).rows,
      initial,
    );
    for (const e of evidenceBefore)
      assert.deepEqual(
        (await pool.query('SELECT * FROM tender_app.intake_evidence WHERE id=$1', [e.id])).rows[0],
        e,
      );
    ok(
      'parent tender serialization: 2 documents -> 1 company/2 observations/2 associations/1 claim; replay and explicit reprocess preserve identity, receipts, initial classifications and evidence; stale rejected',
    );
  } catch (error) {
    failures.push({ phase, message: error.message, stack: error.stack });
    console.error('FAIL_GROUP ' + phase + ': ' + error.message);
  }
  try {
    phase = 'role and weak identity matrix';
    var matrix = await make('roles and weak identities');
    var matrices = [
      txt('buyer.txt', 'Buyer: Synthetic Only Buyer; Country: RU; INN: ' + alpha),
      txt('maker.txt', 'Manufacturer: Synthetic Only Maker; Country: RU; INN: ' + alpha),
      txt('ambiguous.txt', 'Seller / Buyer: Synthetic Ambiguous; Country: RU; INN: ' + alpha),
      txt('unnamed.txt', 'Seller: ; Country: RU; INN: ' + alpha),
      txt('weak-one.txt', 'Seller: Synthetic Same; Email: shared@example.invalid'),
      txt('weak-two.txt', 'Seller: Synthetic Same; Email: shared@example.invalid'),
      txt('bad.txt', seller('Synthetic Invalid', alpha.slice(0, -1) + ((Number(alpha.at(-1)) + 1) % 10))),
      txt('unknown.txt', 'Seller: Synthetic Foreign; Country: DE; Registration Number: ABC123'),
      txt('conflict.txt', seller('Synthetic Conflict', alpha, 'INN: ' + beta)),
      txt(
        'multi.txt',
        seller('Synthetic Multiple') + '; Manufacturer: Synthetic Multiple; Country: RU; INN: ' + alpha,
      ),
    ];
    await accepted(matrix, matrices);
    var matrixCards = await get(matrix);
    assert.equal(matrixCards.items.length, 6, JSON.stringify(matrixCards.items));
    assert.equal(matrixCards.items.filter((c) => c.name === 'Synthetic Same').length, 2);
    assert.ok(
      matrixCards.items
        .filter((c) => c.name !== 'Synthetic Multiple')
        .every((c) => c.reviewState === 'needs_review'),
    );
    assert.equal(await count('intake_identity_claim', matrix), 1);
    assert.ok(
      matrixCards.items.some(
        (c) => c.requisites.roles.includes('supplier') && c.requisites.roles.includes('manufacturer'),
      ),
    );
    assert.ok(matrixCards.items.some((c) => c.matchProposals.some((m) => m.match_type === 'weak_name')));
    var ids = await make('different strong IDs same name');
    await accepted(ids, [
      txt('one.txt', seller('Synthetic Same Legal Name', alpha)),
      txt('two.txt', seller('Synthetic Same Legal Name', beta)),
    ]);
    assert.equal(await count('intake_company', ids), 2);
    var contradictory = await make('parallel contradictory observations');
    var contradictoryReplies = await Promise.all([
      upload(contradictory, [txt('a.txt', seller('Synthetic Contradictory Name', alpha))]),
      upload(contradictory, [txt('b.txt', seller('Synthetic Contradictory Name', beta))]),
    ]);
    assert.ok(contradictoryReplies.every((r) => r.statusCode === 201));
    assert.equal(await count('intake_company', contradictory), 2);
    assert.equal(await count('intake_identity_claim', contradictory), 2);
    var multipleSellers = await make('two explicit sellers one document');
    await accepted(multipleSellers, [
      txt('two-sellers.txt', seller('Synthetic Seller A', alpha) + '; ' + seller('Synthetic Seller B', beta)),
    ]);
    var multipleCards = await get(multipleSellers);
    assert.equal(multipleCards.items.length, 2);
    assert.ok(multipleCards.items.every((c) => c.reviewState === 'proposed'));
    var leading = await make('leading zero identifier');
    var leadingValue = inn('012345678');
    await accepted(leading, [txt('leading.txt', seller('Synthetic Leading Zero', leadingValue))]);
    assert.equal(
      (
        await pool.query('SELECT normalized_value FROM tender_app.intake_identity_claim WHERE tender_id=$1', [
          leading,
        ])
      ).rows[0].normalized_value,
      leadingValue,
    );
    var emails = await make('same email different names');
    await accepted(emails, [
      txt('one.txt', 'Seller: Synthetic Email A; Email: shared@example.invalid'),
      txt('two.txt', 'Seller: Synthetic Email B; Email: shared@example.invalid'),
    ]);
    assert.equal(await count('intake_company', emails), 2);
    assert.ok(
      (await get(emails)).items.some((c) => c.matchProposals.some((m) => m.match_type === 'weak_email')),
    );
    ok(
      'buyer/manufacturer-only, ambiguous role, missing name, no ID, invalid checksum, unknown foreign scheme, conflicting IDs, multiple evidenced roles, weak names/email and different strong IDs do not falsely merge',
    );
  } catch (error) {
    failures.push({ phase, message: error.message, stack: error.stack });
    console.error('FAIL_GROUP ' + phase + ': ' + error.message);
  }
  try {
    phase = 'current tender participants only';
    baseAssert.equal(mainAcceptance?.status, 'PASS');
    baseAssert.equal(await count('supplier'), 0);
    baseAssert.equal(await count('tender_supplier'), 0);
    await verifyIdentity(pool, run.identity);
    // Owner-approved exactly 3 suppliers / 3 memberships; never pipeline-created.
    // Explicit pre-existing participant controls are seeded only AFTER the empty 10->3->0 acceptance.
    var existing = randomUUID(),
      foreignSupplier = randomUUID();
    for (const [id, name] of [
      [existing, 'Synthetic Existing Current'],
      [foreignSupplier, 'Synthetic Foreign Hidden'],
    ])
      await pool.query(
        "INSERT INTO tender_app.supplier(id,legal_name,tax_id,country,email) VALUES($1,$2,$3,'RU','synthetic@example.invalid')",
        [id, name, alpha],
      );
    await pool.query('INSERT INTO tender_app.tender_supplier(tender_id,supplier_id) VALUES($1,$2),($3,$4)', [
      ids,
      existing,
      foreign,
      foreignSupplier,
    ]);
    var unknownForeignTaxScheme = randomUUID();
    await pool.query(
      "INSERT INTO tender_app.supplier(id,legal_name,tax_id,country) VALUES($1,'Synthetic GB Untyped Tax','12345678','GB')",
      [unknownForeignTaxScheme],
    );
    await pool.query('INSERT INTO tender_app.tender_supplier(tender_id,supplier_id) VALUES($1,$2)', [
      ids,
      unknownForeignTaxScheme,
    ]);
    baseAssert.equal(await count('supplier'), 3);
    baseAssert.equal(await count('tender_supplier'), 3);
    await json(resolve(run.runRoot, 'C-control-seeding.json'), {
      status: 'PASS',
      mainAcceptance,
      supplier: 3,
      tenderSupplier: 3,
      identity: run.identity,
      pipelineCreated: false,
    });
    var businessSnapshot = async () => ({
      supplier: (await pool.query('SELECT * FROM tender_app.supplier ORDER BY id')).rows,
      member: (await pool.query('SELECT * FROM tender_app.tender_supplier ORDER BY tender_id,supplier_id'))
        .rows,
      versions: (await pool.query('SELECT * FROM tender_app.offer_version ORDER BY id')).rows,
      documents: (await pool.query('SELECT * FROM tender_app.document ORDER BY id')).rows,
    });
    var businessBefore = await businessSnapshot();
    await accepted(ids, [txt('existing.txt', seller('Synthetic Existing Current', alpha))]);
    var matched = await get(ids);
    assert.ok(matched.items.some((c) => c.existingParticipantCandidates.includes(existing)));
    assert.ok(matched.items.every((c) => !c.existingParticipantCandidates.includes(foreignSupplier)));
    await accepted(ids, [
      txt(
        'foreign-number.txt',
        'Seller: Synthetic GB Document Name; Country: GB; Company Registration Number: 12345678',
      ),
    ]);
    assert.ok(
      (await get(ids)).items.every((c) => !c.existingParticipantCandidates.includes(unknownForeignTaxScheme)),
    );
    assert.deepEqual(await businessSnapshot(), businessBefore);
    ok(
      'existing current tender supplier produces proposal only; foreign tender supplier never leaks; business supplier/tender_supplier/offer_version/document fingerprints unchanged',
    );
  } catch (error) {
    failures.push({ phase, message: error.message, stack: error.stack });
    console.error('FAIL_GROUP ' + phase + ': ' + error.message);
  }
  try {
    phase = 'rollback and retry';
    // Owner decision: legacy C rolled back synchronous upload (500 / 0 / 0 / 0).
    // Durable D commits upload+enqueue first (201 / 1 / 1 / 1); promotion remains atomic.
    var rollback = await make('atomic rollback');
    var rollbackFile = txt('rollback.txt', seller('Synthetic Rollback'));
    var scopedRows = async (table, client = pool, tenderId = rollback) =>
      (
        await client.query(
          'SELECT * FROM tender_app.' + table + ' t WHERE tender_id=$1 ORDER BY to_jsonb(t)::text',
          [tenderId],
        )
      ).rows;
    var promotionTables = [
      'intake_result',
      'intake_classification_revision',
      'intake_classification_head',
      'intake_evidence',
      'intake_organization_result',
      'intake_organization_observation',
      'intake_company',
      'intake_company_revision',
      'intake_identity_claim',
      'intake_association_revision',
      'intake_association_head',
      'intake_review_decision',
    ];
    var actualQuery = pg.Client.prototype.query;
    var injected = false,
      observationSeen = false,
      committedUpload,
      duringPromotion;
    pg.Client.prototype.query = function (sql, args, ...rest) {
      if (
        !injected &&
        typeof sql === 'string' &&
        sql.startsWith('INSERT INTO tender_app.intake_company_revision') &&
        args?.[4]?.includes('Synthetic Rollback')
      ) {
        injected = true;
        return (async () => {
          duringPromotion = await scopedRows('intake_organization_observation', this);
          observationSeen = duringPromotion.length === 1;
          // Separate connection proves original/receipt/enqueue were committed before promotion.
          committedUpload = {};
          for (const table of ['intake_batch', 'intake_document', 'intake_receipt', 'intake_processing_run'])
            committedUpload[table] = await scopedRows(table);
          throw new Error('synthetic_transaction_failure_after_observation');
        })();
      }
      return actualQuery.call(this, sql, args, ...rest);
    };
    var failedUpload;
    try {
      failedUpload = await upload(rollback, [rollbackFile]);
      assert.equal(failedUpload.statusCode, 201); // Owner-authorized 500 -> 201 only here.
    } finally {
      pg.Client.prototype.query = actualQuery;
    }
    assert.ok(injected && observationSeen);
    for (const t of ['intake_batch', 'intake_document', 'intake_receipt'])
      assert.equal(await count(t, rollback), 1, t); // Owner-authorized three 0 -> 1 checks only here.
    for (const t of promotionTables) assert.equal(await count(t, rollback), 0, t);
    for (const t of ['intake_batch', 'intake_document', 'intake_receipt', 'intake_processing_run'])
      assert.equal(committedUpload[t].length, 1, 'atomic committed ' + t);
    var failedRun = (await scopedRows('intake_processing_run'))[0];
    assert.equal(failedRun.status, 'failed');
    assert.equal(failedRun.error_code, 'permanent_processing_failure');
    var originalBeforeRetry = await scopedRows('intake_document');
    var receiptBeforeRetry = await scopedRows('intake_receipt');
    var receiptId = receiptBeforeRetry[0].id,
      retryKey = randomUUID();
    var retryBody = {
      expectedRunRevision: failedRun.state_revision,
      reason: 'Synthetic explicit retry after promotion rollback',
    };
    var retryRequest = () =>
      owner.inject({
        method: 'POST',
        url: url(rollback) + '/receipts/' + receiptId + '/reprocess',
        headers: { ...auth, 'idempotency-key': retryKey },
        payload: retryBody,
      });
    var retry = await retryRequest();
    assert.equal(retry.statusCode, 201, retry.body);
    await drain();
    assert.equal(await count('intake_company', rollback), 1);
    assert.equal(await count('intake_identity_claim', rollback), 1);
    assert.equal(await count('intake_processing_run', rollback), 2);
    assert.deepEqual(await scopedRows('intake_document'), originalBeforeRetry);
    assert.deepEqual(await scopedRows('intake_receipt'), receiptBeforeRetry);
    var immutableAfterRetry = {};
    for (const t of promotionTables) immutableAfterRetry[t] = await scopedRows(t);
    var replayResponse = await retryRequest();
    assert.equal(replayResponse.statusCode, 201);
    assert.deepEqual(replayResponse.json(), { ...retry.json(), replayed: true });
    await drain();
    var rollbackResult = (await scopedRows('intake_organization_result'))[0];
    await Promise.all([
      repo.replayOrganizations(actor, rollback, rollbackResult.id),
      repo.replayOrganizations(actor, rollback, rollbackResult.id),
    ]);
    for (const t of promotionTables)
      assert.deepEqual(await scopedRows(t), immutableAfterRetry[t], 'immutable replay ' + t);
    assert.equal(await count('intake_processing_run', rollback), 2);
    await json(resolve(run.runRoot, 'C-durable-rollback-proof.json'), {
      status: 'PASS',
      uploadStatus: failedUpload.statusCode,
      committedUpload,
      duringPromotion,
      failedRun,
      promotionRollbackTables: promotionTables,
      retryStatus: retry.statusCode,
      replayStatus: replayResponse.statusCode,
      companyCount: 1,
      claimCount: 1,
      immutableAfterRetry,
    });

    // Independent pre-enqueue SQL fault, using the same authorized rollback.txt bytes.
    var preEnqueueTender = await make('pre-enqueue rollback'),
      preEnqueueSeen = false,
      beforeCommit;
    pg.Client.prototype.query = function (sql, args, ...rest) {
      if (
        !preEnqueueSeen &&
        typeof sql === 'string' &&
        sql.startsWith('INSERT INTO tender_app.intake_processing_run') &&
        args?.[1] === preEnqueueTender
      ) {
        preEnqueueSeen = true;
        return (async () => {
          beforeCommit = {};
          for (const t of ['intake_batch', 'intake_document', 'intake_receipt'])
            beforeCommit[t] = await scopedRows(t, this, preEnqueueTender);
          throw new Error('synthetic_pre_enqueue_failure_before_commit');
        })();
      }
      return actualQuery.call(this, sql, args, ...rest);
    };
    var preEnqueueResponse;
    try {
      preEnqueueResponse = await upload(preEnqueueTender, [rollbackFile]);
    } finally {
      pg.Client.prototype.query = actualQuery;
    }
    assert.equal(preEnqueueResponse.statusCode, 500);
    assert.ok(preEnqueueSeen);
    // Repository inserts batch after enqueue (deferred FK); fault is before enqueue INSERT.
    assert.equal(beforeCommit.intake_batch.length, 0);
    for (const t of ['intake_document', 'intake_receipt']) assert.equal(beforeCommit[t].length, 1);
    for (const t of [
      'intake_batch',
      'intake_document',
      'intake_receipt',
      'intake_processing_run',
      ...promotionTables,
    ])
      assert.equal(await count(t, preEnqueueTender), 0, 'pre-enqueue rollback ' + t);
    await json(resolve(run.runRoot, 'C-pre-enqueue-rollback-proof.json'), {
      status: 'PASS',
      fixture: 'rollback.txt',
      sha256: sha(rollbackFile.content),
      http: preEnqueueResponse.statusCode,
      beforeCommit,
      allUploadAndEnqueueRowsRolledBack: true,
    });
    ok(
      'durable committed upload retained; promotion fault after observation rolls back all partial rows; explicit retry and replay preserve evidence; independent pre-enqueue fault rolls back upload/enqueue',
    );
  } catch (error) {
    failures.push({ phase, message: error.message, stack: error.stack });
    console.error('FAIL_GROUP ' + phase + ': ' + error.message);
  }
  try {
    phase = 'SQL guards, authorization and pagination';
    var sqlFail = async (sql, args, codes = ['55000']) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await assert.rejects(client.query(sql, args), (e) => codes.includes(e.code));
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    };
    var observation = (
      await pool.query(
        'SELECT * FROM tender_app.intake_organization_observation WHERE tender_id=$1 ORDER BY id LIMIT 1',
        [tender],
      )
    ).rows[0];
    await sqlFail('UPDATE tender_app.intake_organization_observation SET name=$2 WHERE id=$1', [
      observation.id,
      'changed',
    ]);
    await sqlFail('DELETE FROM tender_app.intake_organization_observation WHERE id=$1', [observation.id]);
    await sqlFail('TRUNCATE tender_app.intake_organization_observation', [], ['55000', '0A000']);
    // 009 adds an FK child. Include that exact child (no CASCADE) so the original 55000 append-only assertion reaches the parent BEFORE TRUNCATE guard.
    await sqlFail('TRUNCATE tender_app.intake_review_decision, tender_app.intake_observation_decision', []);
    var company = registry.items[0].preliminaryCompanyId;
    await sqlFail('UPDATE tender_app.intake_company SET state_revision=state_revision WHERE id=$1', [
      company,
    ]);
    await sqlFail(
      'UPDATE tender_app.intake_company SET state_revision=state_revision+1,confirmed_supplier_id=$2 WHERE id=$1',
      [company, existing],
    );
    await sqlFail('UPDATE tender_app.intake_identity_claim SET normalized_value=$1 WHERE tender_id=$2', [
      '000',
      tender,
    ]);
    var second = (
      await pool.query(
        'SELECT * FROM tender_app.intake_organization_observation WHERE tender_id=$1 AND receipt_id<>$2 LIMIT 1',
        [tender, observation.receipt_id],
      )
    ).rows[0];
    await sqlFail(
      'INSERT INTO tender_app.intake_organization_observation(id,tender_id,result_id,receipt_id,classification_result_id,local_key,origin_key,role,name,legal_name,country,identifiers,address,emails,contacts,evidence_by_field,extraction_method,review_state,warnings) SELECT $2,tender_id,result_id,receipt_id,classification_result_id,local_key,origin_key,role,name,legal_name,country,identifiers,address,emails,contacts,$3::jsonb,extraction_method,review_state,warnings FROM tender_app.intake_organization_observation WHERE id=$1',
      [observation.id, randomUUID(), JSON.stringify(second.evidence_by_field)],
      ['23514'],
    );
    var current = (
      await pool.query(
        'SELECT * FROM tender_app.intake_company_revision WHERE company_id=$1 ORDER BY revision DESC LIMIT 1',
        [company],
      )
    ).rows[0];
    await sqlFail(
      "INSERT INTO tender_app.intake_company_revision(id,tender_id,company_id,revision,requisites,source_observations,evidence_ids,review_state,reason,source,actor_id) VALUES($1,$2,$3,99,$4,$5,$6,'proposed','synthetic cross tender','system',$7)",
      [
        randomUUID(),
        foreign,
        company,
        current.requisites,
        current.source_observations,
        current.evidence_ids,
        actor,
      ],
      ['23514', '23503'],
    );
    var firstPage = await get(tender, '/companies?limit=1');
    assert.equal(firstPage.items.length, 1);
    assert.ok(firstPage.nextCursor);
    var nextPage = await get(tender, '/companies?limit=1&cursor=' + firstPage.nextCursor);
    assert.notEqual(nextPage.items[0].preliminaryCompanyId, firstPage.items[0].preliminaryCompanyId);
    assert.equal((await get(tender, '/companies?search=Gamma')).items.length, 1);
    assert.equal((await get(tender, '/companies?search=%25')).items.length, 0);
    assert.equal((await get(matrix, '/companies?reviewStatus=needs_review')).items.length, 5);
    for (const query of ['limit=0', 'limit=101', 'cursor=bad', 'reviewStatus=invalid'])
      assert.equal((await request(owner, 'GET', url(tender) + '/companies?' + query)).statusCode, 400, query);
    assert.equal((await owner.inject({ method: 'GET', url: url(tender) + '/companies' })).statusCode, 401);
    assert.equal((await request(other, 'GET', url(tender) + '/companies?actor=' + actor)).statusCode, 404);
    assert.equal((await request(owner, 'GET', url(foreign) + '/companies/' + company)).statusCode, 404);
    assert.equal((await request(other, 'GET', url(tender) + '/companies/' + company)).statusCode, 404);
    assert.equal((await request(readOnly, 'GET', url(tender) + '/companies/' + company)).statusCode, 200);
    var forbiddenBefore = { ...ioCounts },
      forbiddenRunCount = await count('intake_processing_run'),
      forbiddenReceiptCount = await count('intake_receipt');
    assert.equal(
      (await upload(tender, [txt('forbidden.txt', seller('Forbidden'))], randomUUID(), readOnly)).statusCode,
      403,
    );
    assert.deepEqual(ioCounts, forbiddenBefore);
    assert.equal(await count('intake_processing_run'), forbiddenRunCount);
    assert.equal(await count('intake_receipt'), forbiddenReceiptCount);
    await json(resolve(run.runRoot, 'C-forbidden-proof.json'), {
      status: 'CHECKED',
      before: forbiddenBefore,
      after: { ...ioCounts },
      runsUnchanged: (await count('intake_processing_run')) === forbiddenRunCount,
      receiptsUnchanged: (await count('intake_receipt')) === forbiddenReceiptCount,
    });
    assert.equal(
      (await request(owner, 'GET', url(foreign) + '/receipts/' + receipt.receiptId)).statusCode,
      404,
    );
    var tables = (
      await pool.query(
        "SELECT tablename FROM pg_tables WHERE schemaname='tender_app' AND tablename IN ('intake_organization_result','intake_organization_observation','intake_company','intake_company_revision','intake_identity_claim','intake_match_proposal','intake_association_revision','intake_association_head','intake_review_decision') ORDER BY tablename",
      )
    ).rows;
    assert.equal(tables.length, 9);
    for (const t of tables) {
      const triggers = (
        await pool.query('SELECT tgname FROM pg_trigger WHERE tgrelid=$1::regclass AND NOT tgisinternal', [
          'tender_app.' + t.tablename,
        ])
      ).rows.map((r) => r.tgname);
      assert.ok(triggers.includes('lifecycle_guard') && triggers.includes('org_no_truncate'), t.tablename);
    }
    ok(
      'actual SQL append-only/CAS/cross-tender/evidence guards; explicit lifecycle triggers on all 9 tables; read/write auth, actor spoofing, scope, literal search/cursor/limit/review filters',
    );
  } catch (error) {
    failures.push({ phase, message: error.message, stack: error.stack });
    console.error('FAIL_GROUP ' + phase + ': ' + error.message);
  }
  try {
    phase = 'LocalAI test port and restart';
    var native = new organizations.NativeOrganizationsExtractor();
    var mockPort = new organizations.TestOrganizationsMock(() => []);
    var mockEmptyApp = await start(actor, new intake.PgIntakeRepository(pool, mockPort, mockPolicy));
    var mocked = await make('test mock labelled');
    await accepted(mocked, [txt('mock.txt', seller('Synthetic Mock'))], undefined, mockEmptyApp);
    assert.equal(await count('intake_company', mocked), 0);
    assert.equal(
      (
        await pool.query(
          'SELECT extraction_method FROM tender_app.intake_organization_result WHERE tender_id=$1',
          [mocked],
        )
      ).rows[0].extraction_method,
      'test_mock',
    );
    // A labeled positive test mock follows the same validated evidence boundary.
    var fixtureInput = {
      tenderId: 'test',
      originalId: 'test',
      receiptId: 'test',
      contractVersion: organizations.organizationSchema,
      pages: [{ page: 1, text: seller('Synthetic Mock') }],
      structure: { mime: 'text/plain' },
    };
    var fixtureOrgs = await native.extract(fixtureInput);
    var positive = await start(
      actor,
      new intake.PgIntakeRepository(
        pool,
        new organizations.TestOrganizationsMock(() => fixtureOrgs),
        mockPolicy,
      ),
    );
    var positiveTender = await make('positive marked mock');
    await accepted(positiveTender, [txt('mock.txt', seller('Synthetic Mock'))], undefined, positive);
    var positiveHistory = await get(
      positiveTender,
      '/receipts/' + (await get(positiveTender, '/documents'))[0].receiptId,
    );
    assert.equal(positiveHistory.organizations[0].extraction_method, 'test_mock');
    assert.equal(positiveHistory.organizationResults[0].model, false);
    var spec = await request(owner, 'GET', '/api/openapi.json');
    assert.equal(spec.statusCode, 200);
    assert.ok(
      spec.json().paths['/api/tenders/{id}/intake/companies'].get.responses['200'].content['application/json']
        .schema.properties.items,
    );
    assert.ok(
      spec.json().paths['/api/tenders/{id}/intake/companies'].get.parameters.some((p) => p.name === 'cursor'),
    );
    var expectedAfter = await get(tender);
    await owner.close();
    apps.splice(apps.indexOf(owner), 1);
    var restarted = await promisify(execFile)(
      process.execPath,
      [resolve('scripts/task011c/restart-reader.mjs'), JSON.stringify(run.identity), tender, actor],
      { cwd: process.cwd(), env: { ...process.env }, windowsHide: true, maxBuffer: 5 * 1024 * 1024 },
    );
    assert.deepEqual(JSON.parse(restarted.stdout), expectedAfter);
    assert.deepEqual(await businessSnapshot(), businessBefore);
    assert.ok(connections.every((d) => d === 'postgres' || d === run.database));
    ok(
      'disabled adapter/no production models; marked test_mock port is separate from genuine native acceptance; OpenAPI endpoints/queries; fresh child process identity verification and equal persisted registry; no business writes',
    );
  } catch (error) {
    failures.push({ phase, message: error.message, stack: error.stack });
    console.error('FAIL_GROUP ' + phase + ': ' + error.message);
  }
  assert.equal(nativePolicy instanceof policies.IntakePolicy, true);
  assert.equal(
    (await nativePolicy.current()).reason(sha(txt('mock.txt', seller('Synthetic Mock')).content)),
    'sha_not_approved',
  );
  assert.equal(
    (await nativePolicy.current()).reason(sha(txt('forbidden.txt', seller('Forbidden')).content)),
    'sha_not_approved',
  );
  assert.equal(
    (await mockPolicy.current()).reason(sha(txt('forbidden.txt', seller('Forbidden')).content)),
    'sha_not_approved',
  );
  assert.equal(
    (await pool.query('SELECT count(*)::int n FROM tender_app.intake_organization_result WHERE model=true'))
      .rows[0].n,
    0,
  );
  recording = false;
  passed = failures.length === 0;
  if (!passed) process.exitCode = 1;
  await json(resolve(run.runRoot, 'task011c-api-results.json'), {
    status: passed ? 'PASS' : 'FAIL',
    failures,
    manifestSha256: '6f690861d0f43974b978d67573e8d7ea2c4fc5e15799f01d916d1f6359ae99af',
    fixtureVerification,
    assertionResults,
    results,
    identity: run.identity,
    connections,
    mainConnections: 0,
    modelCalls: 0,
    mainScenario: {
      expected: { documents: 10, preliminaryCompanies: 3, confirmedSuppliers: 0, unassignedReceipts: 2 },
      actual: {
        documents: rows.length,
        preliminaryCompanies: registry.items.length,
        unassignedReceipts: registry.unassignedReceipts.length,
      },
    },
  });
  console.log(
    JSON.stringify({
      status: passed ? 'PASS' : 'FAIL',
      groups: results.length,
      failedGroups: new Set(failures.map((f) => f.phase)).size,
      failureCount: failures.length,
      runRoot: run.runRoot,
      database: run.database,
    }),
  );
} catch (error) {
  console.error('FAIL phase=' + phase, error);
  await json(resolve(run.runRoot, 'task011c-api-results.json'), {
    status: 'FAIL',
    phase,
    message: error.message,
    results,
    connections,
  });
  throw error;
} finally {
  for (const app of apps) await app.close();
  await run.close(passed ? 'PASSED_RETAINED' : 'FAILED_RETAINED');
}
