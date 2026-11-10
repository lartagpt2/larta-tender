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
        `synthetic:005:${user}`,
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
    const created = await req(owner, 'POST', '/api/tenders', { title: 'Synthetic TASK005 upload' });
    assert.equal(created.statusCode, 201);
    const id = created.json().id,
      base = `/api/tenders/${id}`;
    await pool.query(
      "INSERT INTO tender_app.tender_member(tender_id,user_id,role) VALUES($1,$2,'reviewer')",
      [id, reviewer],
    );
    const upload = async (files, key = randomUUID(), app = owner) => {
      const boundary = 'fixture-' + randomUUID();
      return app.inject({
        method: 'POST',
        url: base + '/offers/batches',
        headers: {
          ...headers,
          'content-type': `multipart/form-data; boundary=${boundary}`,
          'idempotency-key': key,
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
    phase = 'manual association and stale writes';
    const doc = list.find((d) => d.name === files[0].name),
      url = base + `/offers/${doc.id}/association`;
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
      1,
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
      'PASS TASK005: two batches/7 originals, replay/dedup/conflict, partial rejection+audit, EML attachment+candidate, manual append-only association, stale writes, permissions and limits. Synthetic fixtures retained.',
    );
  } catch (e) {
    console.error(`FAIL TASK005 phase=${phase} code=${e.code ?? e.name}`);
    throw e;
  } finally {
    for (const app of apps) await app.close();
    await pool.end();
  }
}
