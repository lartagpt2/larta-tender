import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { isolatedRun, verifyIdentity } from '../testing/isolated-run.mjs';
import { workspace, json, save } from '../task008-gate-d/io.mjs';
import { isolatedWeb, syntheticKit } from './browser.mjs';
import application from '../../apps/api/dist/application.js';
import intake from '../../apps/api/dist/unified-intake/intake-repository.js';
import policies from '../../apps/api/dist/unified-intake/processing-policy.js';
import tenders from '../../apps/api/dist/data/repository.js';
import scope from '../../apps/api/dist/data/scope-repository.js';
import offers from '../../apps/api/dist/data/offer-repository.js';
import verification from '../../apps/api/dist/comparison/verification-repository.js';
import lifecycle from '../../apps/api/dist/lifecycle/lifecycle-repository.js';
import stages from '../../apps/api/dist/stages/stage-repository.js';
if (!process.argv.includes('--run'))
  throw Error('Explicit --run required; creates only a new UUID disposable UAT database');
const run = await isolatedRun('task011e-owner-uat'),
  pool = run.pool,
  apps = [],
  webs = [];
const actor = randomUUID(),
  reviewer = randomUUID(),
  outsider = randomUUID(),
  token = randomBytes(32).toString('hex');
let worker,
  stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  if (worker && worker.exitCode === null && worker.signalCode === null) {
    const ended = once(worker, 'exit');
    if (worker.kill('SIGTERM')) await ended;
  }
  for (const web of webs) await web.close();
  for (const app of apps) await app.close();
  await run.close('UAT_STOPPED_RETAINED');
}
try {
  await verifyIdentity(pool, run.identity);
  const policyBytes = await readFile(
    resolve(
      workspace,
      '../task011d-74959e1f-318b-4d56-a158-08304a26b7c6/temp/integration-runs/010eeff4-5d2a-4261-ae55-56d55c907e8b/synthetic-policy.json',
    ),
  );
  assert.equal(
    createHash('sha256').update(policyBytes).digest('hex'),
    '74dffd227d0232b9e60afdcdb09e0f01461d02a9d72f043df480377a174b5a3e',
  );
  const policyFile = resolve(run.runRoot, 'accepted-D-policy.json');
  await save(policyFile, policyBytes);
  await syntheticKit(policyBytes);
  const policy = policies.IntakePolicy.file(policyFile, workspace),
    repo = new intake.PgIntakeRepository(pool, undefined, policy);
  for (const id of [actor, reviewer, outsider])
    await pool.query(
      "INSERT INTO tender_app.app_user(id,external_subject,display_name) VALUES($1,$2,'Synthetic isolated UAT role')",
      [id, 'synthetic:uat:' + id],
    );
  async function makeApp(actorId) {
    const app = await application.createApplication({
      logger: false,
      environment: 'test',
      data: {
        enabled: true,
        token,
        actorId,
        repository: new tenders.PgTenderRepository(pool),
        scopeRepository: new scope.PgScopeRepository(pool),
        intakeRepository: repo,
        offerRepository: new offers.PgOfferRepository(pool),
        verificationRepository: new verification.PgVerificationRepository(pool),
        stageRepository: new stages.PgStageRepository(pool),
        lifecycleEnabled: true,
        lifecycleRepository: new lifecycle.PgLifecycleRepository(pool, async () => ({ jobs: [], active: 0 })),
      },
    });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    apps.push(app);
    return app;
  }
  const owner = await makeApp(actor),
    readOnly = await makeApp(reviewer),
    foreign = await makeApp(outsider),
    headers = { authorization: 'Bearer ' + token };
  const created = await owner.inject({
    method: 'POST',
    url: '/api/tenders',
    headers,
    payload: { title: 'SYNTHETIC TASK-011E OWNER UAT' },
  });
  assert.equal(created.statusCode, 201);
  const tender = created.json().id;
  await pool.query("INSERT INTO tender_app.tender_member(tender_id,user_id,role) VALUES($1,$2,'reviewer')", [
    tender,
    reviewer,
  ]);
  const lot = await owner.inject({
    method: 'POST',
    url: '/api/tenders/' + tender + '/verification/lot',
    headers,
    payload: { expectedRevision: 1 },
  });
  assert.equal(lot.statusCode, 201, lot.body);
  const config = resolve(run.runRoot, 'worker.json');
  await json(config, {
    identity: run.identity,
    storageRoot: run.storageRoot,
    workspace,
    policyFile,
    actorId: actor,
  });
  worker = spawn(process.execPath, ['scripts/intake-worker.mjs', config], {
    cwd: process.cwd(),
    env: process.env,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let workerFailure = '';
  worker.stderr.on('data', (b) => (workerFailure += b.toString().slice(0, 1500)));
  worker.once('exit', () => {
    if (!stopping) {
      console.error('Isolated UAT Worker exited');
      process.exitCode = 1;
      void stop();
    }
  });
  const endpoints = [];
  for (const [role, app] of [
    ['owner', owner],
    ['reviewer', readOnly],
    ['outsider', foreign],
  ]) {
    const web = await isolatedWeb(app, token, run);
    webs.push(web.web);
    endpoints.push({
      role,
      apiOrigin: web.apiOrigin,
      webOrigin: web.origin,
      url: web.origin + '/tenders/' + tender + '/intake',
    });
  }
  await run.capture('UAT_READY_RETAINED');
  const ready = {
    status: 'READY_FOR_OWNER_REVIEW_NOT_ACCEPTED',
    identity: run.identity,
    tenderId: tender,
    lotId: lot.json().id,
    runRoot: run.runRoot,
    endpoints,
    processId: process.pid,
    workerPid: worker.pid,
    storageRoot: run.storageRoot,
    policySha256: createHash('sha256').update(policyBytes).digest('hex'),
    realModelCalls: 0,
    mainConnections: 0,
    cleanup: 'NOT_AUTHORIZED',
    createdAt: new Date().toISOString(),
  };
  await json(resolve(workspace, 'uat-ready.json'), ready);
  console.log(JSON.stringify(ready));
  process.on('SIGINT', () => void stop().then(() => process.exit(0)));
  process.on('SIGTERM', () => void stop().then(() => process.exit(0)));
} catch (e) {
  console.error(e.message);
  await stop();
  throw e;
}
