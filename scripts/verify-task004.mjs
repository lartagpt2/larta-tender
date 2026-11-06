// Explicit opt-in: writes synthetic fixtures only to the approved disposable test database.
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { config } from 'dotenv';
import pg from 'pg';
import application from '../apps/api/dist/application.js';
import repositories from '../apps/api/dist/data/repository.js';
import scopes from '../apps/api/dist/data/scope-repository.js';
if (!process.argv.includes('--run'))
  console.log('Preview: no connection. --run writes synthetic fixtures to larta_test_task003 only.');
else {
  const root = fileURLToPath(new URL('../', import.meta.url));
  config({ path: resolve(root, '.env'), quiet: true });
  if (process.env.PGDATABASE !== 'larta_test_task003')
    throw new Error('Only approved larta_test_task003 is allowed.');
  const pool = new pg.Pool({ connectionTimeoutMillis: 5000, statement_timeout: 10000, max: 5 });
  const apps = [];
  const token = randomBytes(32).toString('hex');
  const headers = { authorization: `Bearer ${token}` };
  const actor = randomUUID(),
    reviewer = randomUUID(),
    outsider = randomUUID();
  const actorApp = async (actorId) => {
    const app = await application.createApplication({
      logger: false,
      environment: 'test',
      data: {
        enabled: true,
        token,
        actorId,
        repository: new repositories.PgTenderRepository(pool),
        scopeRepository: new scopes.PgScopeRepository(pool),
      },
    });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    apps.push(app);
    return app;
  };
  try {
    const expected = createHash('sha256')
      .update(await readFile(resolve(root, 'infra/migrations/002_domain_foundation.sql')))
      .digest('hex');
    assert.equal(
      (
        await pool.query(
          "SELECT sha256 FROM tender_app.schema_migrations WHERE name='002_domain_foundation.sql'",
        )
      ).rows[0]?.sha256,
      expected,
    );
    for (const id of [actor, reviewer, outsider])
      await pool.query('INSERT INTO tender_app.app_user(id,external_subject,display_name) VALUES($1,$2,$3)', [
        id,
        `synthetic:task004:${id}`,
        'Synthetic TASK-004',
      ]);
    const ownerApp = await actorApp(actor),
      reviewerApp = await actorApp(reviewer),
      outsiderApp = await actorApp(outsider);
    const request = (app, method, url, payload) => app.inject({ method, url, headers, payload });
    const post = (payload) => request(ownerApp, 'POST', '/api/tenders', payload);
    const item = { name: 'Synthetic pump', quantity: '2.000001', unit: 'шт.' };
    for (const quantity of ['0', '-1', '1e3', '0.0000001', '1000000000000', 2, null])
      assert.equal(
        (await post({ title: 'Invalid synthetic', creationMode: 'manual', items: [{ ...item, quantity }] }))
          .statusCode,
        400,
      );
    for (const payload of [
      { title: 'x', creationMode: 'manual', items: [] },
      { title: 'x', creationMode: 'manual', items: null },
      { title: 'x', items: [item] },
    ])
      assert.equal((await post(payload)).statusCode, 400);
    const created = await post({
      title: 'Synthetic task004 persisted scope',
      creationMode: 'manual',
      items: [
        item,
        { name: 'Synthetic cabinet', quantity: '1', unit: 'компл.' },
        { name: 'Synthetic installation', quantity: '1.5', unit: 'час' },
      ],
    });
    assert.equal(created.statusCode, 201);
    const id = created.json().id;
    const scopeUrl = `/api/tenders/${id}/scope`;
    await pool.query(
      "INSERT INTO tender_app.tender_member(tender_id,user_id,role) VALUES($1,$2,'reviewer')",
      [id, reviewer],
    );
    const read = async () => {
      const r = await request(ownerApp, 'GET', scopeUrl);
      assert.equal(r.statusCode, 200);
      return r.json();
    };
    let state = await read();
    assert.equal(state.items.length, 3);
    assert.equal(state.items[0].quantity, '2.000001');
    assert.equal((await request(reviewerApp, 'GET', scopeUrl)).statusCode, 200);
    assert.equal((await request(outsiderApp, 'GET', scopeUrl)).statusCode, 404);
    assert.equal(
      (
        await request(reviewerApp, 'PATCH', scopeUrl, {
          revision: state.revision,
          specificationSkipped: true,
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (await request(ownerApp, 'PATCH', scopeUrl, { revision: state.revision, items: null })).statusCode,
      400,
    );
    const parallel = await Promise.all([
      request(ownerApp, 'PATCH', scopeUrl, { revision: state.revision, selectionMode: 'items' }),
      request(ownerApp, 'PATCH', scopeUrl, { revision: state.revision, specificationSkipped: true }),
    ]);
    assert.deepEqual(parallel.map((r) => r.statusCode).sort(), [200, 409]);
    state = await read();
    assert.equal(state.revision, 2);
    assert.equal(
      (
        await request(ownerApp, 'PATCH', scopeUrl, {
          revision: state.revision,
          items: [],
          selectionMode: 'items',
        })
      ).statusCode,
      400,
    );
    assert.equal((await read()).items.length, 3, 'Failed scope replacement must roll back');
    const upload = async (app, key, name, mime, bytes) => {
      const boundary = `test-${randomUUID()}`;
      const payload = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${mime}\r\n\r\n`,
        ),
        bytes,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      return app.inject({
        method: 'POST',
        url: `/api/tenders/${id}/tz`,
        headers: {
          ...headers,
          'content-type': `multipart/form-data; boundary=${boundary}`,
          'idempotency-key': key,
        },
        payload,
      });
    };
    const key = randomUUID(),
      bytes = Buffer.from(`Synthetic TZ ${randomUUID()}`);
    assert.equal((await upload(reviewerApp, key, 'test.txt', 'text/plain', bytes)).statusCode, 403);
    assert.equal(
      (await upload(ownerApp, randomUUID(), 'fake.pdf', 'application/pdf', bytes)).statusCode,
      400,
    );
    const original = await upload(ownerApp, key, 'test.txt', 'text/plain', bytes);
    assert.equal(original.statusCode, 201);
    assert.equal(original.json().status, 'uploaded');
    const replay = await upload(ownerApp, key, 'test.txt', 'text/plain', bytes);
    assert.equal(replay.statusCode, 201);
    assert.equal(replay.json().id, original.json().id);
    assert.equal(
      (await upload(ownerApp, key, 'test.txt', 'text/plain', Buffer.from('Different synthetic original')))
        .statusCode,
      409,
    );
    const duplicate = await upload(ownerApp, randomUUID(), 'renamed.txt', 'text/plain', bytes);
    assert.equal(duplicate.statusCode, 201);
    assert.equal(duplicate.json().id, original.json().id);
    assert.equal(duplicate.json().name, 'test.txt');
    const download = await request(ownerApp, 'GET', `/api/tenders/${id}/tz/${original.json().id}/original`);
    assert.equal(download.statusCode, 200);
    assert.deepEqual(download.rawPayload, bytes);
    assert.match(download.headers['content-disposition'], /^attachment;/);
    assert.equal(
      (await request(outsiderApp, 'GET', `/api/tenders/${id}/tz/${original.json().id}/original`)).statusCode,
      404,
    );
    assert.equal(
      (
        await upload(
          ownerApp,
          randomUUID(),
          'large.txt',
          'text/plain',
          Buffer.alloc(20 * 1024 * 1024 + 1, 65),
        )
      ).statusCode,
      413,
    );
    const docs = await request(ownerApp, 'GET', `/api/tenders/${id}/tz`);
    assert.equal(docs.json().length, 1);
    const audit = await pool.query(
      "SELECT count(*) FROM tender_app.audit_event WHERE tender_id=$1 AND action='specification.uploaded'",
      [id],
    );
    assert.equal(audit.rows[0].count, '1');
    assert.equal(
      (await read()).items.length,
      3,
      'Uploading TZ must not invent or replace confirmed manual positions',
    );
    console.log(
      'PASS: persisted three positions, exact decimal, reviewer read-only, outsider hidden, optimistic concurrency, invalid replacement rollback, file signature, upload replay/conflict/deduplication, single audit, no invented OCR. Synthetic fixtures remain.',
    );
  } catch (error) {
    console.error(
      `TASK-004 checks failed (${error.code ?? error.name ?? 'unknown'}). No credentials or payloads printed.`,
    );
    process.exitCode = 1;
  } finally {
    await Promise.all(apps.map((app) => app.close()));
    await pool.end();
  }
}
