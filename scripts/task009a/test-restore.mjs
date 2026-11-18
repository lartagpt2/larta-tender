// TASK-009C: only a fresh disposable DB; no access to the running portal.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { resolve, relative } from 'node:path';
import { readFile, readdir, lstat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import pg from 'pg';
import { createDisposableDatabase } from '../testing/disposable-database.mjs';
import { workspace, json, checked } from '../task008-gate-d/io.mjs';

async function state(client) {
  const tables = (
    await client.query(
      "SELECT relname FROM pg_class WHERE relnamespace='tender_app'::regnamespace AND relkind='r' ORDER BY relname",
    )
  ).rows;
  const fingerprints = {};
  for (const { relname } of tables) {
    assert.match(relname, /^[a-z_]+$/);
    const values = (await client.query(`SELECT to_jsonb(t)::text value FROM tender_app.${relname} t`)).rows
      .map((x) => x.value)
      .sort();
    fingerprints[relname] = {
      count: values.length,
      sha256: createHash('sha256').update(JSON.stringify(values)).digest('hex'),
    };
  }
  return { fingerprints };
}
async function inventory(roots) {
  const out = [];
  async function walk(path) {
    await checked(path);
    const s = await lstat(path),
      name = relative(workspace, path).replaceAll('\\', '/');
    if (s.isDirectory()) {
      out.push({ path: name, type: 'directory' });
      for (const n of await readdir(path)) await walk(resolve(path, n));
    } else {
      assert.ok(s.isFile());
      out.push({
        path: name,
        type: 'file',
        bytes: s.size,
        sha256: createHash('sha256')
          .update(await readFile(path))
          .digest('hex'),
      });
    }
  }
  for (const root of roots) await walk(root);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

if (!process.argv.includes('--run')) {
  console.log('--run creates a new disposable DB; no cleanup or existing DB migrations');
  process.exit(0);
}
const require = createRequire(import.meta.url);
const { createApplication } = require('../../apps/api/dist/application.js');
const { PgTenderRepository } = require('../../apps/api/dist/data/repository.js');
const { PgScopeRepository } = require('../../apps/api/dist/data/scope-repository.js');
const { PgOfferRepository } = require('../../apps/api/dist/data/offer-repository.js');
const {
  PgLifecycleRepository,
  protectedTenders,
} = require('../../apps/api/dist/lifecycle/lifecycle-repository.js');
const { FileStore } = require('../../apps/api/dist/storage/file-store.js');
const run = await createDisposableDatabase('task009c-http-restore');
const pool = run.pool,
  results = [],
  apps = [];
process.env.PGHOST = '127.0.0.1';
process.env.PGPORT = '5432';
process.env.PGDATABASE = run.database;
process.env.STORAGE_ROOT = run.storageRoot;
process.env.DOCUMENT_AI_ENABLED = 'false';
process.env.TENDER_LIFECYCLE_ENABLED = 'true';
const originalConnect = pg.Client.prototype.connect;
pg.Client.prototype.connect = function (...args) {
  assert.equal(this.connectionParameters.database, run.database, 'Only this new DB');
  return originalConnect.apply(this, args);
};
let fatal,
  heldId,
  cyclePassed = false;
const check = (name, passed, detail = {}) => {
  results.push({ name, passed, ...detail });
  console.log((passed ? 'PASS ' : 'FAIL ') + name);
};
const sha = (b) => createHash('sha256').update(b).digest('hex');
try {
  assert.equal((await pool.query('SELECT current_database() db')).rows[0].db, run.database);
  const actor = randomUUID(),
    reviewer = randomUUID(),
    outsider = randomUUID();
  for (const id of [actor, reviewer, outsider])
    await pool.query(
      "INSERT INTO tender_app.app_user(id,external_subject,display_name) VALUES($1,$2,'Synthetic TASK009C')",
      [id, 'task009c-' + id],
    );
  const tenders = new PgTenderRepository(pool),
    scope = new PgScopeRepository(pool),
    offers = new PgOfferRepository(pool);
  const tender = await tenders.create(actor, 'Synthetic TASK009C HTTP restore');
  await pool.query("INSERT INTO tender_app.tender_member(tender_id,user_id,role) VALUES($1,$2,'reviewer')", [
    tender.id,
    reviewer,
  ]);
  let jobs = { jobs: [], active: 0 };
  let ocrReads=0;
  const {ocrInventory}=require('../../apps/api/dist/lifecycle/ocr-inventory.js');
  const lifecycle = new PgLifecycleRepository(pool, async (id) => {ocrReads++;const fs=await ocrInventory(workspace,[run.storageRoot],id);return {jobs:[...jobs.jobs,...fs.jobs],active:jobs.active+fs.active};});
  const token = 'synthetic-task009c-only-token-123456789';
  async function appFor(actorId) {
    const app = await createApplication({
      logger: false,
      environment: 'test',
      data: {
        enabled: true,
        token,
        actorId,
        repository: tenders,
        scopeRepository: scope,
        offerRepository: offers,
        lifecycleEnabled: true,
        lifecycleRepository: lifecycle,
      },
    });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    apps.push(app);
    return app;
  }
  const app = await appFor(actor),
    readApp = await appFor(reviewer),
    outApp = await appFor(outsider);
  const headers = { authorization: 'Bearer ' + token },
    url = '/api/tenders/' + tender.id;
  async function request(method, path, payload, target = app, status = 200) {
    const r = await target.inject({ method, url: path, headers, ...(payload ? { payload } : {}) });
    assert.equal(r.statusCode, status, method + ' ' + path);
    return r;
  }
  async function preview(target = app) {
    return (await request('GET', url + '/lifecycle', undefined, target)).json();
  }
  const payload = (p, action) => ({
    action,
    confirmationId: tender.id,
    confirmationTitle: tender.title,
    previewHash: p.previewHash,
    reason: 'Synthetic TASK009C isolated restore verification',
  });
  async function transition(action) {
    const p = await preview();
    return (await request('POST', url + '/lifecycle', payload(p, action), app, 201)).json();
  }
  const store = new FileStore(run.storageRoot, workspace),
    spec = randomUUID(),
    doc = randomUUID();
  const originals = [];
  for (const [id, purpose, text] of [
    [spec, 'specification', 'Synthetic TASK009C specification: two units'],
    [doc, 'offer', 'Synthetic TASK009C offer: 250 RUB'],
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
    "INSERT INTO tender_app.supplier(id,legal_name) VALUES($1,'Synthetic TASK009C supplier')",
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
  const client = await pool.connect();
  async function capture() {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      return {
        state: await state(client),
        tenders: (await client.query('SELECT to_jsonb(t) row FROM tender_app.tender t ORDER BY id')).rows.map(
          (x) => x.row,
        ),
        audits: (
          await client.query('SELECT to_jsonb(t) row FROM tender_app.audit_event t ORDER BY id')
        ).rows.map((x) => x.row),
        files: await inventory([run.storageRoot]),
      };
    } finally {
      await client.query('ROLLBACK');
    }
  }
  try {
    const before = await capture();
    await json(resolve(run.runRoot, 'cycle-before.json'), before);
    async function visible(stateName, expected) {
      const p = (await request('GET', '/api/tenders/lifecycle/page?state=' + stateName)).json();
      assert.equal(
        p.items.some((t) => t.id === tender.id),
        expected,
      );
    }
    await visible('active', true);
    await visible('archived', false);
    await transition('archive');
    await visible('active', false);
    await visible('archived', true);
    for (const o of originals) {
      const route = o.purpose === 'specification' ? '/tz/' : '/offers/';
      assert.equal(sha((await request('GET', url + route + o.id + '/original')).rawPayload), o.sha256);
    }
    await transition('restore');
    await visible('active', true);
    await visible('archived', false);
    const after = await capture();
    await json(resolve(run.runRoot, 'cycle-after.json'), after);
    const expectedChanges = new Set(['tender', 'tender_lifecycle', 'lifecycle_event', 'audit_event']);
    for (const [table, fingerprint] of Object.entries(before.state.fingerprints))
      if (!expectedChanges.has(table)) assert.deepEqual(after.state.fingerprints[table], fingerprint, table);
    // INSERT archive: +3; restore UPSERT invokes BEFORE INSERT and BEFORE UPDATE: +4.
    const expectedTender = structuredClone(before.tenders[0]);
    expectedTender.dependency_revision += 7;
    assert.deepEqual(after.tenders, [expectedTender]);
    for (const a of before.audits)
      assert.deepEqual(
        after.audits.find((x) => x.id === a.id),
        a,
      );
    assert.equal(after.audits.length, before.audits.length + 2);
    assert.deepEqual(after.files, before.files);
    for (const o of originals) {
      const route = o.purpose === 'specification' ? '/tz/' : '/offers/';
      assert.equal(sha((await request('GET', url + route + o.id + '/original')).rawPayload), o.sha256);
    }
    cyclePassed = true;
    check('HTTP Active -> Archive -> Active; originals downloadable in archive and after restore', true);
    check(
      'All business fingerprints preserved; two documents/files, two price versions, OCR, decisions, receipts and cost component unchanged; no duplicates',
      true,
      { counts: Object.fromEntries(Object.entries(after.state.fingerprints).map(([k, v]) => [k, v.count])) },
    );
  } finally {
    client.release();
  }
  await transition('archive');
  const rp = await preview(readApp);
  await request('POST', url + '/lifecycle', payload(rp, 'restore'), readApp, 403);
  await request('GET', url + '/lifecycle', undefined, outApp, 404);
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: url + '/lifecycle',
        payload: payload(await preview(), 'restore'),
      })
    ).statusCode,
    401,
  );
  check(
    'Reviewer cannot restore (403), outsider preview denied (404), unauthenticated restore denied (401)',
    true,
  );
  const stale = await preview();
  await pool.query(
    "INSERT INTO tender_app.audit_event(id,actor_id,tender_id,action) VALUES($1,$2,$3,'synthetic stale preview probe')",
    [randomUUID(), actor, tender.id],
  );
  await request('POST', url + '/lifecycle', payload(stale, 'restore'), app, 409);
  assert.equal((await preview()).state, 'archived');
  check('Stale restore previewHash rejected (409); archived state preserved', true);
  heldId = tender.id;
  protectedTenders.add(heldId);
  try {
    const held = await preview();
    assert.equal(held.held, true);
    assert.equal(held.allowed.restore, false);
    await request('POST', url + '/lifecycle', payload(held, 'restore'), app, 409);
  } finally {
    protectedTenders.delete(heldId);
    heldId = undefined;
  }
  check('Held restore rejected (409), using isolated in-memory hold simulation', true);
  jobs = {
    jobs: [{ id: 'b'.repeat(64), status: 'running', sha256: 'c'.repeat(64), path: 'synthetic-test-only' }],
    active: 1,
  };
  const busy = await preview();
  assert.equal(busy.busy, true);
  const response = await app.inject({
    method: 'POST',
    url: url + '/lifecycle',
    headers,
    payload: payload(busy, 'restore'),
  });
  const actualState = (await preview()).state;
  check(
    'Restore blocked while OCR job is active',
    response.statusCode === 409 && actualState === 'archived',
    {
      expectedStatus: 409,
      actualStatus: response.statusCode,
      busy: busy.busy,
      allowedRestore: busy.allowed.restore,
      actualState,
    },
  );
  jobs = { jobs: [], active: 0 };
  const additional=[];
  async function rejectBusy(label, stalePreview) {
    const fresh=await preview();assert.equal(fresh.busy,true);assert.equal(fresh.allowed.restore,false);
    const beforeClient=await pool.connect();let before;try{before=await state(beforeClient);}finally{beforeClient.release();}
    const beforeFiles=await inventory([run.storageRoot]);const reads=ocrReads;
    const res=await app.inject({method:'POST',url:url+'/lifecycle',headers,payload:payload(stalePreview??fresh,'restore')});
    assert.equal(res.statusCode,409);assert.ok(ocrReads>reads,'POST did not recompute snapshot');
    const afterClient=await pool.connect();try{assert.deepEqual(await state(afterClient),before);}finally{afterClient.release();}
    assert.deepEqual(await inventory([run.storageRoot]),beforeFiles);assert.equal((await preview()).state,'archived');
    additional.push({name:label,status:'PASS',httpStatus:res.statusCode,dbActive:fresh.dbActive,fileActive:fresh.ocr.active,postRecomputedSnapshot:true,all35TablesAndFilesUnchanged:true});console.log('PASS regression '+label);
  }
  for(const status of ['queued','processing']) {
    const id=randomUUID();const setup=await pool.connect();
    try {await setup.query('BEGIN');await setup.query("UPDATE tender_app.tender_lifecycle SET state='active' WHERE tender_id=$1",[tender.id]);await setup.query("INSERT INTO tender_app.extraction_run(id,document_id,model_tag,prompt_version,parser_version,status) VALUES($1,$2,'synthetic-009d','synthetic','synthetic',$3)",[id,spec,status]);await setup.query("UPDATE tender_app.tender_lifecycle SET state='archived' WHERE tender_id=$1",[tender.id]);await setup.query('COMMIT');}catch(e){await setup.query('ROLLBACK');throw e;}finally{setup.release();}
    await rejectBusy('SQL '+status);
    const cleanup=await pool.connect();try{await cleanup.query('BEGIN');await cleanup.query("UPDATE tender_app.tender_lifecycle SET state='active' WHERE tender_id=$1",[tender.id]);await cleanup.query("UPDATE tender_app.extraction_run SET status='completed' WHERE id=$1",[id]);await cleanup.query("UPDATE tender_app.tender_lifecycle SET state='archived' WHERE tender_id=$1",[tender.id]);await cleanup.query('COMMIT');}catch(e){await cleanup.query('ROLLBACK');throw e;}finally{cleanup.release();}
  }
  for(const status of ['pending','running']) {
    const calm=await preview();assert.equal(calm.busy,false);
    const id=sha(Buffer.from('TASK009D-'+status)),path=resolve(run.storageRoot,'document-ai',id+'.json');
    const job={id,tenderId:tender.id,documentId:spec,sourceSha:originals[0].sha256,status};
    await json(path,job);await rejectBusy('file '+status);await rejectBusy('POST rechecks newly '+status+' job after calm GET',calm);
    await json(path,{...job,status:'needs_review'});
  }
  assert.equal((await preview()).busy,false);
  await json(resolve(run.runRoot,'regression-results.json'),{at:new Date().toISOString(),database:run.database,results:additional,status:'PASS',sqlSetup:'Only new fixture: active -> insert queued/processing -> archived via SQL; no disabled constraints or triggers'});
  if (actualState === 'archived') await transition('restore');
  const repeated = await app.inject({
    method: 'POST',
    url: url + '/lifecycle',
    headers,
    payload: payload(await preview(), 'restore'),
  });
  assert.equal(repeated.statusCode, 409);
  check('Repeated restore of active fixture rejected (409)', true);
  await json(resolve(run.runRoot, 'http-results.json'), {
    at: new Date().toISOString(),
    database: run.database,
    runId: run.runId,
    tenderId: tender.id,
    originalFiles: originals,
    cyclePassed,
    results,
    status: results.every((x) => x.passed) ? 'PASS' : 'FAIL',
    transport:
      'Nest/Fastify app.inject: real routes, DTO, auth, repository and PostgreSQL; no listening port',
    physicalCleanup: false,
  });
} catch (e) {
  fatal = { code: e.code, message: e.message, constraint: e.constraint };
  await json(resolve(run.runRoot, 'http-error.json'), {
    at: new Date().toISOString(),
    fatal,
    cyclePassed,
    results,
  });
} finally {
  if (heldId) protectedTenders.delete(heldId);
  for (const app of apps) await app.close();
  await run.close(!fatal && results.every((x) => x.passed) ? 'PASSED_RETAINED' : 'FAILED_RETAINED');
  pg.Client.prototype.connect = originalConnect;
}
console.log(
  JSON.stringify({
    database: run.database,
    runId: run.runId,
    runRoot: run.runRoot,
    cyclePassed,
    fatal,
    passed: results.filter((x) => x.passed).length,
    failed: results.filter((x) => !x.passed).length,
  }),
);
if (fatal || results.some((x) => !x.passed)) process.exitCode = 1;
