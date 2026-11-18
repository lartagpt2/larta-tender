// Historical restored-copy procedure is closed to further mutations.
if (process.argv.includes('--run')) {
  throw new Error(
    'Restored-copy fixture creation is disabled. Use scripts/task009a/test-lifecycle.mjs --run for a NEW isolated database; no cleanup is authorized.',
  );
}
// Explicit validation of the approved RESTORED COPY only. Does not create databases or apply migrations.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { config } from 'dotenv';
import net from 'node:net';
import pg from 'pg';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  PgLifecycleRepository,
  protectedTenders,
} = require('../../apps/api/dist/lifecycle/lifecycle-repository.js');
const { PgTenderRepository } = require('../../apps/api/dist/data/repository.js');
const { FileStore } = require('../../apps/api/dist/storage/file-store.js');
const { PgScopeRepository } = require('../../apps/api/dist/data/scope-repository.js');
const { createApplication } = require('../../apps/api/dist/application.js');
const { repo, workspace, json } = await import('../task008-gate-d/io.mjs');

const db = 'larta_test_task009a_20261112124104406';
const approved = 'af1c943240ea3e53092fe3ed86041e522e6132a928b7b9c53dbc67118b5d6b53';
if (!process.argv.includes('--run') || process.argv[process.argv.indexOf('--database') + 1] !== db)
  throw Error('Explicit approved restored-copy database required');
config({ path: resolve(repo, '.env'), quiet: true });
const out = resolve(workspace, 'temp/task009a-migration-validation');
const runId = randomUUID(),
  fixtureStorage = resolve(out, 'fixtures', runId),
  created = [];
process.env.PGHOST = '127.0.0.1';
process.env.PGDATABASE = db;
process.env.PGAPPNAME = 'task009a-copy-validation';
process.env.DOCUMENT_AI_ENABLED = 'false';
process.env.TENDER_LIFECYCLE_ENABLED = 'true';
process.env.STORAGE_ROOT = fixtureStorage;
const connect = pg.Client.prototype.connect;
let blockedSourceConnections = 0,
  blockedEgress = 0,
  httpPort = 0;
pg.Client.prototype.connect = function (...args) {
  if (this.connectionParameters.database !== db) {
    blockedSourceConnections++;
    throw Error('Source/other database connection forbidden');
  }
  return connect.apply(this, args);
};
const socketConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  let a = args[0];
  if (Array.isArray(a)) a = a[0];
  const port = typeof a === 'object' ? Number(a.port) : Number(a),
    host = typeof a === 'object' ? a.host : args[1];
  if (host !== '127.0.0.1' || (port !== 5432 && port !== httpPort)) {
    blockedEgress++;
    throw Error('External egress forbidden');
  }
  return socketConnect.apply(this, args);
};
const pool = new pg.Pool({
  host: '127.0.0.1',
  database: db,
  max: 8,
  connectionTimeoutMillis: 5000,
  statement_timeout: 10000,
});
pool.on('connect', (c) => assert.equal(c.connectionParameters.database, db));
const { JobStore } = require('../../apps/api/dist/document-ai/job-store.js');
const { ocrInventory } = require('../../apps/api/dist/lifecycle/ocr-inventory.js');
const { PgOfferRepository } = require('../../apps/api/dist/data/offer-repository.js');
const { PgVerificationRepository } = require('../../apps/api/dist/comparison/verification-repository.js');
const { PgStageRepository } = require('../../apps/api/dist/stages/stage-repository.js');
const { TzExtractionRepository } = require('../../apps/api/dist/extraction/extraction-repository.js');
const { PgAIRepository } = require('../../apps/api/dist/document-ai/ai-repository.js');
const ctx = JSON.parse(
  await readFile(resolve(workspace, 'temp/task009a-backup-restore/context.json'), 'utf8'),
);
const cloneBase = resolve(ctx.runRoot, 'restored/workspace');
const ocrRoots = [fixtureStorage, ...ctx.roots.map((p) => resolve(cloneBase, p.slice(workspace.length + 1)))];
const jobStore = new JobStore(fixtureStorage, workspace);
let fixtureBlob;
const results = [];
let app;
const ok = (name) => {
  results.push({ name, result: 'PASS' });
  console.log('PASS ' + name);
};
try {
  assert.equal((await pool.query('SELECT current_database() db')).rows[0].db, db);

  const hashes = { '003_tender_lifecycle.sql': approved };
  assert.equal(
    createHash('sha256')
      .update(await readFile(resolve(repo, 'infra/migrations/003_tender_lifecycle.sql')))
      .digest('hex'),
    approved,
  );
  const ledger = (
    await pool.query('SELECT name,sha256::text FROM tender_app.schema_migrations ORDER BY name')
  ).rows;
  assert.equal(ledger.length, 3);
  assert.equal(ledger[2].sha256, approved);
  await assert.rejects(async () => new pg.Client({ database: 'larta_test_task003' }).connect(), /forbidden/);
  await assert.rejects(() => fetch('http://127.0.0.1:11434/api/version'));
  ok('explicit copy connection guard; source and Ollama connections refused; OCR disabled');
  const actor = randomUUID(),
    buyer = randomUUID(),
    reviewer = randomUUID(),
    outsider = randomUUID();
  for (const id of [actor, buyer, reviewer, outsider])
    await pool.query(
      "INSERT INTO tender_app.app_user(id,external_subject,display_name) VALUES($1,$2,'Synthetic test')",
      [id, 'synthetic-' + id],
    );
  const tenders = new PgTenderRepository(pool),
    scope = new PgScopeRepository(pool);
  const a = await tenders.create(actor, 'Synthetic lifecycle A'),
    b = await tenders.create(actor, 'Synthetic lifecycle B');
  created.push(a.id, b.id);
  await pool.query(
    "INSERT INTO tender_app.tender_member(tender_id,user_id,role) VALUES($1,$2,'buyer'),($1,$3,'reviewer')",
    [a.id, buyer, reviewer],
  );
  let jobs = { jobs: [], active: 0 };
  const lifecycle = new PgLifecycleRepository(pool, async (id) => {
    const actual = await ocrInventory(workspace, created.includes(id) ? [fixtureStorage] : ocrRoots, id);
    return { jobs: [...actual.jobs, ...jobs.jobs], active: actual.active + jobs.active };
  });
  const body = (p, action, extra = {}) => ({
    action,
    confirmationId: p.id,
    confirmationTitle: p.title,
    previewHash: p.previewHash,
    reason: 'Synthetic test operation',
    evidence: 'Synthetic fixture created by task009a/test-lifecycle.mjs',
    ...extra,
  });
  const act = async (id, action, who = actor) =>
    lifecycle.act(who, id, body(await lifecycle.preview(who, id), action));
  const rejected = async (work, status) => assert.rejects(work, (e) => e.getStatus?.() === status);
  assert.equal((await lifecycle.preview(actor, a.id)).classification, 'unclassified');
  await rejected(() => lifecycle.preview(outsider, a.id), 404);
  await rejected(() => act(a.id, 'archive', reviewer), 403);
  await rejected(() => act(a.id, 'trash'), 403);
  ok('visibility, reviewer and distinct trash capability checks');
  const old = await lifecycle.preview(actor, a.id);
  await rejected(
    () => lifecycle.act(actor, a.id, body(old, 'archive', { confirmationTitle: old.title + ' ' })),
    400,
  );
  await rejected(() => lifecycle.act(actor, a.id, body(old, 'archive', { confirmationId: b.id })), 400);
  await rejected(() => lifecycle.act(actor, a.id, body(old, 'archive', { reason: '          ' })), 400);
  ok('exact title, exact ID and nonblank reason required');
  const files = new FileStore(fixtureStorage, workspace);
  const binary = Buffer.from('Synthetic shared original retained across lifecycle operations ' + runId);
  const stored = await files.put(binary),
    sha = stored.sha256,
    docA = randomUUID(),
    docB = randomUUID();
  fixtureBlob = sha;
  await pool.query('INSERT INTO tender_app.blob(sha256,storage_key,byte_size) VALUES($1,$2,$3)', [
    sha,
    stored.key,
    stored.bytes,
  ]);
  for (const [doc, t] of [
    [docA, a.id],
    [docB, b.id],
  ])
    await pool.query(
      "INSERT INTO tender_app.document(id,tender_id,purpose,original_name,mime_type,blob_sha256,uploaded_by) VALUES($1,$2,'specification','synthetic.txt','text/plain',$3,$4)",
      [doc, t, sha, actor],
    );
  await rejected(() => lifecycle.act(actor, a.id, body(old, 'archive')), 409);
  assert.equal((await lifecycle.preview(actor, a.id)).sharedBlobs, 1);
  ok('new child invalidates preview; shared binary detected');
  const supplier = randomUUID(),
    lot = randomUUID(),
    pack = randomUUID(),
    offer = randomUUID(),
    version = randomUUID(),
    field = randomUUID();
  await pool.query("INSERT INTO tender_app.supplier(id,legal_name) VALUES($1,'Synthetic supplier')", [
    supplier,
  ]);
  await pool.query('INSERT INTO tender_app.tender_supplier(tender_id,supplier_id) VALUES($1,$2)', [
    a.id,
    supplier,
  ]);
  await pool.query(
    "INSERT INTO tender_app.lot(id,tender_id,name,ordinal,created_by) VALUES($1,$2,'Synthetic lot',1,$3)",
    [lot, a.id, actor],
  );
  await pool.query('INSERT INTO tender_app.offer_package(id,tender_id,supplier_id) VALUES($1,$2,$3)', [
    pack,
    a.id,
    supplier,
  ]);
  await pool.query(
    'INSERT INTO tender_app.offer(id,tender_id,supplier_id,lot_id,offer_package_id,created_by) VALUES($1,$2,$3,$4,$5,$6)',
    [offer, a.id, supplier, lot, pack, actor],
  );
  await pool.query(
    "INSERT INTO tender_app.offer_version(id,offer_package_id,version,created_by,offer_id,lot_id,tender_id,amount,currency,is_initial) VALUES($1,$2,1,$3,$4,$5,$6,250,'RUB',true)",
    [version, pack, actor, offer, lot, a.id],
  );
  await pool.query(
    "INSERT INTO tender_app.extracted_field(id,document_id,field_name,value,confidence,extractor_version,document_revision) VALUES($1,$2,'synthetic.price','250',1,'synthetic',1)",
    [field, docA],
  );
  const immutable = async () =>
    JSON.stringify({
      versions: (
        await pool.query('SELECT * FROM tender_app.offer_version WHERE tender_id=$1 ORDER BY id', [a.id])
      ).rows,
      ocr: (
        await pool.query('SELECT * FROM tender_app.extracted_field WHERE document_id=$1 ORDER BY id', [docA])
      ).rows,
      receipts: (
        await pool.query('SELECT * FROM tender_app.field_decision WHERE document_id=$1 ORDER BY id', [docA])
      ).rows,
    });
  const initialImmutable = await immutable();
  let p = await act(a.id, 'archive', buyer);
  assert.equal(p.state, 'archived');
  await rejected(() => act(a.id, 'archive'), 409);
  process.env.TENDER_LIFECYCLE_ENABLED = 'true';
  await rejected(() => scope.assertWrite(actor, a.id), 409);
  await assert.rejects(
    () => pool.query("UPDATE tender_app.document SET status='needs_review' WHERE id=$1", [docA]),
    (e) => e.code === 'LT409',
  );
  assert.equal(
    (await lifecycle.page(actor, { state: 'active', page: 1, pageSize: 25, search: '' })).total,
    1,
  );
  assert.equal(
    (await lifecycle.page(actor, { state: 'archived', page: 1, pageSize: 25, search: '' })).total,
    1,
  );
  assert.equal(
    (await tenders.list(actor)).some((t) => t.id === a.id),
    false,
  );
  assert.equal((await tenders.get(actor, a.id)).id, a.id);
  ok('archive: active list exclusion, archived filter, original readable, writes denied');
  p = await act(a.id, 'restore');
  assert.equal(p.state, 'active');
  await rejected(() => act(a.id, 'restore'), 409);
  ok('restore archived tender; repeated restore rejected');
  for (const cap of ['trash_synthetic', 'classify_synthetic'])
    await pool.query(
      'INSERT INTO tender_app.tender_capability(tender_id,user_id,capability) VALUES($1,$2,$3)',
      [a.id, actor, cap],
    );
  await rejected(() => act(a.id, 'trash'), 409);
  p = await act(a.id, 'classify_synthetic');
  assert.equal(p.classification, 'synthetic');
  assert.equal(p.allowed.trash, true);
  jobs = {
    jobs: [{ id: 'changed-review', status: 'needs_review', sha256: 'c'.repeat(64), path: 'synthetic' }],
    active: 0,
  };
  assert.equal((await lifecycle.preview(actor, a.id)).allowed.trash, false);
  jobs = { jobs: [], active: 0 };
  ok('completed OCR/review changes require reclassification independently of SQL counters');
  await pool.query("UPDATE tender_app.document SET status='needs_review' WHERE id=$1", [docA]);
  assert.equal((await lifecycle.preview(actor, a.id)).allowed.trash, false);
  await rejected(() => act(a.id, 'trash'), 409);
  await act(a.id, 'classify_synthetic');
  await pool.query('UPDATE tender_app.tender SET title=title WHERE id=$1', [a.id]);
  p = await act(a.id, 'trash');
  assert.equal(p.state, 'trash');
  await assert.rejects(
    () => pool.query("UPDATE tender_app.tender SET title='changed' WHERE id=$1", [a.id]),
    (e) => e.code === 'LT409',
  );
  assert.equal(
    (await lifecycle.page(actor, { state: 'trash', page: 1, pageSize: 1, search: 'A' })).items[0].id,
    a.id,
  );
  assert.equal(
    (await pool.query('SELECT count(*) FROM tender_app.document WHERE blob_sha256=$1', [sha])).rows[0].count,
    '2',
  );
  assert.equal(
    (await pool.query('SELECT count(*) FROM tender_app.blob WHERE sha256=$1', [sha])).rows[0].count,
    '1',
  );
  await act(a.id, 'restore');
  assert.equal(await immutable(), initialImmutable);
  assert.deepEqual(await files.get(stored.key), binary);
  ok('initial price/version, OCR fields and original binary unchanged after archive/trash/restore');
  ok('classification, content-change invalidation, reversible trash; shared blob/documents retained');
  await act(a.id, 'classify_working');
  await rejected(() => act(a.id, 'trash'), 409);
  await rejected(() => act(a.id, 'classify_synthetic'), 409);
  ok('working classification protected from trash and synthetic reclassification');
  const pre = await lifecycle.preview(actor, b.id);
  jobs = {
    jobs: [{ id: 'synthetic-job', status: 'pending', sha256: 'b'.repeat(64), path: 'synthetic' }],
    active: 1,
  };
  await rejected(() => lifecycle.act(actor, b.id, body(pre, 'archive')), 409);
  await rejected(() => act(b.id, 'archive'), 409);
  jobs = { jobs: [], active: 0 };
  const run = randomUUID();
  await pool.query(
    "INSERT INTO tender_app.extraction_run(id,document_id,model_tag,prompt_version,parser_version,status) VALUES($1,$2,'synthetic','synthetic','synthetic','queued')",
    [run, docB],
  );
  await rejected(() => act(b.id, 'archive'), 409);
  await pool.query("UPDATE tender_app.extraction_run SET status='completed' WHERE id=$1", [run]);
  ok('filesystem and SQL OCR jobs block archive/trash; changed OCR invalidates preview');

  for (const id of protectedTenders) {
    const owner = (await pool.query('SELECT owner_id FROM tender_app.tender WHERE id=$1', [id])).rows[0];
    assert.ok(owner);
    const preview = await lifecycle.preview(owner.owner_id, id);
    assert.equal(preview.held, true);
    await rejected(() => lifecycle.act(owner.owner_id, id, body(preview, 'archive')), 409);
  }
  ok('all eight existing protected tenders refused without modifying any existing rows');
  for (let i = 0; i < 4; i++) created.push((await tenders.create(actor, 'Synthetic pagination ' + i)).id);
  // Controlled concurrent child commit while an earlier preview exists.
  const stale = await lifecycle.preview(actor, b.id),
    c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("UPDATE tender_app.document SET status='needs_review' WHERE id=$1", [docB]);
    let settled = false;
    const concurrent = lifecycle.act(actor, b.id, body(stale, 'archive')).then(
      () => {
        settled = true;
        return null;
      },
      (e) => {
        settled = true;
        return e;
      },
    );
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(settled, false);
    await c.query('COMMIT');
    assert.equal((await concurrent).getStatus(), 409);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
  ok('concurrent child write serializes on parent and causes stale-preview conflict');
  const frozen = await lifecycle.preview(actor, b.id);
  await pool.query(
    "INSERT INTO tender_app.audit_event(id,actor_id,tender_id,action) VALUES($1,$2,$3,'synthetic concurrent audit')",
    [randomUUID(), actor, b.id],
  );
  await rejected(() => lifecycle.act(actor, b.id, body(frozen, 'archive')), 409);
  ok('audit additions also invalidate preview');
  const fsPreview = await lifecycle.preview(actor, b.id);
  let entered, finish;
  const enteredPromise = new Promise((r) => {
      entered = r;
    }),
    finishPromise = new Promise((r) => {
      finish = r;
    });
  const writing = scope.activeFence(b.id, async () => {
    entered();
    await finishPromise;
  });
  await enteredPromise;
  const transition = lifecycle.act(actor, b.id, body(fsPreview, 'archive')).then(
    () => null,
    (e) => e,
  );
  finish();
  await writing;
  assert.equal((await transition).getStatus(), 409);
  await act(b.id, 'archive');
  delete process.env.TENDER_LIFECYCLE_ENABLED;
  let callbackCalled = false;
  await rejected(
    () =>
      scope.activeFence(b.id, async () => {
        callbackCalled = true;
      }),
    409,
  );
  assert.equal(callbackCalled, false);
  await act(b.id, 'restore');
  ok(
    'OCR filesystem fence serializes with lifecycle, invalidates preview and rejects writes to archived tenders',
  );
  const pg1 = await lifecycle.page(actor, { state: 'active', page: 1, pageSize: 3, search: 'Synthetic' }),
    pg2 = await lifecycle.page(actor, { state: 'active', page: 2, pageSize: 3, search: 'Synthetic' });
  assert.equal(pg1.items.length, 3);
  assert.equal(pg2.items.length, 3);
  assert.ok(pg1.items.every((t) => !pg2.items.some((u) => u.id === t.id)));
  assert.equal(
    (await lifecycle.page(outsider, { state: 'active', page: 1, pageSize: 25, search: '' })).total,
    0,
  );
  ok('stable server pagination, search, ACL totals');
  const token = 'synthetic-test-token-task009a-123456';
  app = await createApplication({
    logger: false,
    environment: 'test',
    data: {
      enabled: true,
      token,
      actorId: actor,
      repository: tenders,
      scopeRepository: scope,
      offerRepository: new PgOfferRepository(pool),
      verificationRepository: new PgVerificationRepository(pool),
      stageRepository: new PgStageRepository(pool),
      extractionRepository: new TzExtractionRepository(pool),
      aiRepository: new PgAIRepository(pool, {
        enabled: false,
        storageRoot: fixtureStorage,
        jobRoot: fixtureStorage,
        workspace,
        syntheticHashes: [],
      }),
      lifecycleEnabled: true,
      lifecycleRepository: lifecycle,
    },
  });
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onRequest', async (req, reply) => {
      if (!['GET', 'HEAD'].includes(req.method)) {
        const match = req.url.match(/^\/api\/tenders\/([a-f0-9-]{36})\/lifecycle$/);
        if (!match || !created.includes(match[1]))
          await reply.code(403).send({ message: 'Only new synthetic fixture writes permitted' });
      }
    });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const headers = { authorization: `Bearer ${token}` };
  assert.equal(
    (await app.inject({ method: 'GET', url: '/api/tenders/lifecycle/page', headers })).statusCode,
    200,
  );
  for (const query of ['page=0', 'pageSize=101', 'state=bad', 'page=1.2', 'unknown=true'])
    assert.equal(
      (await app.inject({ method: 'GET', url: '/api/tenders/lifecycle/page?' + query, headers })).statusCode,
      400,
    );
  assert.equal((await app.inject({ method: 'GET', url: '/api/tenders/lifecycle/page' })).statusCode, 401);
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: `/api/tenders/${b.id}/lifecycle`,
        headers,
        payload: { ...body(await lifecycle.preview(actor, b.id), 'archive'), extra: true },
      })
    ).statusCode,
    400,
  );
  ok('real HTTP routes, authentication, whitelist, pagination DTO validation');

  // Listen on an OS-selected loopback port: actual HTTP, distinct from the source portal.
  await app.listen(0, '127.0.0.1');
  httpPort = app.getHttpServer().address().port;
  const http = async (method, path, payload, auth = true) => {
    const r = await fetch('http://127.0.0.1:' + httpPort + '/api' + path, {
      method,
      headers: { ...(auth ? headers : {}), ...(payload ? { 'content-type': 'application/json' } : {}) },
      body: payload ? JSON.stringify(payload) : undefined,
    });
    return { status: r.status, value: await r.json() };
  };
  const hp = async () => {
    const r = await http('GET', '/tenders/' + b.id + '/lifecycle');
    assert.equal(r.status, 200);
    return r.value;
  };
  const ha = async (action, extra = {}) =>
    http('POST', '/tenders/' + b.id + '/lifecycle', body(await hp(), action, extra));
  assert.equal((await http('GET', '/tenders/lifecycle/page', undefined, false)).status, 401);
  assert.equal((await ha('archive', { confirmationTitle: 'wrong title' })).status, 400);
  assert.equal((await ha('archive', { confirmationId: a.id })).status, 400);
  assert.equal((await ha('classify_synthetic')).status, 403);
  assert.equal((await ha('trash')).status, 403);
  const staleHttp = await hp();
  assert.equal((await ha('archive')).value.state, 'archived');
  assert.equal(
    (await http('POST', '/tenders/' + b.id + '/lifecycle', body(staleHttp, 'archive'))).status,
    409,
  );
  assert.equal(
    (await http('GET', '/tenders/lifecycle/page?state=archived&page=1&pageSize=1')).value.items[0].id,
    b.id,
  );
  assert.equal((await ha('restore')).value.state, 'active');
  for (const cap of ['classify_synthetic', 'trash_synthetic'])
    await pool.query(
      'INSERT INTO tender_app.tender_capability(tender_id,user_id,capability) VALUES($1,$2,$3)',
      [b.id, actor, cap],
    );
  assert.equal((await ha('classify_synthetic')).value.classification, 'synthetic');
  assert.equal((await ha('trash')).value.state, 'trash');
  assert.equal((await http('GET', '/tenders/lifecycle/page?state=trash')).value.items[0].id, b.id);
  assert.equal((await ha('restore')).value.state, 'active');
  ok(
    'loopback HTTP: authentication, exact confirmation, capability denials, stale preview, archive/restore/classify/trash/restore and filters',
  );
  // Filesystem jobs are fabricated metadata; no worker or OCR model is invoked.
  const job = {
    id: createHash('sha256').update(runId).digest('hex'),
    tenderId: b.id,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  await jobStore.write(job);
  for (const action of ['archive', 'trash', 'classify_synthetic'])
    assert.equal((await ha(action)).status, 409);
  await jobStore.write({ ...job, status: 'running' });
  assert.equal((await ha('archive')).status, 409);
  await jobStore.write({ ...job, status: 'needs_review' });
  assert.equal((await hp()).allowed.trash, false);
  await ha('classify_synthetic');
  ok(
    'actual cloned filesystem inventory: pending/running block changes; completed draft changes classification hash; no OCR executed',
  );
  // Two concurrent requests based on the same preview: exactly one commit.
  const parallelPreview = await hp();
  const parallel = await Promise.all(
    [0, 1].map(() => http('POST', '/tenders/' + b.id + '/lifecycle', body(parallelPreview, 'archive'))),
  );
  assert.deepEqual(parallel.map((r) => r.status).sort(), [201, 409]);
  await ha('restore');
  ok('two simultaneous HTTP transitions: one 201, one 409; no duplicate lifecycle event');
  // Test actual CHECK constraints using new fixture rows and rollback, never DELETE.
  for (const field of [
    'evidence',
    'classified_ocr_hash',
    'classified_by',
    'classified_at',
    'classified_content_revision',
  ]) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const values = {
        evidence: 'Synthetic evidence adequate',
        classified_ocr_hash: 'a'.repeat(64),
        classified_by: actor,
        classified_at: new Date(),
        classified_content_revision: 0,
      };
      values[field] = null;
      await assert.rejects(
        () =>
          c.query(
            'INSERT INTO tender_app.tender_lifecycle(tender_id,classification,evidence,classified_ocr_hash,classified_by,classified_at,classified_content_revision) VALUES($1,$2,$3,$4,$5,$6,$7)',
            [
              created[2],
              'synthetic',
              values.evidence,
              values.classified_ocr_hash,
              values.classified_by,
              values.classified_at,
              values.classified_content_revision,
            ],
          ),
        (e) => e.code === '23514',
      );
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  }
  ok(
    'actual PostgreSQL CHECK rejects NULL evidence/hash/actor/time/content revision; transactions rolled back',
  );
  const ev = await pool.query('SELECT * FROM tender_app.lifecycle_event WHERE tender_id=ANY($1::uuid[])', [
    created,
  ]);
  assert.ok(ev.rows.length > 10);
  for (const e of ev.rows) {
    assert.ok(e.actor_id);
    assert.ok(e.before_state);
    assert.ok(e.after_state);
    assert.equal(e.preview_hash.trim().length, 64);
    assert.ok(e.reason.trim().length >= 10);
  }
  const beforeEvents = ev.rowCount;
  await assert.rejects(() =>
    pool.query('UPDATE tender_app.lifecycle_event SET reason=reason WHERE id=$1', [ev.rows[0].id]),
  );
  assert.equal(
    (
      await pool.query('SELECT count(*) FROM tender_app.lifecycle_event WHERE tender_id=ANY($1::uuid[])', [
        created,
      ])
    ).rows[0].count,
    String(beforeEvents),
  );
  assert.equal(await immutable(), initialImmutable);
  assert.deepEqual(await files.get(stored.key), binary);
  ok(
    'lifecycle events contain actor/before/after/reason/hash; update refused; original synthetic price/version/OCR/shared binary unchanged',
  );
  const tableNames = (
    await pool.query(
      "SELECT table_name FROM information_schema.columns WHERE table_schema='tender_app' AND column_name='tender_id'",
    )
  ).rows;
  for (const { table_name } of tableNames)
    assert.equal(
      (
        await pool.query(
          "SELECT count(*) FROM pg_trigger WHERE tgrelid=$1::regclass AND tgname='lifecycle_guard'",
          ['tender_app.' + table_name],
        )
      ).rows[0].count,
      '1',
    );
  assert.ok(Number((await pool.query('SELECT count(*) FROM tender_app.lifecycle_event')).rows[0].count) > 5);
  ok('all direct tenant dependencies guarded; immutable lifecycle audit retained');
  const report = {
    at: new Date().toISOString(),
    database: db,
    approvedRestoredCopyOnly: true,
    fixtureIds: created,
    fixtureStorage,
    fixtureBlob,
    blockedSourceConnections,
    blockedEgress,
    ocrEnabled: false,
    migrationHashes: hashes,
    results,
    workspace,
  };
  await json(resolve(out, 'test-results.json'), report);
  console.log('New synthetic fixtures retained in restored copy: ' + created.length);
} finally {
  await app?.close();
  await pool.end();
}
