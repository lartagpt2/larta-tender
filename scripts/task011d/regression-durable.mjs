import { acceptRegressionPolicy, regressionMemoryPolicy } from './regression-policy.mjs';
import { verifyIdentity } from '../testing/isolated-run.mjs';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { ForbiddenException } from '@nestjs/common';
import { randomUUID, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import pg from 'pg';
import { isolatedRun } from '../testing/isolated-run.mjs';
import { json, checked, workspace } from '../task008-gate-d/io.mjs';
import application from '../../apps/api/dist/application.js';
import tenders from '../../apps/api/dist/data/repository.js';
import intake from '../../apps/api/dist/unified-intake/intake-repository.js';
import queues from '../../apps/api/dist/unified-intake/processing-queue.js';
import workers from '../../apps/api/dist/unified-intake/intake-worker.js';
import classification from '../../apps/api/dist/unified-intake/classification.js';
import stores from '../../apps/api/dist/storage/file-store.js';
import lifecycle from '../../apps/api/dist/lifecycle/lifecycle-repository.js';
import { tenFiles, txt, asPdf, seller, inn, mail, sha, multipart } from './fixtures.mjs';
if (!process.argv.includes('--run')) {
  console.log('Preview only; --run creates a NEW retained UUID DB');
  process.exit(0);
}
process.env.NODE_ENV = 'test';
const connections = [],
  originalConnect = pg.Client.prototype.connect;
pg.Client.prototype.connect = function (...args) {
  connections.push(this.connectionParameters.database);
  assert.notEqual(this.connectionParameters.database, 'larta_test_task003');
  return originalConnect.apply(this, args);
};
const run = await isolatedRun('task011d-integration'),
  pool = run.pool,
  results = [],
  apps = [],
  children = [];
let passed = false,
  phase = 'setup',
  configIndex = 0;
const actor = randomUUID(),
  reviewer = randomUUID(),
  token = randomBytes(32).toString('hex'),
  auth = { authorization: 'Bearer ' + token };
const timing = { leaseMs: 900, heartbeatMs: 100, pollMs: 30, backoffMs: [80, 140, 220], concurrency: 1 };
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const until = async (predicate, label, timeout = 30000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await predicate();
    if (result) return result;
    await wait(40);
  }
  throw Error('timeout ' + label);
};
const ok = (name) => {
  results.push({ name, status: 'PASS' });
  console.log('PASS ' + name);
};
const count = async (table, tender) =>
  Number(
    (
      await pool.query(
        'SELECT count(*) n FROM tender_app.' + table + (tender ? ' WHERE tender_id=$1' : ''),
        tender ? [tender] : [],
      )
    ).rows[0].n,
  );
const policyFile = await checked(resolve(run.runRoot, 'synthetic-policy.json'));
const acceptedPolicyBytes = await readFile(
  resolve(
    workspace,
    '../task011d-74959e1f-318b-4d56-a158-08304a26b7c6/temp/integration-runs/010eeff4-5d2a-4261-ae55-56d55c907e8b/synthetic-policy.json',
  ),
);
const digest = (b) => createHash('sha256').update(b).digest('hex');
assert.equal(digest(acceptedPolicyBytes), '74dffd227d0232b9e60afdcdb09e0f01461d02a9d72f043df480377a174b5a3e');
const fixtureEntries = [],
  memoryState = {};
let allowed = [];
async function allow(files, mode = 'synthetic', originalLine) {
  assert.equal(process.env.NODE_ENV, 'test');
  await verifyIdentity(pool, run.identity);
  assert.ok(Number.isInteger(originalLine));
  for (const f of files)
    fixtureEntries.push({
      name: f.name,
      bytes: f.content.length,
      sha256: sha(f.content),
      generator: 'scripts/task011d/integration.mjs',
      generatorLine: originalLine,
      generatorSha256: '278adbe8354e7dc4e5cc4b4a5ffbf27c0352b33ef4cb2defb7f9e435e2525bd2',
      purpose: 'original D assertion group ' + phase,
      expected:
        f.name === 'broken.pdf'
          ? 'failed/document_parse_failed'
          : 'original D assertions; completed unless explicit fault injection',
      category: f.name === 'broken.pdf' ? 'negative_parser' : 'positive',
      policyGrant: true,
    });
  allowed = [...new Set([...allowed, ...files.map((f) => sha(f.content))])];
  const manifestPath = resolve(run.runRoot, 'regression-only-D-manifest.json');
  await json(manifestPath, {
    regressionOnly: true,
    testSet: 'TASK-011D',
    activated: false,
    runId: run.identity.runId,
    fixtures: fixtureEntries,
  });
  const next = {
    runId: run.identity.runId,
    manifestPath,
    manifestSha256: digest(await readFile(manifestPath)),
    config: { mode, enabled: true, sha256: allowed },
  };
  await acceptRegressionPolicy(pool, run.identity, next);
  Object.assign(memoryState, next);
  for (const child of children.filter(
    (c) => c.proc.connected && c.proc.exitCode === null && c.proc.signalCode === null,
  )) {
    const nonce = randomUUID();
    child.proc.send({ type: 'task011d-regression-policy', nonce, state: next });
    await until(() => child.messages.some((m) => m.policyAck === nonce), 'test policy IPC acknowledgment');
  }
}
async function child(extra = {}, script = 'scripts/task011d/regression-worker.mjs') {
  const file = await checked(resolve(run.runRoot, 'runtime-' + ++configIndex + '.json'));
  await json(file, {
    identity: run.identity,
    storageRoot: run.storageRoot,
    workspace,
    policyFile,
    regressionOnly: true,
    timing,
    actorId: actor,
    ...extra,
  });
  const proc = spawn(process.execPath, [resolve(script), file], {
    cwd: process.cwd(),
    env: { ...process.env, DEV_API_TOKEN: token, TASK011D_REGRESSION_CONFIG: JSON.stringify(memoryState) },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const item = { proc, messages: [], output: '' };
  children.push(item);
  proc.stdout.on('data', (b) => {
    item.output += b.toString().slice(0, 2000);
  });
  proc.stderr.on('data', (b) => {
    item.output += b.toString().slice(0, 2000);
  });
  proc.on('message', (m) => item.messages.push(m));
  await until(
    () =>
      item.messages.find((m) => m.ready) ||
      (proc.exitCode !== null && Promise.reject(Error('child exited ' + item.output))),
    'worker ready',
  );
  return item;
}
async function kill(item) {
  if (item.proc.exitCode === null && item.proc.signalCode === null) {
    const ended = once(item.proc, 'exit');
    if (item.proc.kill('SIGKILL')) await ended;
  }
}
try {
  await allow([], 'synthetic', 115);
  for (const id of [actor, reviewer])
    await pool.query(
      "INSERT INTO tender_app.app_user(id,external_subject,display_name) VALUES($1,$2,'Synthetic D tester')",
      [id, 'synthetic:' + id],
    );
  const policy = await regressionMemoryPolicy(pool, run.identity, memoryState),
    repo = new intake.PgIntakeRepository(pool, undefined, policy),
    life = new lifecycle.PgLifecycleRepository(pool, async () => ({ jobs: [], active: 0 }));
  async function appFor(actorId = actor) {
    const app = await application.createApplication({
      logger: false,
      environment: 'test',
      data: {
        enabled: true,
        token,
        actorId,
        repository: new tenders.PgTenderRepository(pool),
        intakeRepository: repo,
        lifecycleEnabled: true,
        lifecycleRepository: life,
      },
    });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    apps.push(app);
    return app;
  }
  const app = await appFor(),
    readonly = await appFor(reviewer);
  const request = (method, url, payload, target = app) =>
    target.inject({ method, url, headers: auth, payload });
  const make = async (label) => {
    const r = await request('POST', '/api/tenders', { title: 'SYNTHETIC TASK011D ' + label });
    assert.equal(r.statusCode, 201, r.body);
    return r.json().id;
  };
  const base = (t) => '/api/tenders/' + t + '/intake';
  async function upload(t, files, key = randomUUID(), target = app) {
    const m = multipart(files);
    return target.inject({
      method: 'POST',
      url: base(t) + '/batches',
      headers: { ...auth, ...m.headers, 'idempotency-key': key },
      payload: m.payload,
    });
  }
  const get = async (t, path = '/documents') => {
    const r = await request('GET', base(t) + path);
    assert.equal(r.statusCode, 200, r.body);
    return r.json();
  };
  const runs = async (t) =>
    (
      await pool.query(
        'SELECT * FROM tender_app.intake_processing_run WHERE tender_id=$1 ORDER BY enqueue_order',
        [t],
      )
    ).rows;
  const done = async (t) =>
    until(async () => {
      const rows = await runs(t);
      return rows.length && rows.every((r) => ['completed', 'failed', 'blocked'].includes(r.status))
        ? rows
        : null;
    }, 'tender terminal');
  const files = tenFiles();
  await allow(files, 'synthetic', 182);
  phase = 'enqueue and independent worker';
  const tender = await make('10 documents'),
    before = await life.preview(actor, tender),
    key = randomUUID(),
    uploaded = await upload(tender, files, key);
  assert.equal(uploaded.statusCode, 201, uploaded.body);
  assert.equal(uploaded.json().outcomes.length, 10);
  assert.ok(uploaded.json().outcomes.every((o) => o.status === 'accepted'));
  assert.equal((await runs(tender)).length, 10);
  assert.ok((await runs(tender)).every((r) => r.status === 'queued' && r.attempt_count === 0));
  assert.equal(await count('intake_result'), 0);
  assert.equal(await count('intake_company'), 0);
  const preview = await life.preview(actor, tender);
  assert.ok(preview.busy && !preview.allowed.archive);
  assert.notEqual(preview.previewHash, before.previewHash);
  await assert.rejects(
    life.act(actor, tender, {
      action: 'archive',
      previewHash: before.previewHash,
      confirmationId: tender,
      confirmationTitle: before.title,
      reason: 'Synthetic stale preview blocked',
    }),
  );
  for (const action of ['archive', 'trash']) {
    const staleResponse = await request('POST', '/api/tenders/' + tender + '/lifecycle', {
      action,
      previewHash: before.previewHash,
      confirmationId: tender,
      confirmationTitle: before.title,
      reason: 'Synthetic stale preview must fail',
    });
    assert.equal(staleResponse.statusCode, 409, staleResponse.body);
  }
  assert.equal((await upload(tender, files, key)).statusCode, 200);
  const background = await child();
  const completed = await done(tender);
  assert.equal(
    completed.filter((r) => r.status === 'completed').length,
    9,
    JSON.stringify(completed.map((r) => [r.status, r.error_code])),
  );
  assert.equal(completed.filter((r) => r.status === 'failed').length, 1);
  assert.equal(completed.find((r) => r.status === 'failed').attempt_count, 1);
  assert.equal(await count('intake_company', tender), 3);
  for (const table of ['supplier', 'tender_supplier', 'offer_version', 'document'])
    assert.equal(await count(table), 0, table);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM tender_app.intake_association_head WHERE tender_id=$1 AND association_type='quality_for'",
        [tender],
      )
    ).rows[0].n,
    3,
  );
  const docs = await get(tender);
  assert.equal(docs.length, 10);
  for (const file of files) {
    const row = docs.find((r) => r.name === file.name),
      download = await request('GET', base(tender) + '/originals/' + row.originalId + '/download');
    assert.equal(sha(download.rawPayload), sha(file.content));
  }
  assert.ok(
    completed
      .filter((r) => r.status === 'completed')
      .every(
        (r) =>
          ['originalVerified', 'classification', 'organizations', 'resolver', 'associations'].every(
            (k) => r.coverage[k] === true,
          ) && r.coverage.model === false,
      ),
  );
  await kill(background);
  ok(
    'HTTP only atomically enqueues 10 independent runs; separate automatic Worker completes 9, permanently fails corrupt original once; 3 companies/0 business suppliers; quality_for proposals, original SHA and complete stage coverage',
  );
  phase = 'policy and API read purity';
  await allow([], 'disabled', 261);
  const blocked = await make('policy blocked'),
    badXlsx = {
      name: 'blocked.xlsx',
      mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      content: Buffer.from('SYNTHETIC not a parsed XLSX'),
    };
  const blockedUpload = await upload(blocked, [badXlsx]);
  assert.equal(blockedUpload.statusCode, 201, blockedUpload.body);
  assert.equal((await runs(blocked))[0].status, 'blocked');
  assert.equal((await runs(blocked))[0].error_code, 'processing_disabled');
  await allow([], 'synthetic', 272);
  const unknown = await make('unapproved SHA');
  assert.equal((await upload(unknown, [txt('unapproved.txt', 'Synthetic no policy grant')])).statusCode, 201);
  assert.equal((await runs(unknown))[0].error_code, 'sha_not_approved');
  const idle = await child();
  await wait(180);
  await kill(idle);
  assert.equal(await count('intake_processing_checkpoint', blocked), 0);
  assert.equal((await runs(unknown))[0].attempt_count, 0);
  const eventCount = await count('intake_run_event');
  await get(tender);
  await get(tender, '/batches/' + uploaded.json().batchId);
  await get(tender, '/receipts/' + docs[0].receiptId + '/processing');
  assert.equal(await count('intake_run_event'), eventCount);
  assert.ok((await life.preview(actor, blocked)).busy);
  ok(
    'disabled/unapproved SHA accepted as explicit blocked jobs with zero parser attempts/checkpoints; blocked is busy; GET/list/history/batch never enqueue or mutate',
  );
  phase = 'late policy revocation and explicit blocked decision';
  const revoked = await make('late policy revocation'),
    revokedFile = txt('revoked.txt', 'Commercial offer; ' + seller('Synthetic Revoked'));
  await allow([revokedFile], 'synthetic', 293);
  await upload(revoked, [revokedFile]);
  const revokedQ = new queues.IntakeQueue(pool, policy),
    revokedTicket = await revokedQ.claim('synthetic-policy-worker', queues.workerTiming(timing, true));
  const preparedClassification = await classification.classify(revokedFile),
    preparedOrganizations = await repo.workerExtract(revokedTicket, revokedFile);
  await allow([], 'disabled', 299);
  await assert.rejects(
    repo.completeWorker(
      revokedTicket,
      preparedClassification,
      preparedOrganizations.organizations,
      queues.workerTiming(timing, true),
    ),
  );
  assert.equal(await count('intake_result', revoked), 0);
  assert.equal(await count('intake_company', revoked), 0);
  await wait(1050);
  const revocationWorker = await child();
  await done(revoked);
  await kill(revocationWorker);
  const blockedRun = (await runs(revoked))[0];
  assert.equal(blockedRun.status, 'blocked');
  const cancel = await app.inject({
    method: 'POST',
    url: base(revoked) + '/receipts/' + blockedRun.receipt_id + '/cancel-processing',
    headers: { ...auth, 'idempotency-key': randomUUID() },
    payload: {
      expectedRunRevision: blockedRun.state_revision,
      reason: 'Synthetic explicit blocked decision',
    },
  });
  assert.equal(cancel.statusCode, 201, cancel.body);
  assert.equal((await life.preview(actor, revoked)).busy, false);
  await allow([], 'synthetic', 327);
  ok(
    'policy revoked after actual parsing: fenced finalization writes no results/companies; expired job becomes blocked and explicit authorized cancellation clears busy without deleting originals',
  );
  phase = 'lease fencing and heartbeat';
  const stale = await make('stale lease'),
    staleFile = txt('stale.txt', 'Commercial offer; ' + seller('Synthetic Stale'));
  await allow([staleFile], 'synthetic', 334);
  await upload(stale, [staleFile]);
  const q = new queues.IntakeQueue(pool, policy),
    short = queues.workerTiming(timing, true);
  const a = await q.claim('synthetic-worker-A', short);
  assert.ok(a);
  const staleClassification = await classification.classify(staleFile),
    staleOrganizations = await repo.workerExtract(a, staleFile);
  await wait(1050);
  const b = await q.claim('synthetic-worker-B', short);
  assert.equal(b.id, a.id);
  assert.notEqual(b.lease_token, a.lease_token);
  await assert.rejects(q.update(a, 'old_worker', short), (e) => e instanceof queues.LeaseLost);
  await assert.rejects(
    repo.completeWorker(a, staleClassification, staleOrganizations.organizations, short),
    (e) => e instanceof queues.LeaseLost,
  );
  const store = new stores.FileStore(run.storageRoot, workspace),
    workerB = new workers.IntakeWorker(pool, repo, store, 'synthetic-worker-B', timing);
  await workerB.execute(b);
  assert.equal((await runs(stale))[0].status, 'completed');
  assert.equal(await count('intake_company', stale), 1);
  assert.equal(await count('intake_identity_claim', stale), 1);
  const heartbeatTender = await make('heartbeat'),
    heartFile = txt('heart.txt', 'Commercial offer; ' + seller('Synthetic Heart'));
  await allow([heartFile], 'synthetic', 359);
  await upload(heartbeatTender, [heartFile]);
  const paused = await child({ testPoint: 'after_claim' });
  await until(() => paused.messages.some((m) => m.point === 'after_claim'), 'heartbeat claimed');
  await wait(1300);
  assert.equal((await life.preview(actor, heartbeatTender)).busy, true);
  assert.equal(await q.claim('synthetic-other-worker', short), null);
  const hist = await get(
    heartbeatTender,
    '/receipts/' + (await get(heartbeatTender))[0].receiptId + '/processing',
  );
  assert.ok(hist.events.some((e) => e.code === 'heartbeat' && e.actor_id === null && e.worker_id));
  await kill(paused);
  await wait(1000);
  const recovered = await child();
  await done(heartbeatTender);
  await kill(recovered);
  ok(
    'expired lease -> new token/revision; stale worker fenced out; healthy heartbeat prevents theft beyond initial lease; killed worker recovered with explicit system identity and no duplicate claims',
  );
  phase = 'crash recovery at each stage';
  for (const point of [
    'after_claim',
    'after_read',
    'after_classification',
    'after_organizations',
    'after_resolver',
    'after_commit',
  ]) {
    const t = await make('crash ' + point),
      file = txt(point + '.txt', 'Commercial offer; ' + seller('Synthetic Crash ' + point));
    await allow([file], 'synthetic', 390);
    await upload(t, [file]);
    const crashing = await child({ testPoint: point });
    await until(() => crashing.messages.some((m) => m.point === point), 'fault point ' + point);
    const snapshotOriginal = (
      await pool.query('SELECT * FROM tender_app.intake_document WHERE tender_id=$1', [t])
    ).rows;
    await kill(crashing);
    if (point === 'after_resolver') {
      assert.equal(await count('intake_company', t), 0);
      assert.equal(await count('intake_result', t), 0);
    }
    if (point !== 'after_commit') await wait(1050);
    const restarting = await child();
    await done(t);
    await wait(100);
    await kill(restarting);
    assert.equal(await count('intake_company', t), 1);
    assert.equal(await count('intake_identity_claim', t), 1);
    assert.equal(await count('intake_organization_observation', t), 1);
    assert.equal(await count('intake_result', t), 1);
    assert.equal((await runs(t)).length, 1);
    assert.deepEqual(
      (await pool.query('SELECT * FROM tender_app.intake_document WHERE tender_id=$1', [t])).rows,
      snapshotOriginal,
    );
    assert.equal((await runs(t))[0].attempt_count, point === 'after_commit' ? 1 : 2);
  }
  ok(
    'forced process death after claim/read/classification/Organizations/resolver/commit: SQL checkpoints survive, uncommitted resolver rolls back, terminal commit never repeats, no reload/duplicate originals/companies/observations/claims',
  );
  phase = 'transient retry permanent and exhaustion';
  for (const [fault, expectedAttempts, status] of [
    ['once', 2, 'completed'],
    ['always', 3, 'failed'],
    ['permanent', 1, 'failed'],
  ]) {
    const t = await make('retry ' + fault),
      file = txt(fault + '.txt', 'Commercial offer; ' + seller('Synthetic Retry ' + fault));
    await allow([file], 'synthetic', 429);
    await upload(t, [file]);
    const w = await child({ testFault: fault, timing: { ...timing, backoffMs: [1500, 1500, 1500] } });
    if (fault !== 'permanent') {
      await until(async () => (await runs(t))[0]?.status === 'retry_wait', 'retry wait visible');
      assert.equal((await life.preview(actor, t)).busy, true);
    }
    await done(t);
    await kill(w);
    const row = (await runs(t))[0];
    assert.equal(row.status, status);
    assert.equal(row.attempt_count, expectedAttempts);
    const events = await get(t, '/receipts/' + row.receipt_id + '/processing');
    assert.equal(events.events.filter((e) => e.to_state === 'retry_wait').length, expectedAttempts - 1);
  }
  ok(
    'transient read failure retries, permanent never loops, maximum 3 total attempts with bounded retry_wait/backoff and immutable attempt history',
  );
  phase = 'manual idempotent generation';
  phase = 'real SQL transient and heartbeat failure';
  const sqlRetry = await make('SQL transient rollback'),
    sqlFile = txt('sql-retry.txt', 'Commercial offer; ' + seller('Synthetic SQL Retry'));
  await allow([sqlFile], 'synthetic', 451);
  await upload(sqlRetry, [sqlFile]);
  await pool.query(
    "CREATE FUNCTION test_control.fail_first_resolver() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.requisites->'names' ? 'Synthetic SQL Retry' AND EXISTS(SELECT 1 FROM tender_app.intake_processing_run WHERE tender_id=NEW.tender_id AND status='completed' AND attempt_count=1) THEN RAISE EXCEPTION 'synthetic serialization failure' USING ERRCODE='40001'; END IF; RETURN NEW; END $$; CREATE TRIGGER synthetic_sql_retry BEFORE INSERT ON tender_app.intake_company_revision FOR EACH ROW EXECUTE FUNCTION test_control.fail_first_resolver()",
  );
  const sqlWorker = await child();
  await done(sqlRetry);
  await kill(sqlWorker);
  assert.equal((await runs(sqlRetry))[0].attempt_count, 2);
  assert.equal((await runs(sqlRetry))[0].status, 'completed');
  assert.equal(await count('intake_company', sqlRetry), 1);
  assert.equal(await count('intake_organization_observation', sqlRetry), 1);
  const heartbeatFail = await make('SQL heartbeat failure'),
    hfFile = txt('heartbeat-failure.txt', 'Commercial offer; ' + seller('Synthetic Lost Heartbeat'));
  await allow([hfFile], 'synthetic', 465);
  await upload(heartbeatFail, [hfFile]);
  await pool.query(
    "CREATE FUNCTION test_control.fail_heartbeat() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.tender_id='" +
      heartbeatFail +
      "'::uuid AND NEW.status='running' AND NEW.attempt_count=1 AND NEW.stage=OLD.stage THEN RAISE EXCEPTION 'synthetic heartbeat failure' USING ERRCODE='40001'; END IF; RETURN NEW; END $$; CREATE TRIGGER synthetic_heartbeat_failure BEFORE UPDATE ON tender_app.intake_processing_run FOR EACH ROW EXECUTE FUNCTION test_control.fail_heartbeat()",
  );
  const failingHB = await child({ testDelayAfterRead: 350 });
  await until(
    async () =>
      (
        await pool.query(
          "SELECT 1 FROM tender_app.audit_event WHERE tender_id=$1 AND action='intake.worker.rejected.lease_lost'",
          [heartbeatFail],
        )
      ).rowCount,
    'heartbeat lost audit',
  );
  assert.equal(await count('intake_result', heartbeatFail), 0);
  await kill(failingHB);
  await wait(1100);
  const hbRecovery = await child();
  await done(heartbeatFail);
  await kill(hbRecovery);
  assert.equal((await runs(heartbeatFail))[0].status, 'completed');
  assert.equal(await count('intake_company', heartbeatFail), 1);
  ok(
    'actual SQLSTATE 40001 rolls back finalization then retries from checkpoints once; failed SQL heartbeat prohibits finalization and recovered lease produces one result/company',
  );
  phase = 'manual idempotent generation';
  const reprocessFile = txt('manual.txt', 'Commercial offer; ' + seller('Synthetic Manual')),
    manual = await make('manual generation');
  await allow([reprocessFile], 'synthetic', 497);
  await upload(manual, [reprocessFile]);
  const w = await child();
  await done(manual);
  await kill(w);
  const previous = (await runs(manual))[0],
    operation = randomUUID(),
    body = { expectedRunRevision: previous.state_revision, reason: 'Synthetic explicit reprocess' },
    path = base(manual) + '/receipts/' + previous.receipt_id + '/reprocess';
  const reprocess = () =>
    app.inject({
      method: 'POST',
      url: path,
      headers: { ...auth, 'idempotency-key': operation },
      payload: body,
    });
  const replies = await Promise.all([reprocess(), reprocess()]);
  assert.ok(
    replies.every((r) => r.statusCode === 201),
    replies.map((r) => r.body).join('\n'),
  );
  assert.equal(replies[0].json().runId, replies[1].json().runId);
  assert.equal((await runs(manual)).length, 2);
  assert.equal((await runs(manual))[1].retry_of, previous.id);
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: path,
        headers: { ...auth, 'idempotency-key': operation },
        payload: { ...body, reason: 'changed' },
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: path,
        headers: { ...auth, 'idempotency-key': randomUUID() },
        payload: body,
      })
    ).statusCode,
    409,
  );
  const again = await child();
  await done(manual);
  await kill(again);
  assert.equal(await count('intake_company', manual), 1);
  assert.equal(await count('intake_receipt', manual), 1);
  ok(
    'explicit operation key and expectedRunRevision; parallel reprocess yields one new generation/retry_of; same key/body replay, changed key body/stale/active rejected; original and company identity preserved',
  );
  phase = 'context relations and shared originals';
  const relations = await make('context relations'),
    attachment = asPdf(
      'shared.pdf',
      'Quality certificate; Manufacturer: Synthetic Manufacturer; Country: RU; INN: ' + inn('900000008'),
    );
  const mails = [
    mail('a.eml', 'a@example.invalid', seller('Synthetic Mail A'), attachment),
    mail('b.eml', 'b@example.invalid', seller('Synthetic Mail B', inn('900000002')), attachment),
  ];
  await allow([...mails, attachment], 'synthetic', 561);
  const mailsUpload = await upload(relations, mails);
  assert.equal(mailsUpload.statusCode, 201, mailsUpload.body);
  assert.equal(mailsUpload.json().outcomes[0].receiptIds.length, 2);
  const mw = await child();
  await done(relations);
  await kill(mw);
  const shared = (
    await pool.query(
      'SELECT r.* FROM tender_app.intake_receipt r JOIN tender_app.intake_document d ON d.id=r.original_id WHERE r.tender_id=$1 AND d.blob_sha256=$2',
      [relations, sha(attachment.content)],
    )
  ).rows;
  assert.equal(shared.length, 2);
  assert.equal(shared[0].original_id, shared[1].original_id);
  assert.notEqual(shared[0].parent_receipt_id, shared[1].parent_receipt_id);
  for (const r of shared) {
    const h = (
      await pool.query('SELECT * FROM tender_app.intake_association_head WHERE receipt_id=$1', [r.id])
    ).rows;
    assert.equal(h.filter((a) => a.association_type === 'contained_in').length, 1);
    assert.ok(h.every((a) => a.association_type !== 'supplier_of' && a.association_type !== 'quality_for'));
  }
  const actualSpec = txt('actual-specification.txt', 'Technical specification; Buyer: Synthetic Buyer');
  await allow([actualSpec], 'synthetic', 585);
  await upload(relations, [actualSpec]);
  const sw = await child();
  await done(relations);
  await kill(sw);
  const specReceipt = (await get(relations)).find((r) => r.name === 'actual-specification.txt').receiptId;
  const references = txt(
    'references.txt',
    'Supporting document; Specification receipt: ' +
      specReceipt +
      '; Supersedes receipt: ' +
      shared[1].id +
      '; Specification receipt: ' +
      shared[0].id,
  );
  await allow([references], 'synthetic', 600);
  await upload(relations, [references]);
  const rw = await child();
  await done(relations);
  await kill(rw);
  const relationTypes = (
    await pool.query(
      'SELECT DISTINCT association_type FROM tender_app.intake_association_head WHERE tender_id=$1',
      [relations],
    )
  ).rows.map((r) => r.association_type);
  for (const type of ['contained_in', 'relates_to_specification', 'supersedes'])
    assert.ok(relationTypes.includes(type));
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM tender_app.intake_association_head WHERE tender_id=$1 AND association_type='relates_to_specification' AND target_receipt_id<>$2",
        [relations, specReceipt],
      )
    ).rows[0].n,
    0,
  );
  ok(
    'MIME containment is independent of semantic supplier links; shared SHA/two receipts/two parents never inherits supplier; manufacturer-only quality stays unassigned; explicit in-tender receipt proofs create specification/supersedes proposals',
  );
  phase = 'Lifecycle, permissions and API post-commit recovery';
  const ready = await life.preview(actor, tender);
  assert.equal(ready.busy, false);
  assert.equal(ready.allowed.archive, true);
  const action = (p, kind) => ({
    action: kind,
    previewHash: p.previewHash,
    confirmationId: tender,
    confirmationTitle: p.title,
    reason: 'Synthetic D disposable Lifecycle regression',
  });
  assert.equal(
    (await request('POST', '/api/tenders/' + tender + '/lifecycle', action(ready, 'archive'))).statusCode,
    201,
  );
  const archived = await life.preview(actor, tender);
  assert.equal(archived.state, 'archived');
  assert.equal(
    (await request('POST', '/api/tenders/' + tender + '/lifecycle', action(archived, 'restore'))).statusCode,
    201,
  );
  assert.equal((await life.preview(actor, tender)).state, 'active');
  await pool.query("INSERT INTO tender_app.tender_member(tender_id,user_id,role) VALUES($1,$2,'reviewer')", [
    tender,
    reviewer,
  ]);
  assert.equal((await upload(tender, [files[0]], randomUUID(), readonly)).statusCode, 403);
  const forced = await make('archived finalization fence'),
    forcedFile = txt('forced.txt', 'Commercial offer; ' + seller('Synthetic Archived'));
  await allow([forcedFile], 'synthetic', 654);
  await upload(forced, [forcedFile]);
  const activeTicket = await q.claim('synthetic-archive-fence', short);
  assert.ok(activeTicket);
  // Explicit isolated fault fixture for an otherwise forbidden archive-vs-running condition; no ACL/hold override.
  await pool.query("INSERT INTO tender_app.tender_lifecycle(tender_id,state) VALUES($1,'archived')", [
    forced,
  ]);
  const forcedWorker = new workers.IntakeWorker(pool, repo, store, 'synthetic-archive-fence', timing);
  await forcedWorker.execute(activeTicket);
  assert.equal(await count('intake_result', forced), 0);
  assert.ok((await life.preview(actor, forced)).busy);
  assert.equal((await life.preview(actor, forced)).allowed.restore, false);
  assert.ok(
    (
      await pool.query(
        "SELECT 1 FROM tender_app.audit_event WHERE tender_id=$1 AND action LIKE 'intake.worker.rejected.%'",
        [forced],
      )
    ).rowCount,
  );
  const network = await make('HTTP commit before response'),
    networkFile = txt('network.txt', 'Commercial offer; ' + seller('Synthetic HTTP'));
  await allow([networkFile], 'synthetic', 677);
  const api = await child({ apiOnly: true, testPauseResponse: true }, 'scripts/task011d/regression-api.mjs'),
    origin = api.messages.find((m) => m.ready).origin;
  const form = new FormData();
  form.append('files', new Blob([networkFile.content], { type: networkFile.mime }), networkFile.name);
  const networkKey = randomUUID(),
    pending = fetch(origin + base(network) + '/batches', {
      method: 'POST',
      headers: { ...auth, 'idempotency-key': networkKey },
      body: form,
    }).catch(() => null);
  await until(() => api.messages.some((m) => m.point === 'after_enqueue_commit'), 'HTTP commit point');
  await kill(api);
  await pending;
  assert.equal((await runs(network)).length, 1);
  assert.equal((await upload(network, [networkFile], networkKey)).statusCode, 200);
  const nw = await child();
  await done(network);
  await kill(nw);
  assert.equal(await count('intake_company', network), 1);
  ok(
    'real disposable Archive/Restore and stale preview/busy protection; archived finalization audited without new results, invalid busy Restore rejected; real HTTP process death after enqueue commit replays without duplicate run',
  );
  phase = 'authorization denial fault without ACL mutation';
  const deniedTender = await make('permanent authorization denial');
  await upload(deniedTender, [files[0]]);
  class DeniedQueue extends queues.IntakeQueue {
    async lock(...args) {
      await super.lock(...args);
      throw new ForbiddenException();
    }
  }
  const deniedQueue = new DeniedQueue(pool, policy);
  assert.equal(await deniedQueue.claim('synthetic-denied', timing), null);
  const deniedRun = (await runs(deniedTender))[0];
  assert.equal(deniedRun.status, 'failed');
  assert.equal(deniedRun.error_code, 'permission_denied');
  assert.equal(deniedRun.attempt_count, 0);
  assert.equal(await count('intake_result', deniedTender), 0);
  assert.equal((await life.preview(actor, deniedTender)).busy, false);
  ok('authorization-port denial permanently fails queued job before parsing; no ACL or capability mutation');
  phase = 'API automatic worker startup';
  const stackTender = await make('automatic API worker'),
    stackFile = txt('stack.txt', 'Commercial offer; ' + seller('Synthetic Stack'));
  await allow([stackFile], 'synthetic', 721);
  const stack = await child({}, 'scripts/task011d/regression-api.mjs');
  const stackReady = stack.messages.find((m) => m.ready);
  assert.ok(Number.isInteger(stackReady.workerPid));
  try {
    const stackForm = new FormData();
    stackForm.append('files', new Blob([stackFile.content], { type: stackFile.mime }), stackFile.name);
    const response = await fetch(stackReady.origin + base(stackTender) + '/batches', {
      method: 'POST',
      headers: { ...auth, 'idempotency-key': randomUUID() },
      body: stackForm,
    });
    assert.equal(response.status, 201, await response.text());
    const stackRuns = await done(stackTender);
    assert.equal(stackRuns[0].status, 'completed');
    assert.equal(await count('intake_company', stackTender), 1);
  } finally {
    // Both PIDs belong to this freshly spawned isolated stack; Windows signals are forceful.
    try {
      process.kill(stackReady.workerPid, 'SIGKILL');
    } catch (e) {
      assert.equal(e.code, 'ESRCH');
    }
    await kill(stack);
  }
  ok(
    'isolated HTTP API automatically starts its own separate worker; real upload completes without manual worker launch',
  );
  assert.ok(connections.every((d) => d === 'postgres' || d === run.database));
  const incomplete = (
    await pool.query(
      'SELECT 1 FROM tender_app.intake_processing_run p LEFT JOIN tender_app.intake_run_event e ON e.run_id=p.id AND e.state_revision=p.state_revision WHERE e.id IS NULL',
    )
  ).rows;
  assert.equal(incomplete.length, 0);
  passed = true;
  await json(resolve(run.runRoot, 'task011d-api-results.json'), {
    status: 'PASS',
    results,
    identity: run.identity,
    connections,
    mainConnections: 0,
    modelCalls: 0,
    mainScenario: {
      documents: 10,
      runs: 10,
      completed: 9,
      failed: 1,
      preliminaryCompanies: 3,
      confirmedSuppliers: 0,
    },
    productionTiming: queues.workerTiming(),
    testTiming: timing,
  });
  console.log(
    JSON.stringify({ status: 'PASS', groups: results.length, runRoot: run.runRoot, database: run.database }),
  );
} catch (error) {
  console.error('FAIL phase=' + phase, error);
  await json(resolve(run.runRoot, 'task011d-api-results.json'), {
    status: 'FAIL',
    phase,
    message: error.message,
    results,
    connections,
  });
  throw error;
} finally {
  for (const child of children) await kill(child);
  for (const app of apps) await app.close();
  await run.close(passed ? 'PASSED_RETAINED' : 'FAILED_RETAINED');
}
