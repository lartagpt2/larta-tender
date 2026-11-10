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
if (!process.argv.includes('--run'))
  console.log('Preview only. --run uses approved larta_test_task003; synthetic fixtures remain.');
else {
  const root = fileURLToPath(new URL('../', import.meta.url));
  config({ path: resolve(root, '.env'), quiet: true });
  if (process.env.PGDATABASE !== 'larta_test_task003') throw new Error('Approved test database required');
  const pool = new pg.Pool({ connectionTimeoutMillis: 5000, statement_timeout: 10000 }),
    apps = [];
  const actor = randomUUID(),
    reviewer = randomUUID(),
    outsider = randomUUID(),
    token = randomBytes(32).toString('hex');
  const headers = { authorization: `Bearer ${token}` };
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
        `synthetic:005b:${user}`,
        'Synthetic offer tester',
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
    const created = await req(owner, 'POST', '/api/tenders', { title: 'Synthetic TASK005B upload' });
    assert.equal(created.statusCode, 201);
    const id = created.json().id,
      base = `/api/tenders/${id}`;
    await pool.query(
      "INSERT INTO tender_app.tender_member(tender_id,user_id,role) VALUES($1,$2,'reviewer')",
      [id, reviewer],
    );
    const upload = async (files, key = randomUUID(), app = owner, stageId, target = base) => {
      const boundary = 'fixture-' + randomUUID();
      return app.inject({
        method: 'POST',
        url: target + '/offers/batches',
        headers: {
          ...headers,
          'content-type': `multipart/form-data; boundary=${boundary}`,
          'idempotency-key': key,
          ...(stageId ? { 'x-tender-stage-id': stageId } : {}),
        },
        payload: Buffer.concat([
          ...files.flatMap((f) => [
            Buffer.from(
              `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${f.name}"\r\nContent-Type: ${f.mime}\r\n\r\n`,
            ),
            f.content,
            Buffer.from('\r\n'),
          ]),
          Buffer.from(`--${boundary}--\r\n`),
        ]),
      });
    };
    const files = Array.from({ length: 7 }, (_, i) => ({
      name: `synthetic-${i}.pdf`,
      mime: 'application/pdf',
      content: Buffer.from(`%PDF-1.7 synthetic offer ${i}`),
    }));
    phase = 'two batches and replay';
    const key = randomUUID(),
      first = await upload(files.slice(0, 3), key);
    assert.equal(first.statusCode, 201);
    assert.equal((await upload(files.slice(3))).statusCode, 201);
    let list = (await req(owner, 'GET', base + '/offers')).json();
    assert.equal(list.length, 7);
    assert.ok(list.every((d) => d.email === null && d.supplierId === null && d.status === 'uploaded'));
    const replay = await upload(files.slice(0, 3), key);
    assert.deepEqual(replay.json(), first.json());
    assert.equal((await upload([files[3]], key)).statusCode, 409);
    assert.equal((await upload(files)).statusCode, 201);
    assert.equal((await req(owner, 'GET', base + '/offers')).json().length, 7);
    phase = '005B empty tender creates supplier atomically';
    assert.equal((await req(owner, 'GET', base + '/suppliers')).json().length, 0);
    const firstDoc = list[0],
      firstUrl = base + `/offers/${firstDoc.id}/association`;
    const invalids = [
      { name: '   ' },
      { name: 'Invalid', email: 'not-an-email' },
      { name: 'Invalid', registrationNumber: 'x'.repeat(65) },
      { name: 'Invalid', unexpected: 'blocked' },
      [],
    ];
    for (const newSupplier of invalids)
      assert.equal(
        (
          await req(owner, 'PATCH', firstUrl, {
            revision: firstDoc.revision,
            newSupplier,
            note: 'Synthetic invalid input',
          })
        ).statusCode,
        400,
      );
    assert.equal(
      (await req(owner, 'PATCH', firstUrl, { revision: firstDoc.revision, note: 'Missing target' }))
        .statusCode,
      400,
    );
    const createBody = {
      revision: firstDoc.revision,
      newSupplier: { name: 'Synthetic new supplier 005B' },
      note: 'Synthetic explicit supplier creation',
    };
    assert.equal((await req(readOnly, 'PATCH', firstUrl, createBody)).statusCode, 403);
    assert.equal((await req(other, 'PATCH', firstUrl, createBody)).statusCode, 404);
    const association = await req(owner, 'PATCH', firstUrl, createBody);
    assert.equal(association.statusCode, 200);
    const newId = association.json().supplierId;
    assert.ok(newId);
    const supplierRows = (await req(owner, 'GET', base + '/suppliers')).json();
    assert.equal(supplierRows.length, 1);
    assert.equal(supplierRows[0].email, null);
    assert.equal(supplierRows[0].registrationNumber, null);
    assert.equal((await req(owner, 'PATCH', firstUrl, createBody)).statusCode, 409);
    assert.equal((await req(owner, 'GET', base + '/suppliers')).json().length, 1);
    const reloaded = (await req(owner, 'GET', base + '/offers')).json().find((d) => d.id === firstDoc.id);
    assert.equal(reloaded.supplierId, newId);
    assert.equal(reloaded.email, null);
    assert.equal(reloaded.associationStatus, 'confirmed');
    assert.ok(
      (
        await pool.query(
          "SELECT 1 FROM tender_app.field_decision WHERE document_id=$1 AND field_key='supplier.created.v1' AND decided_by=$2 AND source_note=$3",
          [firstDoc.id, actor, createBody.note],
        )
      ).rowCount,
    );
    const secondDoc = list[1],
      thirdDoc = list[2];
    const second = await req(owner, 'PATCH', base + `/offers/${secondDoc.id}/association`, {
      revision: secondDoc.revision,
      newSupplier: { name: 'Synthetic new supplier 005B' },
      note: 'Create separate same-name supplier',
    });
    assert.equal(second.statusCode, 200);
    assert.notEqual(second.json().supplierId, newId);
    assert.equal((await req(owner, 'GET', base + '/suppliers')).json().length, 2);
    const metadata = await req(owner, 'PATCH', base + `/offers/${thirdDoc.id}/association`, {
      revision: thirdDoc.revision,
      newSupplier: {
        name: 'Synthetic contact supplier',
        registrationNumber: 'REG:005B',
        email: 'manual@example.test',
        comment: 'Synthetic optional comment',
      },
      note: 'Synthetic optional metadata',
    });
    assert.equal(metadata.statusCode, 200);
    assert.equal(
      (
        await pool.query('SELECT verified FROM tender_app.contact WHERE tender_id=$1 AND supplier_id=$2', [
          id,
          metadata.json().supplierId,
        ])
      ).rows[0].verified,
      false,
    );
    assert.equal(
      (await req(owner, 'GET', base + '/offers')).json().find((d) => d.id === thirdDoc.id).email,
      null,
    );
    phase = '005B receipt history and stages';
    const repeated = files[6];
    const before = (await req(owner, 'GET', base + '/offers')).json().find((d) => d.name === repeated.name);
    const stage1 = randomUUID(),
      stage2 = randomUUID();
    for (const [ordinal, stage] of [
      [1, stage1],
      [2, stage2],
    ])
      await pool.query(
        "INSERT INTO tender_app.tender_stage(id,tender_id,kind,ordinal,label,created_by) VALUES($1,$2,'round',$3,$4,$5)",
        [stage, id, ordinal, `Synthetic round ${ordinal}`, actor],
      );
    const receiptKey = randomUUID();
    assert.equal((await upload([repeated], receiptKey, owner, stage1)).statusCode, 201);
    assert.equal((await upload([repeated], receiptKey, owner, stage1)).statusCode, 201);
    assert.equal((await upload([repeated], receiptKey, owner, stage2)).statusCode, 409);
    assert.equal((await upload([repeated], randomUUID(), owner, stage2)).statusCode, 201);
    const history = (await req(owner, 'GET', base + '/offers')).json().find((d) => d.id === before.id);
    assert.equal(history.receipts.length, before.receipts.length + 2);
    assert.equal(history.receipts.filter((r) => r.batchId === receiptKey).length, 1);
    assert.ok(history.receipts.some((r) => r.stage === 'Synthetic round 1'));
    assert.ok(history.receipts.some((r) => r.stage === 'Synthetic round 2'));
    assert.ok(history.receipts.every((r) => r.actorId === actor && r.receivedAt));
    assert.equal(
      (
        await pool.query(
          'SELECT count(*)::int AS n FROM tender_app.document WHERE tender_id=$1 AND original_name=$2',
          [id, repeated.name],
        )
      ).rows[0].n,
      1,
    );
    assert.equal(
      (
        await pool.query('SELECT count(*)::int AS n FROM tender_app.blob WHERE sha256=$1', [
          createHash('sha256').update(repeated.content).digest('hex'),
        ])
      ).rows[0].n,
      1,
    );
    assert.equal((await upload([repeated], randomUUID(), owner, randomUUID())).statusCode, 400);
    assert.equal((await req(other, 'GET', base + '/offer-stages')).statusCode, 404);
    assert.equal((await req(owner, 'GET', base + '/offer-stages')).json().length, 2);
    phase = '005B legacy original preserves first known intake';
    const legacyTender = (
        await req(owner, 'POST', '/api/tenders', { title: 'Synthetic legacy original 005B' })
      ).json().id,
      legacyDoc = randomUUID(),
      legacyPackage = randomUUID(),
      legacyBase = `/api/tenders/${legacyTender}`;
    await pool.query('INSERT INTO tender_app.offer_package(id,tender_id) VALUES($1,$2)', [
      legacyPackage,
      legacyTender,
    ]);
    await pool.query(
      "INSERT INTO tender_app.document(id,tender_id,purpose,offer_package_id,original_name,mime_type,blob_sha256,uploaded_by,channel) VALUES($1,$2,'offer',$3,'legacy.pdf','application/pdf',$4,$5,'manual')",
      [
        legacyDoc,
        legacyTender,
        legacyPackage,
        createHash('sha256').update(files[0].content).digest('hex'),
        actor,
      ],
    );
    const legacyBefore = (await req(owner, 'GET', legacyBase + '/offers')).json()[0];
    assert.equal(legacyBefore.receipts.length, 1);
    assert.equal(legacyBefore.receipts[0].legacy, true);
    const legacyKey = randomUUID();
    assert.equal((await upload([files[0]], legacyKey, owner, undefined, legacyBase)).statusCode, 201);
    assert.equal((await upload([files[0]], legacyKey, owner, undefined, legacyBase)).statusCode, 201);
    const legacyAfter = (await req(owner, 'GET', legacyBase + '/offers')).json()[0];
    assert.equal(legacyAfter.name, 'legacy.pdf');
    assert.equal(legacyAfter.receipts.length, 2);
    assert.equal(legacyAfter.receipts[0].receivedAt, legacyBefore.receipts[0].receivedAt);
    assert.equal(legacyAfter.receipts.filter((r) => r.legacy).length, 1);
    await assert.rejects(
      () =>
        pool.query(
          "UPDATE tender_app.field_decision SET source_note='forbidden' WHERE document_id=$1 AND field_key='offer.received.v1'",
          [legacyDoc],
        ),
      (e) => e.code === '55000',
    );
    phase = 'permissions and originals';
    assert.equal((await upload([files[0]], randomUUID(), readOnly)).statusCode, 403);
    assert.equal((await req(other, 'GET', base + '/offers')).statusCode, 404);
    for (const file of files) {
      const doc = list.find((d) => d.name === file.name);
      const original = await req(owner, 'GET', base + `/offers/${doc.id}/original`);
      assert.equal(original.statusCode, 200);
      assert.deepEqual(original.rawPayload, file.content);
    }
    assert.equal((await req(other, 'GET', base + `/offers/${list[0].id}/original`)).statusCode, 404);
    phase = 'partial outcome and rejected archive audit';
    const mixed = await upload([
      { name: 'traversal.zip', mime: 'application/zip', content: Buffer.from('PK synthetic ../escape') },
      { name: 'extra.txt', mime: 'text/plain', content: Buffer.from('synthetic text') },
    ]);
    assert.equal(mixed.statusCode, 201);
    assert.equal(mixed.json().outcomes[0].status, 'rejected');
    assert.equal(mixed.json().outcomes[1].status, 'stored');
    assert.ok(
      (
        await pool.query(
          "SELECT 1 FROM tender_app.audit_event WHERE tender_id=$1 AND action='offer.rejected.archive_handler_not_approved'",
          [id],
        )
      ).rowCount,
    );
    phase = 'EML sender and attachments';
    const supplier = randomUUID();
    await pool.query('INSERT INTO tender_app.supplier(id,legal_name) VALUES($1,$2)', [
      supplier,
      'Synthetic supplier 005',
    ]);
    await pool.query('INSERT INTO tender_app.tender_supplier(tender_id,supplier_id) VALUES($1,$2)', [
      id,
      supplier,
    ]);
    await pool.query(
      'INSERT INTO tender_app.contact(id,tender_id,supplier_id,email,verified) VALUES($1,$2,$3,$4,true)',
      [randomUUID(), id, supplier, 'sales@example.test'],
    );
    const attachment = Buffer.from('%PDF-1.7 synthetic email attachment');
    const eml = {
      name: 'synthetic.eml',
      mime: 'message/rfc822',
      content: Buffer.from(
        `From: Sales <sales@example.test>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="sample"\r\n\r\n--sample\r\nContent-Type: text/plain\r\n\r\nSynthetic body\r\n--sample\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename="attached.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\n${attachment.toString('base64')}\r\n--sample--\r\n`,
      ),
    };
    const email = await upload([eml]);
    assert.equal(email.statusCode, 201);
    assert.equal(email.json().outcomes[0].documents.length, 2);
    list = (await req(owner, 'GET', base + '/offers')).json();
    const attached = list.find((d) => d.name === 'attached.pdf');
    assert.equal(attached.email, 'sales@example.test');
    assert.equal(attached.supplierId, supplier);
    assert.equal(attached.associationStatus, 'candidate');
    assert.ok(attached.parentId);
    phase = '005B same attachment from another sender preserves provenance';
    const supplierB = randomUUID();
    await pool.query('INSERT INTO tender_app.supplier(id,legal_name) VALUES($1,$2)', [
      supplierB,
      'Synthetic second sender',
    ]);
    await pool.query('INSERT INTO tender_app.tender_supplier(tender_id,supplier_id) VALUES($1,$2)', [
      id,
      supplierB,
    ]);
    await pool.query(
      'INSERT INTO tender_app.contact(id,tender_id,supplier_id,email,verified) VALUES($1,$2,$3,$4,true)',
      [randomUUID(), id, supplierB, 'second@example.test'],
    );
    const secondEmail = {
      ...eml,
      name: 'second.eml',
      content: Buffer.from(eml.content.toString().replace('sales@example.test', 'second@example.test')),
    };
    assert.equal((await upload([secondEmail])).statusCode, 201);
    const shared = (await req(owner, 'GET', base + '/offers')).json().find((d) => d.id === attached.id);
    assert.equal(shared.email, 'sales@example.test');
    assert.equal(shared.receipts.length, 2);
    assert.ok(
      shared.receipts.some((r) => r.supplierId === supplier && r.senderEmail === 'sales@example.test'),
    );
    assert.ok(
      shared.receipts.some((r) => r.supplierId === supplierB && r.senderEmail === 'second@example.test'),
    );
    phase = 'manual association and stale writes';
    const doc = list.find((d) => d.name === files[0].name),
      url = base + `/offers/${doc.id}/association`;
    const priorDecisions = (
      await pool.query(
        "SELECT count(*)::int AS n FROM tender_app.field_decision WHERE document_id=$1 AND field_key='offer.supplier'",
        [doc.id],
      )
    ).rows[0].n;
    const decision = {
      revision: doc.revision,
      supplierId: supplier,
      note: 'Synthetic manual source confirmation',
    };
    assert.equal((await req(readOnly, 'PATCH', url, decision)).statusCode, 403);
    assert.equal((await req(owner, 'PATCH', url, decision)).statusCode, 200);
    assert.equal((await req(owner, 'PATCH', url, decision)).statusCode, 409);
    assert.equal(
      (await req(owner, 'GET', base + `/offers/${doc.id}/original`)).rawPayload.equals(files[0].content),
      true,
    );
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM tender_app.field_decision WHERE document_id=$1 AND field_key='offer.supplier'",
          [doc.id],
        )
      ).rows[0].n,
      priorDecisions + 1,
    );
    phase = 'concurrent replay';
    const concurrentKey = randomUUID(),
      concurrentFile = {
        name: 'concurrent.pdf',
        mime: 'application/pdf',
        content: Buffer.from('%PDF-1.7 concurrent synthetic'),
      };
    const concurrent = await Promise.all([
      upload([concurrentFile], concurrentKey),
      upload([concurrentFile], concurrentKey),
    ]);
    assert.equal(concurrent[0].statusCode, 201);
    assert.deepEqual(concurrent[0].json(), concurrent[1].json());
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM tender_app.document WHERE tender_id=$1 AND original_name='concurrent.pdf'",
          [id],
        )
      ).rows[0].n,
      1,
    );
    phase = 'batch limits';
    assert.equal((await upload(Array.from({ length: 11 }, () => files[0]))).statusCode, 400);
    console.log(
      'PASS TASK005B and TASK005 regression: two batches/7 originals, replay/dedup/conflict, partial rejection+audit, EML attachment+candidate, manual append-only association, stale writes, permissions and limits. Synthetic fixtures retained.',
    );
  } catch (e) {
    console.error(`FAIL TASK005 phase=${phase} code=${e.code ?? e.name}`);
    throw e;
  } finally {
    for (const app of apps) await app.close();
    await pool.end();
  }
}
