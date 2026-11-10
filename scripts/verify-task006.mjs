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
        `synthetic:006:${user}`,
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
    const upload = async (id) => {
      const boundary = 'fixture-' + randomUUID();
      const r = await owner.inject({
        method: 'POST',
        url: `/api/tenders/${id}/offers/batches`,
        headers: {
          ...headers,
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
    const created = await req(owner, 'POST', '/api/tenders', {
      title: 'Synthetic TASK006 shared original comparison',
    });
    assert.equal(created.statusCode, 201);
    const id = created.json().id,
      base = `/api/tenders/${id}`;
    await pool.query(
      "INSERT INTO tender_app.tender_member(tender_id,user_id,role) VALUES($1,$2,'reviewer')",
      [id, reviewer],
    );
    assert.equal(
      (await req(readOnly, 'POST', base + '/verification/lot', { expectedRevision: 1 })).statusCode,
      403,
    );
    const lotResult = await req(owner, 'POST', base + '/verification/lot', { expectedRevision: 1 });
    assert.equal(lotResult.statusCode, 201);
    const lotId = lotResult.json().id;
    assert.equal(
      (await req(owner, 'POST', base + '/verification/lot', { expectedRevision: 1 })).statusCode,
      409,
    );
    assert.equal((await req(owner, 'GET', base + '/scope')).json().items.length, 0);
    const documentId = await upload(id);
    assert.equal(await upload(id), documentId);
    const supplierA = await createSupplier(id, documentId, 'Synthetic supplier A'),
      supplierB = await createSupplier(id, documentId, 'Synthetic supplier B');
    let context = (await req(owner, 'GET', base + '/verification')).json();
    assert.equal(context.offers.length, 0);
    const receipts = context.documents[0].receipts;
    assert.equal(receipts.length, 2);
    const fields = {
      amount: '100000',
      currency: 'RUB',
      vatMode: 'included',
      paymentTerms: 'После поставки',
      deliveryTerms: null,
      compliance: 'matches',
    };
    let a = {
      supplierId: supplierA,
      lotId,
      documentId,
      receiptId: receipts[0].id,
      expectedVersion: 0,
      contextConfirmed: true,
      intent: 'draft',
      fields: { ...fields },
      original: { ...fields },
      sourceType: 'document',
      sourceNote: 'Synthetic original transcription',
      items: [],
      costs: [],
      costsEnabled: false,
      newQuestions: [],
      resolveQuestionIds: [],
    };
    const save = async (body, expected = 201, app = owner, target = base) => {
      const r = await req(app, 'POST', target + '/verification', body);
      assert.equal(r.statusCode, expected, `phase=${phase} status=${r.statusCode}`);
      return r.json();
    };
    const refresh = async () => {
      context = (await req(owner, 'GET', base + '/verification')).json();
      return context;
    };
    const current = (supplier) =>
      context.offers
        .find((o) => o.supplierId === supplier)
        ?.versions.filter((v) => v.metadata)
        .at(-1);
    const model = async (query = '') => (await req(owner, 'GET', base + '/comparison' + query)).json();
    const value = (m, key, supplier) =>
      m.rows.find((r) => r.key === key).values[m.columns.findIndex((c) => c.supplierId === supplier)];
    phase = 'missing delivery then phone confirmation';
    let result = await save(a);
    assert.equal(result.status, 'needs_review');
    a.expectedVersion = result.version;
    delete a.original;
    a.fields.deliveryTerms = '7 дней';
    a.intent = 'confirm';
    a.sourceType = 'phone';
    a.sourceNote = 'Synthetic phone call; "7 days" confirmed';
    result = await save(a);
    assert.equal(result.status, 'confirmed');
    a.expectedVersion = result.version;
    await refresh();
    assert.equal(current(supplierA).metadata.sources.deliveryTerms.type, 'phone');
    assert.equal(current(supplierA).metadata.sources.amount.type, 'document');
    assert.equal(current(supplierA).metadata.sources.items.type, 'document');
    assert.equal(current(supplierA).metadata.sources.costs.type, 'document');
    assert.equal(current(supplierA).metadata.original.deliveryTerms, null);
    phase = 'same SHA isolated by supplier and receipt';
    let b = {
      ...a,
      supplierId: supplierB,
      receiptId: receipts[1].id,
      expectedVersion: 0,
      intent: 'draft',
      fields: {
        amount: null,
        currency: null,
        vatMode: 'unknown',
        paymentTerms: null,
        deliveryTerms: null,
        compliance: 'unknown',
      },
      original: {
        amount: null,
        currency: null,
        vatMode: 'unknown',
        paymentTerms: null,
        deliveryTerms: null,
        compliance: 'unknown',
      },
      sourceType: 'document',
      sourceNote: 'Synthetic supplier B independent review',
    };
    result = await save(b);
    b.expectedVersion = result.version;
    delete b.original;
    await refresh();
    assert.equal(current(supplierB).metadata.fields.amount, null);
    assert.equal(current(supplierB).metadata.fields.deliveryTerms, null);
    assert.equal(current(supplierA).metadata.fields.amount, '100000');
    assert.notEqual(current(supplierA).metadata.offerId, current(supplierB).metadata.offerId);
    b.fields = { ...fields, amount: '110000', deliveryTerms: '10 дней' };
    b.intent = 'confirm';
    b.sourceType = 'email';
    result = await save(b);
    b.expectedVersion = result.version;
    assert.equal(result.status, 'confirmed');
    phase = 'other issues survive delivery changes';
    a.newQuestions = ['Synthetic warranty question'];
    a.sourceType = 'other';
    result = await save(a);
    a.expectedVersion = result.version;
    a.newQuestions = [];
    assert.equal(result.status, 'needs_review');
    await refresh();
    const questionId = current(supplierA).metadata.questions[0].id;
    a.fields.deliveryTerms = '5 дней';
    a.sourceType = 'phone';
    result = await save(a);
    a.expectedVersion = result.version;
    assert.ok(result.warnings.some((w) => w.code === 'manual:' + questionId));
    assert.equal(result.status, 'needs_review');
    await save({ ...a, resolveQuestionIds: [randomUUID()] }, 400);
    a.resolveQuestionIds = [questionId];
    result = await save(a);
    assert.equal(result.status, 'confirmed');
    a.expectedVersion = result.version;
    a.resolveQuestionIds = [];
    phase = 'immutable original and Decimal price history';
    a.fields.amount = '95000';
    result = await save(a);
    a.expectedVersion = result.version;
    const step95 = result.version;
    a.fields.amount = '90000';
    result = await save(a);
    a.expectedVersion = result.version;
    const step90 = result.version;
    let m = await model();
    assert.equal(value(m, 'original', supplierA), '100000.000000 RUB');
    assert.equal(value(m, 'current', supplierA), '90000 RUB');
    assert.equal(value(m, 'discount:' + step95, supplierA), '5');
    assert.equal(value(m, 'discount:' + step90, supplierA), '5.2632');
    assert.equal(value(m, 'overall_discount', supplierA), '10');
    assert.equal(value(m, 'rank', supplierA), '1');
    assert.equal(value(m, 'accreditation', supplierA), 'Нет проверки');
    await save({ ...a, original: { ...fields, amount: '1' } }, 409);
    phase = 'expenses included add unknown';
    a.costsEnabled = true;
    a.costs = [{ name: 'Delivery', amount: '10000', currency: 'RUB', treatment: 'included' }];
    result = await save(a);
    a.expectedVersion = result.version;
    assert.equal(value(await model(), 'comparable', supplierA), '90000 RUB');
    a.costs[0].treatment = 'add';
    result = await save(a);
    a.expectedVersion = result.version;
    assert.equal(value(await model(), 'comparable', supplierA), '100000 RUB');
    a.costs = [{ name: 'Delivery unknown', amount: null, currency: null, treatment: 'unknown' }];
    result = await save(a);
    a.expectedVersion = result.version;
    m = await model();
    assert.equal(value(m, 'comparable', supplierA), 'Не определено');
    assert.equal(value(m, 'rank', supplierA), 'Не ранжируется');
    a.costs = [];
    a.costsEnabled = false;
    result = await save(a);
    a.expectedVersion = result.version;
    phase = 'currency VAT and supplier accreditation isolation';
    b.fields.currency = 'USD';
    result = await save(b);
    b.expectedVersion = result.version;
    m = await model();
    assert.ok(m.warnings.length);
    assert.equal(value(m, 'rank', supplierA), 'Не ранжируется');
    b.fields.currency = 'RUB';
    b.fields.vatMode = 'excluded';
    result = await save(b);
    b.expectedVersion = result.version;
    assert.equal(value(await model(), 'rank', supplierA), 'Не ранжируется');
    b.fields.vatMode = 'included';
    result = await save(b);
    b.expectedVersion = result.version;
    await pool.query(
      "INSERT INTO tender_app.accreditation_report(id,tender_id,supplier_id,document_id,assessed_at,status,source,created_by) VALUES($1,$2,$3,$4,now(),'passed','Synthetic report fixture',$5)",
      [randomUUID(), id, supplierA, documentId, actor],
    );
    m = await model();
    assert.equal(value(m, 'accreditation', supplierA), 'Аккредитован');
    assert.equal(value(m, 'accreditation', supplierB), 'Нет проверки');
    phase = 'server access validation and conflicts';
    await save(a, 403, readOnly);
    await save(a, 404, other);
    await save({ ...a, contextConfirmed: false }, 400);
    await save({ ...a, fields: { ...a.fields, amount: '-1' } }, 400);
    await save({ ...a, supplierId: randomUUID() }, 400);
    await save({ ...a, receiptId: randomUUID() }, 400);
    await save({ ...a, expectedVersion: 0 }, 409);
    assert.equal((await req(other, 'GET', base + '/verification')).statusCode, 404);
    assert.equal((await req(other, 'GET', base + '/comparison')).statusCode, 404);
    assert.equal((await req(other, 'GET', base + '/comparison.csv')).statusCode, 404);
    assert.equal((await req(readOnly, 'GET', base + '/comparison')).statusCode, 200);
    assert.equal((await req(owner, 'GET', base + '/comparison?mode=bad')).statusCode, 400);
    const concurrent = await Promise.all([
      req(owner, 'POST', base + '/verification', a),
      req(owner, 'POST', base + '/verification', a),
    ]);
    assert.deepEqual(concurrent.map((r) => r.statusCode).sort(), [201, 409]);
    a.expectedVersion = concurrent.find((r) => r.statusCode === 201).json().version;
    assert.equal(
      (
        await pool.query(
          'SELECT count(*)::int AS n FROM tender_app.offer_version WHERE offer_id=$1 AND is_initial',
          [result.offerId],
        )
      ).rows[0].n,
      1,
    );
    const original = await req(owner, 'GET', base + `/offers/${documentId}/original`);
    assert.deepEqual(original.rawPayload, file);
    assert.equal(
      (await pool.query('SELECT status FROM tender_app.document WHERE id=$1', [documentId])).rows[0].status,
      'uploaded',
    );
    phase = 'CSV exact model and attribution';
    m = await model();
    const exported = await req(owner, 'GET', base + '/comparison.csv');
    assert.equal(exported.statusCode, 200);
    assert.match(exported.headers['content-type'], /text\/csv/);
    function parseCsv(text) {
      const rows = [];
      let row = [],
        cell = '',
        quoted = false;
      for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c === '"') {
          if (quoted && text[i + 1] === '"') {
            cell += '"';
            i++;
          } else quoted = !quoted;
        } else if (c === ';' && !quoted) {
          row.push(cell);
          cell = '';
        } else if (c === '\r' && !quoted && text[i + 1] === '\n') {
          row.push(cell);
          rows.push(row);
          row = [];
          cell = '';
          i++;
        } else cell += c;
      }
      row.push(cell);
      rows.push(row);
      return rows;
    }
    const cells = parseCsv(exported.body.replace(/^\uFEFF/, ''));
    assert.deepEqual(cells[0], ['Показатель', ...m.columns.map((c) => c.name)]);
    assert.deepEqual(
      cells.slice(1),
      m.rows.map((r) => [r.label, ...r.values]),
    );
    assert.ok(exported.body.includes('Телефон'));
    phase = 'positions completeness and unit validation';
    const itemTender = await req(owner, 'POST', '/api/tenders', {
      title: 'Synthetic position comparison',
      creationMode: 'manual',
      items: [
        { name: 'Pump', quantity: '2', unit: 'шт' },
        { name: 'Cabinet', quantity: '1', unit: 'шт' },
        { name: 'Installation', quantity: '1', unit: 'услуга' },
      ],
    });
    assert.equal(itemTender.statusCode, 201);
    const itemId = itemTender.json().id,
      itemBase = `/api/tenders/${itemId}`,
      itemDoc = await upload(itemId),
      supplierC = await createSupplier(itemId, itemDoc, 'Synthetic supplier C');
    const itemContext = (await req(owner, 'GET', itemBase + '/verification')).json(),
      lot = itemContext.lots[0].id,
      required = itemContext.lotItems[lot];
    let c = {
      ...a,
      supplierId: supplierC,
      lotId: lot,
      documentId: itemDoc,
      receiptId: itemContext.documents[0].receipts[0].id,
      expectedVersion: 0,
      original: { ...fields, amount: '220.4' },
      fields: { ...fields, amount: null, deliveryTerms: '7 дней' },
      items: required.slice(0, 2).map((r, i) => ({
        lotItemId: r.id,
        quantity: r.quantity,
        unit: r.unit,
        unitPrice: i === 0 ? '100.1' : '20.2',
      })),
      costs: [],
      sourceType: 'document',
      sourceNote: 'Synthetic position evidence',
    };
    result = await save(c, 201, owner, itemBase);
    c.expectedVersion = result.version;
    delete c.original;
    let cm = (await req(owner, 'GET', itemBase + '/comparison')).json();
    assert.equal(value(cm, 'comparable', supplierC), 'Не определено');
    assert.equal(value(cm, 'rank', supplierC), 'Не ранжируется');
    c.items.push({
      lotItemId: required[2].id,
      quantity: required[2].quantity,
      unit: required[2].unit,
      unitPrice: '0',
    });
    result = await save(c, 201, owner, itemBase);
    c.expectedVersion = result.version;
    cm = (await req(owner, 'GET', itemBase + '/comparison')).json();
    assert.equal(value(cm, 'current', supplierC), '220.4 RUB');
    const originalItemPrice = value(cm, 'original', supplierC);
    cm = (await req(owner, 'GET', itemBase + `/comparison?mode=items&itemId=${required[0].id}`)).json();
    assert.equal(value(cm, 'current', supplierC), '200.2 RUB');
    assert.equal(value(cm, 'original', supplierC), originalItemPrice);
    c.items[0].unit = 'кг';
    result = await save(c, 201, owner, itemBase);
    c.expectedVersion = result.version;
    assert.equal(result.status, 'needs_review');
    assert.equal(
      value((await req(owner, 'GET', itemBase + '/comparison')).json(), 'rank', supplierC),
      'Не ранжируется',
    );
    phase = 'immutable versions';
    const initial = (
      await pool.query('SELECT id FROM tender_app.offer_version WHERE tender_id=$1 AND is_initial LIMIT 1', [
        id,
      ])
    ).rows[0].id;
    await assert.rejects(
      () => pool.query('UPDATE tender_app.offer_version SET amount=1 WHERE id=$1', [initial]),
      (e) => e.code === '55000',
    );
    console.log(
      'PASS TASK006: per-supplier/receipt isolation for shared SHA, phone provenance, retained questions, immutable original, Decimal history/expenses, currency/VAT/units/completeness, CSV parity, accreditation isolation, 403/404/409 and concurrency. Synthetic fixtures retained; no DDL.',
    );
  } catch (e) {
    console.error(`FAIL TASK006 phase=${phase} code=${e.code ?? e.name}`);
    throw e;
  } finally {
    for (const app of apps) await app.close();
    await pool.end();
  }
}
