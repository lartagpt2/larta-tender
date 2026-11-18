import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pg from 'pg';
import { isolatedRun } from '../testing/isolated-run.mjs';
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
const run = await isolatedRun('task011c-integration'),
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
  results.push({ name, status: 'PASS' });
  console.log('PASS ' + name);
};
const repo = new intake.PgIntakeRepository(pool);
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
  return app;
}
try {
  for (const id of [actor, reviewer, outsider])
    await pool.query(
      "INSERT INTO tender_app.app_user(id,external_subject,display_name) VALUES($1,$2,'Synthetic C tester')",
      [id, 'synthetic:' + id],
    );
  const owner = await start(),
    readOnly = await start(reviewer),
    other = await start(outsider);
  const request = (app, method, url, payload) => app.inject({ method, url, headers: auth, payload });
  const make = async (label) => {
    const r = await request(owner, 'POST', '/api/tenders', { title: 'SYNTHETIC TASK011C ' + label });
    assert.equal(r.statusCode, 201, r.body);
    return r.json().id;
  };
  const url = (tender) => '/api/tenders/' + tender + '/intake';
  const upload = async (tender, files, key = randomUUID(), app = owner) => {
    const form = multipart(files);
    return app.inject({
      method: 'POST',
      url: url(tender) + '/batches',
      headers: { ...auth, ...form.headers, 'idempotency-key': key },
      payload: form.payload,
    });
  };
  const get = async (tender, path = '/companies', app = owner) => {
    const r = await request(app, 'GET', url(tender) + path);
    assert.equal(r.statusCode, 200, r.body);
    return r.json();
  };
  const accepted = async (tender, files, key, app) => {
    const r = await upload(tender, files, key, app);
    assert.equal(r.statusCode, 201, r.body);
    assert.ok(
      r.json().outcomes.every((o) => o.status === 'accepted'),
      r.body,
    );
    return r.json();
  };
  const tender = await make('10 to 3 to 0'),
    foreign = await make('foreign context');
  await pool.query("INSERT INTO tender_app.tender_member(tender_id,user_id,role) VALUES($1,$2,'reviewer')", [
    tender,
    reviewer,
  ]);
  phase = 'main runtime 10 to 3 to 0';
  for (const table of [
    'supplier',
    'tender_supplier',
    'intake_company',
    'intake_organization_observation',
    'intake_evidence',
  ])
    assert.equal(await count(table), 0, table);
  const files = tenFiles(),
    key = randomUUID(),
    batch = await accepted(tender, files, key),
    registry = await get(tender),
    rows = await get(tender, '/documents');
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
    const download = await request(owner, 'GET', url(tender) + '/originals/' + row.originalId + '/download');
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
  const originals = (
    await pool.query('SELECT * FROM tender_app.intake_document WHERE tender_id=$1 ORDER BY id', [tender])
  ).rows;
  const receipts = (
    await pool.query('SELECT * FROM tender_app.intake_receipt WHERE tender_id=$1 ORDER BY id', [tender])
  ).rows;
  const initial = (
    await pool.query(
      'SELECT * FROM tender_app.intake_classification_revision WHERE tender_id=$1 AND revision=1 ORDER BY id',
      [tender],
    )
  ).rows;
  const evidenceBefore = (
    await pool.query('SELECT * FROM tender_app.intake_evidence WHERE tender_id=$1 ORDER BY id', [tender])
  ).rows;
  ok(
    '10 actual mixed PDF/TXT/XLSX/EML files -> 3 preliminary companies -> 0 confirmed/business suppliers; 2 unassigned receipts; per-field evidence and exact original SHA',
  );
  phase = 'idempotency and concurrency';
  assert.equal((await upload(tender, files, key)).statusCode, 200);
  const beforeCounts = await count('intake_company', tender);
  const orgResult = (
    await pool.query(
      'SELECT id FROM tender_app.intake_organization_result WHERE tender_id=$1 ORDER BY id LIMIT 1',
      [tender],
    )
  ).rows[0].id;
  await Promise.all([
    repo.replayOrganizations(actor, tender, orgResult),
    repo.replayOrganizations(actor, tender, orgResult),
  ]);
  assert.equal(await count('intake_company', tender), beforeCounts);
  const concurrent = await make('concurrent'),
    concurrentKey = randomUUID();
  const replies = await Promise.all([
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
  const same = await Promise.all([
    upload(concurrent, [txt('c.txt', seller('Synthetic Concurrent'))], concurrentKey),
    upload(concurrent, [txt('c.txt', seller('Synthetic Concurrent'))], concurrentKey),
  ]);
  assert.deepEqual(same.map((r) => r.statusCode).sort(), [200, 201]);
  assert.equal(await count('intake_company', concurrent), 1);
  assert.equal(await count('intake_organization_observation', concurrent), 3);
  const receipt = rows.find((r) => r.name === 'two.txt');
  const reprocessed = await request(
    owner,
    'POST',
    url(tender) + '/receipts/' + receipt.receiptId + '/reprocess',
    { expectedRevision: receipt.revision, reason: 'Synthetic explicit C reprocess' },
  );
  assert.equal(reprocessed.statusCode, 201, reprocessed.body);
  assert.equal(await count('intake_company', tender), 3);
  assert.equal(
    (
      await request(owner, 'POST', url(tender) + '/receipts/' + receipt.receiptId + '/reprocess', {
        expectedRevision: receipt.revision,
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
  phase = 'role and weak identity matrix';
  const matrix = await make('roles and weak identities');
  const matrices = [
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
  const matrixCards = await get(matrix);
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
  const ids = await make('different strong IDs same name');
  await accepted(ids, [
    txt('one.txt', seller('Synthetic Same Legal Name', alpha)),
    txt('two.txt', seller('Synthetic Same Legal Name', beta)),
  ]);
  assert.equal(await count('intake_company', ids), 2);
  const contradictory = await make('parallel contradictory observations');
  const contradictoryReplies = await Promise.all([
    upload(contradictory, [txt('a.txt', seller('Synthetic Contradictory Name', alpha))]),
    upload(contradictory, [txt('b.txt', seller('Synthetic Contradictory Name', beta))]),
  ]);
  assert.ok(contradictoryReplies.every((r) => r.statusCode === 201));
  assert.equal(await count('intake_company', contradictory), 2);
  assert.equal(await count('intake_identity_claim', contradictory), 2);
  const multipleSellers = await make('two explicit sellers one document');
  await accepted(multipleSellers, [
    txt('two-sellers.txt', seller('Synthetic Seller A', alpha) + '; ' + seller('Synthetic Seller B', beta)),
  ]);
  const multipleCards = await get(multipleSellers);
  assert.equal(multipleCards.items.length, 2);
  assert.ok(multipleCards.items.every((c) => c.reviewState === 'proposed'));
  const leading = await make('leading zero identifier');
  const leadingValue = inn('012345678');
  await accepted(leading, [txt('leading.txt', seller('Synthetic Leading Zero', leadingValue))]);
  assert.equal(
    (
      await pool.query('SELECT normalized_value FROM tender_app.intake_identity_claim WHERE tender_id=$1', [
        leading,
      ])
    ).rows[0].normalized_value,
    leadingValue,
  );
  const emails = await make('same email different names');
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
  phase = 'current tender participants only';
  // Explicit pre-existing participant controls are seeded only AFTER the empty 10->3->0 acceptance.
  const existing = randomUUID(),
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
  const unknownForeignTaxScheme = randomUUID();
  await pool.query(
    "INSERT INTO tender_app.supplier(id,legal_name,tax_id,country) VALUES($1,'Synthetic GB Untyped Tax','12345678','GB')",
    [unknownForeignTaxScheme],
  );
  await pool.query('INSERT INTO tender_app.tender_supplier(tender_id,supplier_id) VALUES($1,$2)', [
    ids,
    unknownForeignTaxScheme,
  ]);
  const businessSnapshot = async () => ({
    supplier: (await pool.query('SELECT * FROM tender_app.supplier ORDER BY id')).rows,
    member: (await pool.query('SELECT * FROM tender_app.tender_supplier ORDER BY tender_id,supplier_id'))
      .rows,
    versions: (await pool.query('SELECT * FROM tender_app.offer_version ORDER BY id')).rows,
    documents: (await pool.query('SELECT * FROM tender_app.document ORDER BY id')).rows,
  });
  const businessBefore = await businessSnapshot();
  await accepted(ids, [txt('existing.txt', seller('Synthetic Existing Current', alpha))]);
  const matched = await get(ids);
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
  phase = 'rollback and retry';
  const rollback = await make('atomic rollback');
  const actualQuery = pg.Client.prototype.query;
  let injected = false,
    observationSeen = false;
  pg.Client.prototype.query = function (sql, args, ...rest) {
    if (
      !injected &&
      typeof sql === 'string' &&
      sql.startsWith('INSERT INTO tender_app.intake_company_revision') &&
      args?.[4]?.includes('Synthetic Rollback')
    ) {
      injected = true;
      return actualQuery
        .call(
          this,
          'SELECT count(*)::int n FROM tender_app.intake_organization_observation WHERE tender_id=$1',
          [rollback],
        )
        .then((r) => {
          observationSeen = r.rows[0].n === 1;
          throw new Error('synthetic_transaction_failure_after_observation');
        });
    }
    return actualQuery.call(this, sql, args, ...rest);
  };
  try {
    assert.equal(
      (await upload(rollback, [txt('rollback.txt', seller('Synthetic Rollback'))])).statusCode,
      500,
    );
  } finally {
    pg.Client.prototype.query = actualQuery;
  }
  assert.ok(injected && observationSeen);
  for (const t of [
    'intake_batch',
    'intake_document',
    'intake_receipt',
    'intake_organization_result',
    'intake_organization_observation',
    'intake_company',
    'intake_identity_claim',
    'intake_association_head',
    'intake_review_decision',
  ])
    assert.equal(await count(t, rollback), 0, t);
  await accepted(rollback, [txt('rollback.txt', seller('Synthetic Rollback'))]);
  assert.equal(await count('intake_company', rollback), 1);
  assert.equal(await count('intake_identity_claim', rollback), 1);
  ok(
    'actual SQL transaction rollback after observation leaves no company/claim/receipt/result/decision; retry creates exactly one complete preliminary identity',
  );
  phase = 'SQL guards, authorization and pagination';
  const sqlFail = async (sql, args, codes = ['55000']) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await assert.rejects(client.query(sql, args), (e) => codes.includes(e.code));
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  };
  const observation = (
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
  await sqlFail('TRUNCATE tender_app.intake_review_decision', []);
  const company = registry.items[0].preliminaryCompanyId;
  await sqlFail('UPDATE tender_app.intake_company SET state_revision=state_revision WHERE id=$1', [company]);
  await sqlFail(
    'UPDATE tender_app.intake_company SET state_revision=state_revision+1,confirmed_supplier_id=$2 WHERE id=$1',
    [company, existing],
  );
  await sqlFail('UPDATE tender_app.intake_identity_claim SET normalized_value=$1 WHERE tender_id=$2', [
    '000',
    tender,
  ]);
  const second = (
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
  const current = (
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
  const firstPage = await get(tender, '/companies?limit=1');
  assert.equal(firstPage.items.length, 1);
  assert.ok(firstPage.nextCursor);
  const nextPage = await get(tender, '/companies?limit=1&cursor=' + firstPage.nextCursor);
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
  assert.equal(
    (await upload(tender, [txt('forbidden.txt', seller('Forbidden'))], randomUUID(), readOnly)).statusCode,
    403,
  );
  assert.equal(
    (await request(owner, 'GET', url(foreign) + '/receipts/' + receipt.receiptId)).statusCode,
    404,
  );
  const tables = (
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
  phase = 'LocalAI test port and restart';
  const native = new organizations.NativeOrganizationsExtractor();
  const mockPort = new organizations.TestOrganizationsMock(() => []);
  const mockEmptyApp = await start(actor, new intake.PgIntakeRepository(pool, mockPort));
  const mocked = await make('test mock labelled');
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
  const fixtureInput = {
    tenderId: 'test',
    originalId: 'test',
    receiptId: 'test',
    contractVersion: organizations.organizationSchema,
    pages: [{ page: 1, text: seller('Synthetic Mock') }],
    structure: { mime: 'text/plain' },
  };
  const fixtureOrgs = await native.extract(fixtureInput);
  const positive = await start(
    actor,
    new intake.PgIntakeRepository(pool, new organizations.TestOrganizationsMock(() => fixtureOrgs)),
  );
  const positiveTender = await make('positive marked mock');
  await accepted(positiveTender, [txt('mock.txt', seller('Synthetic Mock'))], undefined, positive);
  const positiveHistory = await get(
    positiveTender,
    '/receipts/' + (await get(positiveTender, '/documents'))[0].receiptId,
  );
  assert.equal(positiveHistory.organizations[0].extraction_method, 'test_mock');
  assert.equal(positiveHistory.organizationResults[0].model, false);
  const spec = await request(owner, 'GET', '/api/openapi.json');
  assert.equal(spec.statusCode, 200);
  assert.ok(
    spec.json().paths['/api/tenders/{id}/intake/companies'].get.responses['200'].content['application/json']
      .schema.properties.items,
  );
  assert.ok(
    spec.json().paths['/api/tenders/{id}/intake/companies'].get.parameters.some((p) => p.name === 'cursor'),
  );
  const expectedAfter = await get(tender);
  await owner.close();
  apps.splice(apps.indexOf(owner), 1);
  const restarted = await promisify(execFile)(
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
  passed = true;
  await json(resolve(run.runRoot, 'task011c-api-results.json'), {
    status: 'PASS',
    results,
    identity: run.identity,
    connections,
    mainConnections: 0,
    modelCalls: 0,
    mainScenario: { documents: 10, preliminaryCompanies: 3, confirmedSuppliers: 0, unassignedReceipts: 2 },
  });
  console.log(
    JSON.stringify({ status: 'PASS', groups: results.length, runRoot: run.runRoot, database: run.database }),
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
