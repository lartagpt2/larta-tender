import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import application from '../apps/api/dist/application.js';
import repositories from '../apps/api/dist/data/repository.js';
import scopes from '../apps/api/dist/data/scope-repository.js';
import offers from '../apps/api/dist/data/offer-repository.js';
import verifications from '../apps/api/dist/comparison/verification-repository.js';
import stages from '../apps/api/dist/stages/stage-repository.js';
if (!process.argv.includes('--run'))
  console.log(
    'Preview: no DB connection. --run uses only approved larta_test_task003 and retains synthetic fixtures.',
  );
else {
  const root = fileURLToPath(new URL('../', import.meta.url));
  config({ path: resolve(root, '.env'), quiet: true });
  if (process.env.PGDATABASE !== 'larta_test_task003')
    throw new Error('Approved synthetic test database required');
  const pool = new pg.Pool({ connectionTimeoutMillis: 5000, statement_timeout: 10000 }),
    apps = [];
  const actor = randomUUID(),
    reviewer = randomUUID(),
    outsider = randomUUID(),
    token = randomBytes(32).toString('hex'),
    headers = { authorization: `Bearer ${token}` };
  let phase = 'setup';
  try {
    assert.equal(
      (
        await pool.query(
          "SELECT sha256 FROM tender_app.schema_migrations WHERE name='002_domain_foundation.sql'",
        )
      ).rows[0]?.sha256,
      createHash('sha256')
        .update(await readFile(resolve(root, 'infra/migrations/002_domain_foundation.sql')))
        .digest('hex'),
    );
    for (const user of [actor, reviewer, outsider])
      await pool.query('INSERT INTO tender_app.app_user(id,external_subject,display_name) VALUES($1,$2,$3)', [
        user,
        `synthetic:007:${user}`,
        'Synthetic commercial reviewer',
      ]);
    const start = async (actorId) => {
      const app = await application.createApplication({
        logger: false,
        environment: 'test',
        data: {
          enabled: true,
          token,
          actorId,
          repository: new repositories.PgTenderRepository(pool),
          scopeRepository: new scopes.PgScopeRepository(pool),
          offerRepository: new offers.PgOfferRepository(pool),
          verificationRepository: new verifications.PgVerificationRepository(pool),
          stageRepository: new stages.PgStageRepository(pool),
        },
      });
      await app.init();
      await app.getHttpAdapter().getInstance().ready();
      apps.push(app);
      return app;
    };
    const owner = await start(actor),
      readOnly = await start(reviewer),
      other = await start(outsider);
    const req = (app, method, url, payload) => app.inject({ method, url, headers, payload });
    const file = await readFile(resolve(root, 'tests/fixtures/tz-seven-items.pdf'));
    const upload = async (id, stageId) => {
      const boundary = 'fixture-' + randomUUID();
      const r = await owner.inject({
        method: 'POST',
        url: `/api/tenders/${id}/offers/batches`,
        headers: {
          ...headers,
          ...(stageId ? { 'x-tender-stage-id': stageId } : {}),
          'content-type': `multipart/form-data; boundary=${boundary}`,
          'idempotency-key': randomUUID(),
        },
        payload: Buffer.concat([
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="synthetic.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
          ),
          file,
          Buffer.from(`\r\n--${boundary}--\r\n`),
        ]),
      });
      assert.equal(r.statusCode, 201);
      return r.json().outcomes[0].documents[0];
    };
    const createSupplier = async (id, doc, name) => {
      const docs = (await req(owner, 'GET', `/api/tenders/${id}/offers`)).json();
      const d = docs.find((d) => d.id === doc);
      const r = await req(owner, 'PATCH', `/api/tenders/${id}/offers/${doc}/association`, {
        revision: d.revision,
        newSupplier: { name },
        note: 'Synthetic explicit supplier association',
      });
      assert.equal(r.statusCode, 200);
      return r.json().supplierId;
    };
    phase = 'stages';
    const created = await req(owner, 'POST', '/api/tenders', { title: 'Synthetic TASK007 stage history' });
    assert.equal(created.statusCode, 201);
    const id = created.json().id,
      base = `/api/tenders/${id}`;
    await pool.query(
      "INSERT INTO tender_app.tender_member(tender_id,user_id,role) VALUES($1,$2,'reviewer')",
      [id, reviewer],
    );
    const lot = await req(owner, 'POST', base + '/verification/lot', { expectedRevision: 1 });
    assert.equal(lot.statusCode, 201);
    const lotId = lot.json().id;
    const doc = await upload(id);
    await upload(id);
    const supplierA = await createSupplier(id, doc, 'Synthetic TASK007 supplier A'),
      supplierB = await createSupplier(id, doc, 'Synthetic TASK007 supplier B');
    let verification = (await req(owner, 'GET', base + '/verification')).json();
    const fields = {
      amount: '100000',
      currency: 'RUB',
      vatMode: 'included',
      paymentTerms: 'After delivery',
      deliveryTerms: '7 days',
      compliance: 'matches',
    };
    const input = {
      supplierId: supplierA,
      lotId,
      documentId: doc,
      receiptId: verification.documents[0].receipts[0].id,
      expectedVersion: 0,
      contextConfirmed: true,
      intent: 'confirm',
      fields: { ...fields },
      original: { ...fields },
      sourceType: 'document',
      sourceNote: 'Synthetic own supplier quote',
      items: [],
      costs: [],
      costsEnabled: false,
      newQuestions: [],
      resolveQuestionIds: [],
    };
    async function verify(payload) {
      const r = await req(owner, 'POST', base + '/verification', payload);
      assert.equal(r.statusCode, 201);
      return r.json();
    }
    let a = await verify(input),
      b = await verify({
        ...input,
        supplierId: supplierB,
        receiptId: verification.documents[0].receipts[1].id,
      });
    const context = async () => (await req(owner, 'GET', base + '/stages')).json();
    const revision = async () => (await context()).scope.revision;
    async function stage(kind, label) {
      const r = await req(owner, 'POST', base + '/stages', {
        kind,
        label,
        comment: 'Synthetic stage rationale',
        expectedRevision: await revision(),
      });
      assert.equal(r.statusCode, 201);
      return r.json().id;
    }
    const first = await stage('negotiation', 'First negotiation');
    assert.equal(
      (
        await req(readOnly, 'POST', base + '/stages', {
          kind: 'round',
          label: 'Forbidden',
          comment: 'test',
          expectedRevision: await revision(),
        })
      ).statusCode,
      403,
    );
    assert.equal((await req(other, 'GET', base + '/stages')).statusCode, 404);
    assert.equal(
      (
        await req(owner, 'POST', base + '/stages', {
          kind: 'round',
          label: 'No rationale',
          comment: '',
          expectedRevision: await revision(),
        })
      ).statusCode,
      400,
    );
    async function response(stageId, offerId, status, versionId, expected = 201) {
      const r = await req(owner, 'POST', base + `/stages/${stageId}/responses`, {
        offerId,
        status,
        ...(versionId ? { versionId } : {}),
        note: 'Synthetic recorded response',
        expectedRevision: await revision(),
      });
      assert.equal(r.statusCode, expected);
      return r;
    }
    // Wrong supplier version and stage-less version cannot become a stage response.
    await response(first, b.offerId, 'received', a.versionId, 400);
    await response(first, a.offerId, 'received', a.versionId, 400);
    await upload(id, first);
    verification = (await req(owner, 'GET', base + '/verification')).json();
    let receipt = verification.documents[0].receipts.at(-1).id;
    a = await verify({
      ...input,
      expectedVersion: a.version,
      receiptId: receipt,
      fields: { ...fields, amount: '95000' },
    });
    let comparison = (await req(owner, 'GET', base + '/comparison')).json();
    const value = (key, col = 0) => comparison.rows.find((r) => r.key === key).values[col];
    assert.equal(value('current'), '100000 RUB'); // technical save alone does not change the commercial price.
    await response(first, a.offerId, 'received', a.versionId);
    await response(first, a.offerId, 'received', a.versionId, 409);
    assert.equal(
      (
        await req(readOnly, 'POST', base + `/stages/${first}/responses`, {
          offerId: b.offerId,
          status: 'no_reply',
          note: 'test',
          expectedRevision: await revision(),
        })
      ).statusCode,
      403,
    );
    await response(first, b.offerId, 'no_reply');
    const second = await stage('round', 'Second negotiation');
    await upload(id, second);
    verification = (await req(owner, 'GET', base + '/verification')).json();
    receipt = verification.documents[0].receipts.at(-1).id;
    a = await verify({
      ...input,
      expectedVersion: a.version,
      receiptId: receipt,
      fields: { ...fields, amount: '90000' },
    });
    await response(second, a.offerId, 'received', a.versionId);
    const third = await stage('clarification', 'No answer');
    await response(third, a.offerId, 'no_reply');
    comparison = (await req(owner, 'GET', base + '/comparison')).json();
    assert.equal(value('original'), '100000.000000 RUB');
    assert.equal(value('current'), '90000 RUB');
    assert.equal(value('current', 1), '100000 RUB');
    assert.equal(value('stage_discount:' + first), '5');
    assert.equal(value('stage_discount:' + second), '5.2632');
    assert.equal(value('stage_discount:' + third), '0');
    assert.equal(value('stage_overall:' + third), '10');
    assert.equal(value('overall_discount'), '10');
    assert.match(value('stage_response:' + third), /Нет ответа/);
    const fixedStageRows = comparison.rows.filter((r) => r.key.startsWith('stage'));
    a = await verify({
      ...input,
      expectedVersion: a.version,
      receiptId: receipt,
      intent: 'draft',
      fields: { ...fields, amount: '12345' },
    });
    comparison = (await req(owner, 'GET', base + '/comparison')).json();
    assert.equal(value('current'), '90000 RUB');
    assert.deepEqual(
      comparison.rows.filter((r) => r.key.startsWith('stage')),
      fixedStageRows,
    );
    // Concurrent stage creators get one success and one stale-revision conflict.
    const rev = await revision();
    const races = await Promise.all(
      ['A', 'B'].map((label) =>
        req(owner, 'POST', base + '/stages', {
          kind: 'clarification',
          label: 'Concurrent ' + label,
          comment: 'test',
          expectedRevision: rev,
        }),
      ),
    );
    assert.deepEqual(races.map((r) => r.statusCode).sort(), [201, 409]);
    const supplierC = await createSupplier(id, doc, 'Synthetic late supplier C');
    const late = await verify({
      ...input,
      supplierId: supplierC,
      expectedVersion: 0,
      fields: { ...fields, amount: '80000' },
    });
    comparison = (await req(owner, 'GET', base + '/comparison')).json();
    assert.equal(value('current', 2), 'Не определено');
    const baselineInput = {
      offerId: late.offerId,
      versionId: late.versionId,
      note: 'Synthetic late entrant baseline explicitly fixed',
      expectedRevision: await revision(),
    };
    assert.equal((await req(owner, 'POST', base + '/stages/baseline', baselineInput)).statusCode, 201);
    assert.equal(
      (
        await req(owner, 'POST', base + '/stages/baseline', {
          ...baselineInput,
          expectedRevision: await revision(),
        })
      ).statusCode,
      409,
    );
    comparison = (await req(owner, 'GET', base + '/comparison')).json();
    assert.equal(value('current', 2), '80000 RUB');
    assert.equal(value('stage:' + first, 2), 'Не определено');
    phase = 'contacts and drafts';
    let c = await req(owner, 'POST', base + '/contacts/confirm', {
      supplierId: supplierA,
      email: 'supplier-a@example.invalid',
      documentId: doc,
      note: 'Synthetic source explicitly verified',
      expectedRevision: await revision(),
    });
    assert.equal(c.statusCode, 201);
    const contact = c.json().id;
    const draft = {
      supplierId: supplierA,
      contactIds: [contact],
      subject: 'Editable synthetic request',
      body: 'Synthetic body, no sending',
    };
    let d = await req(owner, 'POST', base + `/stages/${first}/drafts`, {
      ...draft,
      expectedRevision: await revision(),
    });
    assert.equal(d.statusCode, 201);
    const draftId = d.json().id;
    assert.deepEqual(d.json().recipients, ['supplier-a@example.invalid']);
    const edited = await req(owner, 'POST', base + `/stages/${first}/drafts`, {
      ...draft,
      previousId: draftId,
      body: 'Edited body',
      expectedRevision: await revision(),
    });
    assert.equal(edited.statusCode, 201);
    assert.equal(
      (
        await req(owner, 'POST', base + `/stages/${first}/drafts`, {
          ...draft,
          previousId: draftId,
          expectedRevision: await revision(),
        })
      ).statusCode,
      409,
    );
    assert.equal(
      (
        await req(owner, 'POST', base + `/stages/${first}/drafts`, {
          ...draft,
          supplierId: supplierB,
          expectedRevision: await revision(),
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await req(owner, 'POST', base + `/stages/${first}/drafts`, {
          ...draft,
          to_addresses: ['invented@example.invalid'],
          expectedRevision: await revision(),
        })
      ).statusCode,
      400,
    );
    d = await req(owner, 'POST', base + `/stages/${first}/drafts`, {
      ...draft,
      supplierId: supplierB,
      contactIds: [],
      expectedRevision: await revision(),
    });
    assert.equal(d.statusCode, 201);
    assert.deepEqual(d.json().recipients, []);
    const history = (await context()).drafts;
    assert.equal(history.length, 3);
    assert.equal(history.find((d) => d.id === draftId).body, draft.body);
    assert.equal((await req(owner, 'POST', base + `/stages/${first}/send`, {})).statusCode, 404);
    phase = 'accreditation upload and supplier history';
    const reportBytes = Buffer.from('Synthetic accreditation report, no customer information.');
    async function reportUpload(key, bytes = reportBytes) {
      const boundary = 'report-' + randomUUID();
      return owner.inject({
        method: 'POST',
        url: base + '/accreditations/files',
        headers: {
          ...headers,
          'idempotency-key': key,
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        payload: Buffer.concat([
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="synthetic-report.txt"\r\nContent-Type: text/plain\r\n\r\n`,
          ),
          bytes,
          Buffer.from(`\r\n--${boundary}--\r\n`),
        ]),
      });
    }
    const key = randomUUID();
    let up = await reportUpload(key);
    assert.equal(up.statusCode, 201);
    const reportDoc = up.json().id;
    assert.equal((await reportUpload(key)).json().id, reportDoc);
    assert.equal((await reportUpload(key, Buffer.from('Changed payload'))).statusCode, 409);
    assert.ok(!(await req(owner, 'GET', base + '/offers')).json().some((d) => d.id === reportDoc));
    assert.equal(
      (await req(owner, 'GET', base + `/offers/${reportDoc}/original`)).body,
      reportBytes.toString(),
    );
    const reportRevision = (
      await pool.query('SELECT revision FROM tender_app.document WHERE id=$1', [reportDoc])
    ).rows[0].revision;
    assert.equal(
      (
        await req(owner, 'PATCH', base + `/offers/${reportDoc}/association`, {
          revision: reportRevision,
          supplierId: supplierB,
          note: 'Synthetic association must not change resource role',
        })
      ).statusCode,
      200,
    );
    assert.ok(!(await req(owner, 'GET', base + '/offers')).json().some((d) => d.id === reportDoc));
    const report = {
      supplierId: supplierA,
      documentId: reportDoc,
      assessedAt: '2026-01-01T00:00:00Z',
      status: 'pending',
      source: 'Synthetic accreditation resource',
      note: 'Initial report',
    };
    assert.equal(
      (await req(owner, 'POST', base + '/accreditations', { ...report, expectedRevision: await revision() }))
        .statusCode,
      201,
    );
    assert.equal(
      (
        await req(owner, 'POST', base + '/accreditations', {
          ...report,
          status: 'passed',
          assessedAt: '2026-02-01T00:00:00Z',
          note: 'Updated independent assessment',
          expectedRevision: await revision(),
        })
      ).statusCode,
      201,
    );
    assert.equal((await context()).reports.length, 2);
    comparison = (await req(owner, 'GET', base + '/comparison')).json();
    assert.equal(value('accreditation'), 'Аккредитован');
    assert.equal(value('accreditation', 1), 'Нет проверки');
    assert.equal(
      (
        await req(readOnly, 'POST', base + '/accreditations', {
          ...report,
          expectedRevision: await revision(),
        })
      ).statusCode,
      403,
    );
    assert.equal((await req(other, 'GET', base + `/offers/${reportDoc}/original`)).statusCode, 404);
    assert.equal(
      (
        await req(owner, 'POST', base + '/verification', {
          ...input,
          supplierId: supplierB,
          expectedVersion: b.version,
          documentId: reportDoc,
          receiptId: reportDoc,
        })
      ).statusCode,
      404,
    );
    // Identical report bytes may be explicitly assigned to B, but never automatically inherit A's status.
    assert.equal(
      (
        await req(owner, 'POST', base + '/accreditations', {
          ...report,
          supplierId: supplierB,
          status: 'failed',
          expectedRevision: await revision(),
        })
      ).statusCode,
      201,
    );
    comparison = (await req(owner, 'GET', base + '/comparison')).json();
    assert.equal(value('accreditation'), 'Аккредитован');
    assert.equal(value('accreditation', 1), 'Не пройдена');
    const intakeBoundary = 'intake-' + randomUUID();
    const intake = await owner.inject({
      method: 'POST',
      url: base + '/offers/batches',
      headers: {
        ...headers,
        'idempotency-key': randomUUID(),
        'content-type': `multipart/form-data; boundary=${intakeBoundary}`,
      },
      payload: Buffer.concat([
        Buffer.from(
          `--${intakeBoundary}\r\nContent-Disposition: form-data; name="files"; filename="synthetic-report.txt"\r\nContent-Type: text/plain\r\n\r\n`,
        ),
        reportBytes,
        Buffer.from(`\r\n--${intakeBoundary}--\r\n`),
      ]),
    });
    assert.equal(intake.statusCode, 201);
    const nowQuote = (await req(owner, 'GET', base + '/offers')).json().find((d) => d.id === reportDoc);
    assert.equal(nowQuote.receipts.length, 1);
    assert.equal(nowQuote.receipts[0].legacy, false);
    const csv = (await req(owner, 'GET', base + '/comparison.csv')).body;
    for (const row of comparison.rows.filter((r) => r.key.startsWith('stage'))) {
      assert.ok(csv.includes(row.label));
      for (const cell of row.values) assert.ok(csv.includes(cell));
    }
    const db = (
      await pool.query(
        'SELECT version,amount::text FROM tender_app.offer_version WHERE offer_id=$1 AND is_initial',
        [a.offerId],
      )
    ).rows;
    assert.equal(db.length, 1);
    assert.equal(db[0].amount, '100000.000000');
    const audits = (await context()).audit;
    assert.ok(audits.some((e) => e.action === 'stage.response.fixed'));
    assert.ok(audits.some((e) => e.action === 'draft.saved'));
    assert.ok(audits.some((e) => e.action === 'accreditation.recorded'));
    console.log(
      'PASS TASK007: stage snapshots, 100000/95000/90000/no reply, technical-save isolation, same-file supplier isolation, concurrent revision, sourced drafts/history/no send, accreditation uploads/history/access, immutable initial and CSV.',
    );
  } catch (error) {
    console.error('TASK007 failed during ' + phase + ' (' + (error.code ?? error.name) + ')');
    throw error;
  } finally {
    for (const app of apps) await app.close();
    await pool.end();
  }
}
