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
import extraction from '../apps/api/dist/extraction/extraction-repository.js';
if (!process.argv.includes('--run'))
  console.log(
    'Preview: no database connection; --run uses only approved larta_test_task003 and leaves synthetic fixtures.',
  );
else {
  const root = fileURLToPath(new URL('../', import.meta.url));
  config({ path: resolve(root, '.env'), quiet: true });
  if (process.env.PGDATABASE !== 'larta_test_task003')
    throw new Error('Approved disposable test database required.');
  const pool = new pg.Pool({ connectionTimeoutMillis: 5000, statement_timeout: 10000 });
  const apps = [];
  const actor = randomUUID(),
    reviewer = randomUUID(),
    outsider = randomUUID(),
    token = randomBytes(32).toString('hex');
  const headers = { authorization: `Bearer ${token}` };
  let phase = 'setup';
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
        extractionRepository: new extraction.TzExtractionRepository(pool),
      },
    });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    apps.push(app);
    return app;
  };
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
        `synthetic:004a:${user}`,
        'Synthetic PDF reviewer',
      ]);
    const owner = await start(actor),
      readOnly = await start(reviewer),
      other = await start(outsider);
    const request = (app, method, url, payload) => app.inject({ method, url, headers, payload });
    const create = async () => {
      const r = await request(owner, 'POST', '/api/tenders', { title: 'Synthetic PDF extraction test' });
      assert.equal(r.statusCode, 201);
      return r.json().id;
    };
    const bytes = await readFile(resolve(root, 'tests/fixtures/tz-seven-items.pdf'));
    const upload = async (id, content, name) => {
      const boundary = 'fixture-' + randomUUID();
      const r = await owner.inject({
        method: 'POST',
        url: `/api/tenders/${id}/tz`,
        headers: {
          ...headers,
          'content-type': `multipart/form-data; boundary=${boundary}`,
          'idempotency-key': randomUUID(),
        },
        payload: Buffer.concat([
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/pdf\r\n\r\n`,
          ),
          content,
          Buffer.from(`\r\n--${boundary}--\r\n`),
        ]),
      });
      assert.equal(r.statusCode, 201);
      return r.json();
    };
    const id = await create(),
      doc = await upload(id, bytes, 'synthetic.pdf'),
      base = `/api/tenders/${id}/tz/${doc.id}`;
    await pool.query(
      "INSERT INTO tender_app.tender_member(tender_id,user_id,role) VALUES($1,$2,'reviewer')",
      [id, reviewer],
    );
    phase = 'extract';
    assert.equal((await request(readOnly, 'POST', base + '/extractions')).statusCode, 403);
    assert.equal((await request(other, 'GET', base + '/draft')).statusCode, 404);
    const r = await request(owner, 'POST', base + '/extractions');
    assert.equal(r.statusCode, 201);
    const draft = r.json();
    assert.equal(draft.status, 'draft');
    assert.equal(draft.items.length, 7);
    assert.deepEqual(
      draft.items.map((i) => i.quantity),
      ['70', '40', '30', '30', '30', '40', '20'],
    );
    let scope = (await request(owner, 'GET', `/api/tenders/${id}/scope`)).json();
    assert.equal(scope.items.length, 0);
    assert.notEqual(scope.scopeStatus, 'confirmed');
    const source = await request(owner, 'GET', base + '/source/2');
    assert.equal(source.statusCode, 200);
    assert.match(source.json().text, /T10\/7660-V-Z-MG142/);
    const original = await request(owner, 'GET', base + '/original');
    assert.deepEqual(original.rawPayload, bytes);
    const item = (i) => ({
      sourceIndex: i.sourceIndex,
      name: i.name,
      quantity: i.quantity,
      unit: i.unit,
      technicalRequirements: i.technicalRequirements,
    });
    const input = { revision: scope.revision, items: draft.items.map(item) };
    input.items[0].quantity = '71';
    input.items[0].name += ' (исправлено)';
    const confirmUrl = base + `/extractions/${draft.runId}/confirm`;
    phase = 'confirm';
    assert.equal((await request(readOnly, 'POST', confirmUrl, input)).statusCode, 403);
    assert.equal(
      (await request(owner, 'POST', confirmUrl, { ...input, revision: input.revision + 1 })).statusCode,
      409,
    );
    assert.equal(
      (await request(owner, 'POST', confirmUrl, { ...input, items: [{ ...input.items[0], quantity: '0' }] }))
        .statusCode,
      400,
    );
    const confirmed = await request(owner, 'POST', confirmUrl, input);
    assert.equal(confirmed.statusCode, 201);
    scope = confirmed.json();
    assert.equal(scope.items.length, 7);
    assert.equal(scope.items[0].quantity, '71.000000');
    assert.match(scope.items[0].technicalRequirements, /Supergrip/);
    assert.match(scope.items[5].technicalRequirements, /PAZ \/ PAR/);
    const ids = scope.items.map((i) => i.id);
    assert.equal((await request(owner, 'POST', confirmUrl, input)).statusCode, 201);
    assert.equal(
      (await request(owner, 'POST', confirmUrl, { ...input, items: [{ ...input.items[0], quantity: '72' }] }))
        .statusCode,
      409,
    );
    phase = 'repeat';
    assert.equal((await upload(id, bytes, 'synthetic.pdf')).id, doc.id);
    const again = await request(owner, 'POST', base + '/extractions');
    assert.equal(again.json().status, 'confirmed');
    assert.equal(again.json().runId, draft.runId);
    scope = (await request(owner, 'GET', `/api/tenders/${id}/scope`)).json();
    assert.deepEqual(
      scope.items.map((i) => i.id),
      ids,
    );
    assert.equal(scope.items[0].quantity, '71.000000');
    const audit = await pool.query(
      "SELECT count(*) FROM tender_app.audit_event WHERE tender_id=$1 AND action='tz.scope.confirmed'",
      [id],
    );
    assert.equal(audit.rows[0].count, '1');
    phase = 'needs_ocr';
    const scanId = await create(),
      scan = await upload(
        scanId,
        await readFile(resolve(root, 'tests/fixtures/tz-no-text.pdf')),
        'synthetic-scan.pdf',
      );
    const scanBase = `/api/tenders/${scanId}/tz/${scan.id}`;
    const scanResult = (await request(owner, 'POST', scanBase + '/extractions')).json();
    assert.equal(scanResult.status, 'needs_ocr');
    assert.equal(scanResult.items.length, 0);
    assert.equal((await request(owner, 'GET', `/api/tenders/${scanId}/scope`)).json().items.length, 0);
    console.log(
      'PASS: real PDF draft seven rows; no LotItem before approval; source pages/artifact; original SHA/bytes intact; correction + confirm + reload; reviewer/outsider denied; stale/invalid confirmation rejected; replay does not duplicate or overwrite; scan needs_ocr. Synthetic fixtures remain.',
    );
  } catch (error) {
    console.error(
      `TASK-004A failed at ${phase} (${error.code ?? error.name}); no secrets or document text printed.`,
    );
    process.exitCode = 1;
  } finally {
    await Promise.all(apps.map((app) => app.close()));
    await pool.end();
  }
}
