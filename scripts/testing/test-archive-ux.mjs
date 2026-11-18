// Explicit opt-in. TASK-014 creates a new empty UUID database; never use a retained/source DB.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { isolatedRun } from './isolated-run.mjs';
import { json, workspace, repo } from '../task008-gate-d/io.mjs';
if (!process.argv.includes('--run')) {
  console.log(
    'Preview only. --run uses TASK-014 bootstrap including schema initialization in a NEW disposable DB. Separate approval required when migrations are prohibited.',
  );
  process.exit(0);
}
const require = createRequire(import.meta.url);
const { createApplication } = require('../../apps/api/dist/application.js');
const { PgTenderRepository } = require('../../apps/api/dist/data/repository.js');
const { PgScopeRepository } = require('../../apps/api/dist/data/scope-repository.js');
const { PgOfferRepository } = require('../../apps/api/dist/data/offer-repository.js');
const { PgLifecycleRepository } = require('../../apps/api/dist/lifecycle/lifecycle-repository.js');
const { ocrInventory } = require('../../apps/api/dist/lifecycle/ocr-inventory.js');
const { FileStore } = require('../../apps/api/dist/storage/file-store.js');
const run = await isolatedRun('ux-lifecycle-001');
const pool = run.pool,
  actor = randomUUID(),
  token = randomBytes(32).toString('hex'),
  reason = 'Архивирование по решению пользователя';
let app,
  passed = false;
const sha = (b) => createHash('sha256').update(b).digest('hex');
try {
  assert.ok(
    (await readFile(resolve(repo, 'apps/web/src/archive-api.ts'), 'utf8')).includes(
      "export const ARCHIVE_REASON = '" + reason + "'",
    ),
  );
  await pool.query(
    "INSERT INTO tender_app.app_user(id,external_subject,display_name) VALUES($1,$2,'Synthetic UX user')",
    [actor, 'synthetic-' + run.runId],
  );
  const tenders = new PgTenderRepository(pool),
    scope = new PgScopeRepository(pool),
    offers = new PgOfferRepository(pool);
  const tender = await tenders.create(actor, 'Synthetic UX-LIFECYCLE-001 archive/restore');
  const lifecycle = new PgLifecycleRepository(pool, (id) => ocrInventory(workspace, [run.storageRoot], id));
  app = await createApplication({
    logger: false,
    environment: 'test',
    data: {
      enabled: true,
      token,
      actorId: actor,
      repository: tenders,
      scopeRepository: scope,
      offerRepository: offers,
      lifecycleEnabled: true,
      lifecycleRepository: lifecycle,
    },
  });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const headers = { authorization: 'Bearer ' + token },
    url = '/api/tenders/' + tender.id;
  async function request(method, path, payload, status = 200) {
    const r = await app.inject({ method, url: path, headers, ...(payload ? { payload } : {}) });
    assert.equal(r.statusCode, status, method + ' ' + path);
    return r.json();
  }
  const store = new FileStore(run.storageRoot, workspace),
    spec = randomUUID(),
    doc = randomUUID();
  const originals = [];
  for (const [id, purpose, text] of [
    [spec, 'specification', 'Synthetic UX-LIFECYCLE-001 specification: two units'],
    [doc, 'offer', 'Synthetic UX-LIFECYCLE-001 offer: 250 RUB'],
  ]) {
    const bytes = Buffer.from(text),
      stored = await store.put(bytes);
    await pool.query('INSERT INTO tender_app.blob(sha256,storage_key,byte_size) VALUES($1,$2,$3)', [
      stored.sha256,
      stored.key,
      stored.bytes,
    ]);
    if (purpose === 'specification')
      await pool.query(
        "INSERT INTO tender_app.document(id,tender_id,purpose,original_name,mime_type,blob_sha256,uploaded_by) VALUES($1,$2,$3,$4,'text/plain',$5,$6)",
        [id, tender.id, purpose, 'synthetic-' + purpose + '.txt', stored.sha256, actor],
      );
    originals.push({ id, purpose, sha256: stored.sha256 });
  }
  const supplier = randomUUID(),
    lot = randomUUID(),
    pack = randomUUID(),
    offer = randomUUID(),
    field = randomUUID(),
    version = randomUUID();
  await pool.query(
    "INSERT INTO tender_app.supplier(id,legal_name) VALUES($1,'Synthetic UX-LIFECYCLE-001 supplier')",
    [supplier],
  );
  await pool.query('INSERT INTO tender_app.tender_supplier(tender_id,supplier_id) VALUES($1,$2)', [
    tender.id,
    supplier,
  ]);
  await pool.query(
    "INSERT INTO tender_app.lot(id,tender_id,name,ordinal,created_by) VALUES($1,$2,'Synthetic lot',1,$3)",
    [lot, tender.id, actor],
  );
  await pool.query(
    "INSERT INTO tender_app.lot_item(id,lot_id,ordinal,item_name,quantity,unit,created_by) VALUES($1,$2,1,'Synthetic item',2,'pcs',$3)",
    [randomUUID(), lot, actor],
  );
  await pool.query('INSERT INTO tender_app.offer_package(id,tender_id,supplier_id) VALUES($1,$2,$3)', [
    pack,
    tender.id,
    supplier,
  ]);
  await pool.query(
    "INSERT INTO tender_app.document(id,tender_id,offer_package_id,purpose,original_name,mime_type,blob_sha256,uploaded_by,supplier_id) VALUES($1,$2,$3,'offer','synthetic-offer.txt','text/plain',$4,$5,$6)",
    [doc, tender.id, pack, originals.find((x) => x.id === doc).sha256, actor, supplier],
  );
  await pool.query(
    'INSERT INTO tender_app.offer(id,tender_id,supplier_id,lot_id,offer_package_id,created_by) VALUES($1,$2,$3,$4,$5,$6)',
    [offer, tender.id, supplier, lot, pack, actor],
  );
  for (const [v, amount, id] of [
    [1, 250, version],
    [2, 225, randomUUID()],
  ])
    await pool.query(
      "INSERT INTO tender_app.offer_version(id,offer_package_id,version,created_by,offer_id,lot_id,tender_id,amount,currency,is_initial) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'RUB',$9)",
      [id, pack, v, actor, offer, lot, tender.id, amount, v === 1],
    );
  await pool.query(
    "INSERT INTO tender_app.cost_component(id,offer_version_id,name,amount,currency,treatment,source,created_by) VALUES($1,$2,'Synthetic delivery',10,'RUB','add','synthetic',$3)",
    [randomUUID(), version, actor],
  );
  await pool.query(
    "INSERT INTO tender_app.extraction_run(id,document_id,model_tag,prompt_version,parser_version,status) VALUES($1,$2,'synthetic','synthetic','synthetic','completed')",
    [randomUUID(), doc],
  );
  await pool.query(
    "INSERT INTO tender_app.extracted_field(id,document_id,field_name,value,confidence,extractor_version,document_revision) VALUES($1,$2,'synthetic.price','250',1,'synthetic',1)",
    [field, doc],
  );
  await pool.query(
    "INSERT INTO tender_app.field_decision(id,document_id,extracted_field_id,field_key,value,source_type,source_note,decided_by) VALUES($1,$2,$3,'synthetic.price','250','document','Synthetic fixture',$4)",
    [randomUUID(), doc, field, actor],
  );
  await pool.query(
    'INSERT INTO tender_app.document_receipt(tender_id,request_key,request_hash,document_id) VALUES($1,$2,$3,$4)',
    [tender.id, randomUUID(), 'a'.repeat(64), doc],
  );

  async function snapshot() {
    const tables = {};
    for (const { table_name: name } of (
      await pool.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema='tender_app' AND table_type='BASE TABLE' ORDER BY table_name",
      )
    ).rows) {
      assert.match(name, /^[a-z_]+$/);
      const rows = (await pool.query('SELECT to_jsonb(t)::text value FROM tender_app.' + name + ' t')).rows
        .map((x) => x.value)
        .sort();
      tables[name] = { count: rows.length, sha256: sha(JSON.stringify(rows)) };
    }
    const files = [];
    for (const b of (await pool.query('SELECT sha256::text,storage_key FROM tender_app.blob')).rows) {
      const bytes = await readFile(resolve(run.storageRoot, b.storage_key));
      assert.equal(sha(bytes), b.sha256);
      files.push({ path: b.storage_key, sha256: b.sha256, bytes: bytes.length });
    }
    return {
      tables,
      files,
      tenders: (await pool.query('SELECT to_jsonb(t) row FROM tender_app.tender t ORDER BY id')).rows.map(
        (x) => x.row,
      ),
      audits: (await pool.query('SELECT to_jsonb(t) row FROM tender_app.audit_event t ORDER BY id')).rows.map(
        (x) => x.row,
      ),
    };
  }
  const before = await snapshot();
  await json(resolve(run.runRoot, 'ux-before.json'), before);
  const p = await request('GET', url + '/lifecycle');
  assert.equal(p.state, 'active');
  assert.equal(p.allowed.archive, true);
  const payload = (p, action) => ({
    action,
    confirmationId: p.id,
    confirmationTitle: p.title,
    previewHash: p.previewHash,
    reason,
  });
  const archived = await request('POST', url + '/lifecycle', payload(p, 'archive'), 201);
  assert.equal(archived.state, 'archived');
  assert.equal(Number(archived.dependencyRevision), before.tenders[0].dependency_revision + 3);
  assert.equal((await request('GET', '/api/tenders/lifecycle/page?state=active')).total, 0);
  assert.equal((await request('GET', '/api/tenders/lifecycle/page?state=archived')).total, 1);
  const event = (
    await pool.query("SELECT * FROM tender_app.lifecycle_event WHERE tender_id=$1 AND action='archive'", [
      tender.id,
    ])
  ).rows;
  assert.equal(event.length, 1);
  assert.equal(event[0].reason, reason);
  assert.equal(event[0].actor_id, actor);
  assert.ok(event[0].created_at);
  const archiveAudit = (
    await pool.query(
      "SELECT actor_id,created_at FROM tender_app.audit_event WHERE tender_id=$1 AND action='tender.lifecycle.archive'",
      [tender.id],
    )
  ).rows;
  assert.equal(archiveAudit.length, 1);
  assert.equal(archiveAudit[0].actor_id, actor);
  assert.ok(archiveAudit[0].created_at);
  const fresh = await request('GET', url + '/lifecycle');
  assert.equal(fresh.allowed.restore, true);
  const restored = await request('POST', url + '/lifecycle', payload(fresh, 'restore'), 201);
  assert.equal(restored.state, 'active');
  // Existing BEFORE INSERT and BEFORE UPDATE triggers both fire for the restore UPSERT.
  assert.equal(Number(restored.dependencyRevision), Number(fresh.dependencyRevision) + 4);
  assert.equal((await request('GET', '/api/tenders/lifecycle/page?state=active')).total, 1);
  assert.equal((await request('GET', '/api/tenders/lifecycle/page?state=archived')).total, 0);
  const after = await snapshot();
  const changed = new Set(['tender', 'audit_event', 'tender_lifecycle', 'lifecycle_event']);
  for (const [k, v] of Object.entries(before.tables))
    if (!changed.has(k)) assert.deepEqual(after.tables[k], v, k);
  assert.deepEqual(after.files, before.files);
  assert.equal(after.tables.document.count, 2);
  assert.equal(after.tables.offer_version.count, 2);
  assert.equal(after.tables.extraction_run.count, 1);
  for (const old of before.audits)
    assert.deepEqual(
      after.audits.find((x) => x.id === old.id),
      old,
    );
  assert.equal(after.audits.length, before.audits.length + 2);
  const expected = structuredClone(before.tenders[0]);
  expected.dependency_revision += 7;
  assert.deepEqual(after.tenders, [expected]);
  for (const original of originals) {
    const part = original.purpose === 'specification' ? 'tz' : 'offers';
    const response = await app.inject({
      method: 'GET',
      url: url + '/' + part + '/' + original.id + '/original',
      headers,
    });
    assert.equal(response.statusCode, 200);
    assert.equal(sha(response.rawPayload), original.sha256);
  }
  await json(resolve(run.runRoot, 'ux-after.json'), after);
  await json(resolve(run.runRoot, 'ux-results.json'), {
    status: 'PASS',
    database: run.database,
    runId: run.runId,
    tenderId: tender.id,
    actor,
    standardReason: reason,
    reasonActorAndTimestampPersisted: true,
    archiveRestoreActualApi: true,
    documentsVersionsPricesOCRPreserved: true,
    allOriginalsSha256Preserved: true,
  });
  passed = true;
  console.log(
    'PASS isolated archive/restore, persisted reason/actor/time, 31 immutable tables and original files',
  );
} finally {
  await app?.close();
  await run.close(passed ? 'PASSED_RETAINED' : 'FAILED_RETAINED');
}
