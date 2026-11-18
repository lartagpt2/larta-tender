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
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isolatedRun } from '../testing/isolated-run.mjs';
import { checked, json } from '../task008-gate-d/io.mjs';
import application from '../../apps/api/dist/application.js';
import tenders from '../../apps/api/dist/data/repository.js';
import scopes from '../../apps/api/dist/data/scope-repository.js';
import offers from '../../apps/api/dist/data/offer-repository.js';
import lifecycle from '../../apps/api/dist/lifecycle/lifecycle-repository.js';
import intake from '../../apps/api/dist/unified-intake/intake-repository.js';
import { mixedFiles, txt, multipart, pdf, xlsx } from './fixtures.mjs';
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
const ok = (name) => {
  results.push({ name, status: 'PASS' });
  console.log('PASS ' + name);
};
const count = async (table) =>
  Number((await pool.query('SELECT count(*) n FROM tender_app.' + table)).rows[0].n);
try {
  for (const id of [actor, reviewer, outsider])
    await pool.query(
      "INSERT INTO tender_app.app_user(id,external_subject,display_name) VALUES($1,$2,'Synthetic intake tester')",
      [id, 'synthetic:' + id],
    );
  await verifyIdentity(pool, run.identity);
  assert.equal(process.env.NODE_ENV, 'test');
  const manifestBytes = await readFile(resolve(workspace, 'regression-only-B-full-manifest.json'));
  assert.equal(sha(manifestBytes), '9516fe047ea8a425f36e7addbf9bcda537d0a633968ded1fcc3e6d8bd5921977');
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
  const owner = await start(),
    readOnly = await start(reviewer),
    other = await start(outsider);
  const req = async (app, method, url, payload) => {
    const headers = { ...auth };
    if (method === 'POST' && url.endsWith('/reprocess')) {
      const receipt = url.split('/').at(-2);
      const current = (
        await pool.query(
          'SELECT state_revision FROM tender_app.intake_processing_run WHERE receipt_id=$1 ORDER BY generation DESC LIMIT 1',
          [receipt],
        )
      ).rows[0];
      payload = { expectedRunRevision: current.state_revision, reason: payload.reason };
      headers['idempotency-key'] = randomUUID();
    }
    const response = await app.inject({ method, url, headers, payload });
    if (method === 'POST' && url.endsWith('/reprocess') && response.statusCode === 201) {
      const worker = new workers.IntakeWorker(
        pool,
        repo,
        new stores.FileStore(run.storageRoot, workspace),
        'B-reprocess-' + randomUUID(),
      );
      await drainUntilSettled(repo, worker, pool, run.identity);
    }
    return response;
  };
  const make = async (title) => {
    const r = await req(owner, 'POST', '/api/tenders', { title });
    assert.equal(r.statusCode, 201, r.body);
    return r.json().id;
  };
  const tender = await make('SYNTHETIC TASK011B main'),
    otherTender = await make('SYNTHETIC TASK011B foreign context');
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
  assert.equal(byName['six.pdf'].reason, 'ocr_required_no_text_layer');
  assert.equal(byName['six.pdf'].processingStatus, 'failed');
  assert.equal(byName['seven.pdf'].processingStatus, 'failed');
  assert.ok(rows.every((r) => r.coverage.model === false && r.coverage.ocr === false));
  for (const f of files) {
    const row = byName[f.name],
      download = await req(owner, 'GET', base + '/intake/originals/' + row.originalId + '/download');
    assert.equal(download.statusCode, 200);
    assert.equal(sha(download.rawPayload), sha(f.content));
    assert.equal(row.blobSha256, sha(f.content));
  }
  for (const table of [
    'supplier',
    'tender_supplier',
    'document',
    'offer_package',
    'offer_version',
    'offer',
    'lot',
  ])
    assert.equal(await count(table), 0, table);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*) n FROM tender_app.intake_processing_run WHERE status IN ('blocked','queued','running','retry_wait')",
      )
    ).rows[0].n,
    '0',
  );
  const failedCoverageProof = [];
  for (const name of ['six.pdf', 'seven.pdf']) {
    const row = byName[name],
      persisted = (
        await pool.query(
          'SELECT status,error_code,attempt_count,coverage FROM tender_app.intake_processing_run WHERE receipt_id=$1',
          [row.receiptId],
        )
      ).rows[0];
    assert.equal(persisted.status, 'failed');
    assert.equal(persisted.attempt_count, 1);
    assert.equal(persisted.coverage.model, false);
    assert.equal(persisted.coverage.ocr, false);
    assert.equal(persisted.coverage.originalVerified, true);
    assert.deepEqual(row.coverage, persisted.coverage);
    failedCoverageProof.push({ name, persisted, readModel: row.coverage });
  }
  const coverageRestart = await promisify(execFile)(
    process.execPath,
    [resolve('scripts/task011b/restart-reader.mjs'), JSON.stringify(run.identity), tender, actor],
    { cwd: process.cwd(), windowsHide: true, timeout: 30000 },
  );
  assert.deepEqual(JSON.parse(coverageRestart.stdout), rows);
  await json(resolve(run.runRoot, 'B-coverage-contract-proof.json'), {
    status: 'PASS',
    identity: run.identity,
    failedCoverageProof,
    restartEqual: true,
    modelCalls: 0,
    ocrCalls: 0,
  });
  ok(
    '10 mixed native/TXT/XLSX/scan/corrupt files: actual content types, honest unknown, 10 exact SHA, no business rows or background jobs',
  );
  phase = 'replay';
  const replay = await upload(files, key);
  assert.equal(replay.statusCode, 200, replay.body);
  assert.deepEqual(replay.json(), output);
  assert.equal(await count('intake_receipt'), 10);
  const batchView = await req(owner, 'GET', base + '/intake/batches/' + output.batchId);
  assert.equal(batchView.statusCode, 200);
  assert.deepEqual(batchView.json().outcomes, output.outcomes);
  const changed = await upload([txt('changed.txt', 'Different')], key);
  assert.equal(changed.statusCode, 409);
  const again = await upload(files);
  assert.equal(again.statusCode, 201);
  assert.equal(await count('intake_document'), 10);
  assert.equal(await count('intake_receipt'), 20);
  const raceKey = randomUUID(),
    race = await Promise.all([
      upload([txt('parallel.txt', 'Коммерческое предложение. SYNTHETIC parallel')], raceKey),
      upload([txt('parallel.txt', 'Коммерческое предложение. SYNTHETIC parallel')], raceKey),
    ]);
  assert.ok(race.every((r) => [200, 201].includes(r.statusCode)));
  assert.deepEqual(race[0].json(), race[1].json());
  assert.equal(
    (
      await pool.query(
        'SELECT count(*) n FROM tender_app.intake_batch WHERE tender_id=$1 AND request_key=$2',
        [tender, raceKey],
      )
    ).rows[0].n,
    '1',
  );
  ok(
    'same-key replay, changed manifest 409, independent receipts with one original, concurrent same-key request',
  );
  phase = 'rename/formats/limits';
  const renamed = await upload([{ ...files[0], name: 'neutral.pdf' }]);
  assert.equal(renamed.statusCode, 201);
  const renamedId = renamed.json().outcomes[0].originalIds[0];
  assert.equal(renamedId, byName['one.pdf'].originalId);
  assert.equal(
    (await req(owner, 'GET', base + '/intake/documents')).json().find((r) => r.name === 'neutral.pdf').type,
    'specification',
  );
  const unsupported = await upload([
    { name: 'blocked.zip', mime: 'application/zip', content: Buffer.from('PKxx') },
    txt('valid.txt', 'Техническое задание. SYNTHETIC'),
  ]);
  assert.equal(unsupported.statusCode, 201);
  assert.equal(unsupported.json().outcomes[0].status, 'rejected');
  assert.equal(unsupported.json().outcomes[1].status, 'accepted');
  const receiptsBeforeLimits = await count('intake_receipt');
  const large = await upload([
    { name: 'too-large.txt', mime: 'text/plain', content: Buffer.alloc(20 * 1024 * 1024 + 1, 65) },
  ]);
  assert.equal(large.statusCode, 413);
  const many = await upload(Array.from({ length: 11 }, (_, i) => txt('file' + i + '.txt', 'SYNTHETIC')));
  assert.ok([400, 413].includes(many.statusCode));
  const total = await upload(
    [0, 1, 2].map((i) => ({
      name: 'large' + i + '.txt',
      mime: 'text/plain',
      content: Buffer.alloc(14 * 1024 * 1024, 65),
    })),
  );
  assert.equal(total.statusCode, 413);
  assert.equal(await count('intake_receipt'), receiptsBeforeLimits);
  const badXlsx = await upload([
    {
      name: 'broken.xlsx',
      mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      content: Buffer.from('PK\x03\x04 damaged'),
    },
  ]);
  assert.equal(badXlsx.json().outcomes[0].status, 'rejected');
  for (const ext of ['msg', 'docx']) {
    const reject = await upload([
      {
        name: 'blocked.' + ext,
        mime: 'application/octet-stream',
        content: Buffer.from('SYNTHETIC unsupported'),
      },
      txt('neighbor.txt', 'SYNTHETIC neighbor'),
    ]);
    assert.equal(reject.statusCode, 201);
    assert.equal(reject.json().outcomes[0].status, 'rejected');
    assert.equal(reject.json().outcomes[1].status, 'accepted');
  }
  const emailBytes = Buffer.from(
    'From: Synthetic <sender@example.test>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="synthetic"\r\n\r\n--synthetic\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename="enclosed.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\n' +
      pdf('SYNTHETIC Commercial offer').toString('base64') +
      '\r\n--synthetic--\r\n',
  );
  const email = await upload([{ name: 'mail.eml', mime: 'message/rfc822', content: emailBytes }]);
  assert.equal(email.statusCode, 201, email.body);
  assert.equal(email.json().outcomes[0].receiptIds.length, 2);
  const emailRows = (await req(owner, 'GET', base + '/intake/documents')).json();
  const childEmail = emailRows.find((x) => x.name === 'enclosed.pdf');
  assert.equal(childEmail.type, 'offer');
  assert.ok(childEmail.parentReceiptId);
  assert.equal(childEmail.declaredSender, 'sender@example.test');
  const formulaUpload = await upload([
    {
      name: 'formula.xlsx',
      mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      content: xlsx('SYNTHETIC', true),
    },
  ]);
  assert.equal(formulaUpload.statusCode, 201);
  const formulaRow = (await req(owner, 'GET', base + '/intake/documents'))
    .json()
    .find((x) => x.name === 'formula.xlsx');
  assert.equal(formulaRow.type, 'unknown');
  assert.equal(formulaRow.processingStatus, 'failed');
  assert.equal(formulaRow.reason, 'xlsx_formula_or_external_unsupported');
  assert.equal(formulaRow.type, 'unknown');
  assert.equal(formulaRow.coverage.model, false);
  assert.equal(formulaRow.coverage.ocr, false);
  assert.equal(formulaRow.coverage.originalVerified, true);
  const formulaRun = (
    await pool.query(
      'SELECT status,attempt_count,error_code,coverage FROM tender_app.intake_processing_run WHERE receipt_id=$1',
      [formulaRow.receiptId],
    )
  ).rows[0];
  assert.equal(formulaRun.status, 'failed');
  assert.equal(formulaRun.attempt_count, 1);
  assert.equal(formulaRun.error_code, 'xlsx_formula_or_external_unsupported');
  assert.deepEqual(formulaRun.coverage, formulaRow.coverage);
  ok(
    'filename independent classification, mixed unsupported rejection, corrupted XLSX rejection, 10/20/40 transport limits',
  );
  phase = 'human history';
  const r = byName['five.txt'],
    beforeReceipts = await count('intake_receipt');
  let response = await req(
    owner,
    'POST',
    base + '/intake/receipts/' + r.receiptId + '/classification-decisions',
    {
      expectedRevision: r.revision,
      action: 'change',
      type: 'supporting',
      note: 'Synthetic human classification',
    },
  );
  assert.equal(response.statusCode, 201, response.body);
  const newRevision = response.json().revision;
  response = await req(
    owner,
    'POST',
    base + '/intake/receipts/' + r.receiptId + '/classification-decisions',
    { expectedRevision: r.revision, action: 'change', type: 'offer', note: 'Stale synthetic' },
  );
  assert.equal(response.statusCode, 409);
  response = await req(owner, 'POST', base + '/intake/receipts/' + r.receiptId + '/reprocess', {
    expectedRevision: newRevision,
    reason: 'Synthetic native reclassification',
  });
  assert.equal(response.statusCode, 201, response.body);
  const effective = (await req(owner, 'GET', base + '/intake/documents'))
    .json()
    .find((x) => x.receiptId === r.receiptId);
  assert.equal(effective.type, 'supporting');
  assert.equal(effective.initialType, 'unknown');
  assert.equal(effective.proposedType, 'unknown');
  const history = (await req(owner, 'GET', base + '/intake/receipts/' + r.receiptId)).json();
  assert.equal(history.revisions.length, 3);
  assert.equal(history.revisions[1].source, 'human');
  assert.equal(history.revisions[1].actorId, actor);
  assert.ok(history.revisions[1].createdAt);
  assert.equal(await count('intake_receipt'), beforeReceipts);
  assert.equal(
    sha((await req(owner, 'GET', base + '/intake/originals/' + r.originalId + '/download')).rawPayload),
    sha(files[4].content),
  );
  ok(
    'human classification, stale 409, immutable initial result/evidence, reprocess preserves approved override and receipt/SHA',
  );
  phase = 'roles and integrity';
  const held = await make('SYNTHETIC protected intake control');
  lifecycle.protectedTenders.add(held);
  assert.equal(
    (
      await upload(
        [txt('held.txt', 'Synthetic held input')],
        randomUUID(),
        owner,
        '/api/tenders/' + held + '/intake/batches',
      )
    ).statusCode,
    409,
  );
  assert.equal((await life.preview(actor, held)).allowed.archive, false);
  assert.equal((await upload([txt('denied.txt', 'Synthetic')], randomUUID(), readOnly)).statusCode, 403);
  assert.equal((await upload([txt('denied.txt', 'Synthetic')], randomUUID(), other)).statusCode, 404);
  assert.equal((await req(readOnly, 'GET', base + '/intake/documents')).statusCode, 200);
  assert.equal((await req(other, 'GET', base + '/intake/documents')).statusCode, 404);
  assert.equal(
    (
      await req(
        owner,
        'GET',
        '/api/tenders/' + otherTender + '/intake/originals/' + r.originalId + '/download',
      )
    ).statusCode,
    404,
  );
  assert.equal(
    (await req(owner, 'GET', '/api/tenders/' + otherTender + '/intake/receipts/' + r.receiptId)).statusCode,
    404,
  );
  assert.equal((await owner.inject({ method: 'GET', url: base + '/intake/documents' })).statusCode, 401);
  assert.equal(
    (
      await req(readOnly, 'POST', base + '/intake/receipts/' + r.receiptId + '/classification-decisions', {
        expectedRevision: effective.revision,
        action: 'change',
        type: 'offer',
        note: 'denied',
      })
    ).statusCode,
    403,
  );
  await assert.rejects(
    pool.query('UPDATE tender_app.intake_document SET original_name=$2 WHERE id=$1', [
      r.originalId,
      'forbidden',
    ]),
  );
  await assert.rejects(
    pool.query('UPDATE tender_app.intake_classification_revision SET type=$2 WHERE receipt_id=$1', [
      r.receiptId,
      'offer',
    ]),
  );
  await assert.rejects(
    pool.query(
      'UPDATE tender_app.intake_classification_head SET state_revision=state_revision+1,current_revision_id=(SELECT id FROM tender_app.intake_classification_revision WHERE receipt_id=$1 LIMIT 1) WHERE receipt_id=$2',
      [byName['two.txt'].receiptId, r.receiptId],
    ),
    (e) => e.code === '23503',
  );
  await assert.rejects(
    pool.query('DELETE FROM tender_app.intake_classification_head WHERE receipt_id=$1', [r.receiptId]),
  );
  await assert.rejects(
    pool.query(
      "INSERT INTO tender_app.intake_receipt(id,tender_id,batch_id,original_id,top_level_index,part_path,channel,original_name,declared_mime,received_by) VALUES($1,$2,$3,$4,0,'0','manual','foreign.txt','text/plain',$5)",
      [randomUUID(), otherTender, r.batchId, r.originalId, actor],
    ),
  );
  ok(
    'actual API 401/403/404, cross-tender original/history/FKs, same-tender wrong revision FK, immutable SQL guards',
  );
  phase = 'busy lifecycle';
  const activeId = randomUUID();
  // D requires an immutable event in the SAME transaction as each run revision.
  // Only the historical busy-test setup changes; lifecycle assertions and raw row values stay intact.
  const persistBusyFixture = async (sql, args) => {
    assert.equal(args[0], activeId);
    await verifyIdentity(pool, run.identity);
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT id FROM tender_app.tender WHERE id=$1 FOR UPDATE', [tender]);
      await c.query(sql, args);
      const row = (await c.query('SELECT * FROM tender_app.intake_processing_run WHERE id=$1', [activeId]))
        .rows[0];
      await repo.queue.runEvent(c, row, 'synthetic_busy_fixture', actor);
      await c.query('COMMIT');
    } catch (error) {
      await c.query('ROLLBACK');
      throw error;
    } finally {
      c.release();
    }
  };
  await persistBusyFixture(
    "INSERT INTO tender_app.intake_processing_run(id,tender_id,receipt_id,original_id,source_sha,generation,request_key,fingerprint,status,policy_version,versions,attempt_count,state_revision,created_by) VALUES($1,$2,$3,$4,$5,99,$6,$7,'queued','synthetic-test','{}',0,1,$8)",
    [activeId, tender, r.receiptId, r.originalId, r.blobSha256, randomUUID(), '0'.repeat(64), actor],
  );
  let preview = await life.preview(actor, tender);
  assert.equal(preview.busy, true);
  assert.equal(preview.allowed.archive, false);
  await persistBusyFixture(
    "UPDATE tender_app.intake_processing_run SET status='failed',completed_at=now(),state_revision=2,error_code='synthetic_control' WHERE id=$1",
    [activeId],
  );
  preview = await life.preview(actor, tender);
  assert.equal(preview.busy, false);
  const archived = await req(owner, 'POST', base + '/lifecycle', {
    action: 'archive',
    confirmationId: tender,
    confirmationTitle: preview.title,
    previewHash: preview.previewHash,
    reason: 'Synthetic intake archive test',
  });
  assert.equal(archived.statusCode, 201, archived.body);
  assert.equal((await upload([txt('archived.txt', 'Synthetic')])).statusCode, 409);
  assert.equal(
    (
      await req(owner, 'POST', base + '/intake/receipts/' + r.receiptId + '/classification-decisions', {
        expectedRevision: effective.revision,
        action: 'change',
        type: 'offer',
        note: 'Archived denied',
      })
    ).statusCode,
    409,
  );
  await assert.rejects(
    pool.query(
      'INSERT INTO tender_app.intake_classification_head(receipt_id,tender_id,current_revision_id,state_revision) VALUES($1,$2,$3,1)',
      [randomUUID(), tender, history.revisions[0].id],
    ),
  );
  assert.equal((await req(owner, 'GET', base + '/intake/documents')).statusCode, 200);
  ok(
    'intake active statuses counted as busy, synchronous ingestion leaves no background job, archived API and direct SQL writes rejected, archived read works',
  );
  phase = 'restart and legacy';
  const child = await promisify(execFile)(
    process.execPath,
    [resolve('scripts/task011b/restart-reader.mjs'), JSON.stringify(run.identity), tender, actor],
    { cwd: process.cwd(), windowsHide: true, timeout: 30000 },
  );
  assert.deepEqual(
    JSON.parse(child.stdout.trim()),
    (await req(owner, 'GET', base + '/intake/documents')).json(),
  );
  const fresh = await start();
  assert.deepEqual(
    (await req(fresh, 'GET', base + '/intake/documents')).json(),
    (await req(owner, 'GET', base + '/intake/documents')).json(),
  );
  const legacy = await make('SYNTHETIC old routes regression'),
    legacyBase = '/api/tenders/' + legacy;
  const old = await upload(
    [txt('old.txt', 'Synthetic legacy offer')],
    randomUUID(),
    owner,
    legacyBase + '/offers/batches',
  );
  assert.equal(old.statusCode, 201, old.body);
  const oldRows = (await req(owner, 'GET', legacyBase + '/offers')).json();
  assert.equal(oldRows.length, 1);
  const oldFingerprint = JSON.stringify(
    (
      await pool.query('SELECT to_jsonb(d) value FROM tender_app.document d WHERE tender_id=$1 ORDER BY id', [
        legacy,
      ])
    ).rows,
  );
  assert.equal(
    (
      await upload(
        [txt('new.txt', 'Приложение №7 SYNTHETIC')],
        randomUUID(),
        owner,
        legacyBase + '/intake/batches',
      )
    ).statusCode,
    201,
  );
  assert.equal(
    JSON.stringify(
      (
        await pool.query(
          'SELECT to_jsonb(d) value FROM tender_app.document d WHERE tender_id=$1 ORDER BY id',
          [legacy],
        )
      ).rows,
    ),
    oldFingerprint,
  );
  const boundary = 'old-tz-' + randomUUID(),
    body = Buffer.from(
      '--' +
        boundary +
        '\r\nContent-Disposition: form-data; name="file"; filename="old-tz.txt"\r\nContent-Type: text/plain\r\n\r\nSynthetic technical text\r\n--' +
        boundary +
        '--\r\n',
    );
  const tz = await owner.inject({
    method: 'POST',
    url: legacyBase + '/tz',
    headers: {
      ...auth,
      'idempotency-key': randomUUID(),
      'content-type': 'multipart/form-data; boundary=' + boundary,
    },
    payload: body,
  });
  assert.equal(tz.statusCode, 201, tz.body);
  ok(
    'fresh application reads persistent results/history, original offer/TZ routes work, existing document fingerprint unchanged by intake',
  );
  assert.ok(seenConnections.every((c) => c.database === 'postgres' || c.database === run.database));
  await json(await checked(resolve(run.runRoot, 'task011b-api-results.json')), {
    status: 'PASS',
    results,
    identity: run.identity,
    connections: seenConnections,
    mainConnections: 0,
    modelCalls: 0,
  });
  passed = true;
  console.log(
    JSON.stringify({ status: 'PASS', groups: results.length, runRoot: run.runRoot, database: run.database }),
  );
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
