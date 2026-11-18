import { drainUntilSettled } from './regression-drain.mjs';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import pg from 'pg';
import { isolatedRun, verifyIdentity } from '../testing/isolated-run.mjs';
import { json, workspace } from '../task008-gate-d/io.mjs';
import { regressionPolicy } from './regression-policy.mjs';
import { tenFiles, txt, asPdf, seller, alpha, beta, inn, multipart } from './fixtures.mjs';
import applications from '../../apps/api/dist/application.js';
import intakes from '../../apps/api/dist/unified-intake/intake-repository.js';
import workers from '../../apps/api/dist/unified-intake/intake-worker.js';
import stores from '../../apps/api/dist/storage/file-store.js';
import tenders from '../../apps/api/dist/data/repository.js';
import native from '../../apps/api/dist/unified-intake/organizations.js';
import classification from '../../apps/api/dist/unified-intake/classification.js';
const caseId = process.argv[process.argv.indexOf('--case') + 1];
assert.match(caseId, /^F(?:0[1-9]|1[0-2])$/);
assert.ok(process.argv.includes('--run'), 'explicit --run required');
const sha = (x) => createHash('sha256').update(x).digest('hex');
const manifestBytes = await readFile(resolve(workspace, 'regression-only-C-manifest.json'));
assert.equal(sha(manifestBytes), '6f690861d0f43974b978d67573e8d7ea2c4fc5e15799f01d916d1f6359ae99af');
const manifest = JSON.parse(manifestBytes),
  generator = await readFile(resolve('scripts/task011c/integration.mjs'), 'utf8');
assert.equal(sha(generator), '14b70c7724b8cd853693d8cf451624ed21ce6fcb0563ada9930864d31af52cb8');
const tree = ts.createSourceFile(
    'integration.mjs',
    generator,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  ),
  generated = [];
function visit(n) {
  if (
    ts.isCallExpression(n) &&
    ts.isIdentifier(n.expression) &&
    ['txt', 'asPdf'].includes(n.expression.text)
  ) {
    const file = vm.runInNewContext(
      n.getText(tree),
      { txt, asPdf, seller, alpha, beta, inn, leadingValue: inn('012345678'), Number },
      { timeout: 1000 },
    );
    generated.push({ file, line: tree.getLineAndCharacterOfPosition(n.getStart(tree)).line + 1 });
  }
  ts.forEachChild(n, visit);
}
visit(tree);
const mainFiles = tenFiles();
for (const f of manifest.fixtures) {
  const file = f.generator.endsWith('/fixtures.mjs')
    ? mainFiles.find((x) => x.name === f.name)
    : generated.find((x) => x.line === f.generatorLine && x.file.name === f.name)?.file;
  assert.ok(file);
  assert.equal(file.content.length, f.bytes);
  assert.equal(sha(file.content), f.sha256);
}
const fixture = (name, line) => {
  const f = generated.find((x) => x.line === line && x.file.name === name)?.file;
  assert.ok(f);
  return f;
};
const run = await isolatedRun('task011c-remediation-' + caseId.toLowerCase()),
  pool = run.pool,
  actor = randomUUID(),
  token = randomBytes(32).toString('hex'),
  auth = { authorization: 'Bearer ' + token },
  errors = [];
let app,
  reproduced = false,
  evidence = {},
  fatal;
const tables = [
  'blob',
  'intake_batch',
  'intake_document',
  'intake_receipt',
  'intake_processing_run',
  'intake_processing_checkpoint',
  'intake_result',
  'intake_classification_revision',
  'intake_classification_head',
  'intake_organization_result',
  'intake_organization_observation',
  'intake_company',
  'intake_company_revision',
  'intake_identity_claim',
  'intake_association_revision',
  'intake_association_head',
  'intake_review_decision',
  'intake_evidence',
  'audit_event',
];
async function snapshot(client = pool) {
  const counts = {};
  for (const t of tables)
    counts[t] = Number((await client.query('SELECT count(*) n FROM tender_app.' + t)).rows[0].n);
  return {
    counts,
    runs: (
      await client.query(
        'SELECT id,receipt_id,source_sha,status,stage,state_revision,generation,error_code,policy_version FROM tender_app.intake_processing_run ORDER BY enqueue_order',
      )
    ).rows,
  };
}
try {
  await verifyIdentity(pool, run.identity);
  const policy = await regressionPolicy(pool, run.identity),
    repo = new intakes.PgIntakeRepository(pool, undefined, policy),
    store = new stores.FileStore(run.storageRoot, workspace);
  const complete = repo.completeWorker.bind(repo);
  repo.completeWorker = async (...args) => {
    try {
      return await complete(...args);
    } catch (e) {
      errors.push({ name: e.name, code: e.code, message: e.message, runId: args[0].id });
      throw e;
    }
  };
  const worker = new workers.IntakeWorker(pool, repo, store, 'C-remediation-' + caseId);
  const oldDrain = () => drainUntilSettled(repo, worker, pool, run.identity);

  await pool.query(
    "INSERT INTO tender_app.app_user(id,external_subject,display_name) VALUES($1,$2,'Synthetic remediation tester')",
    [actor, 'synthetic:' + actor],
  );
  app = await applications.createApplication({
    logger: false,
    environment: 'test',
    data: {
      enabled: true,
      token,
      actorId: actor,
      repository: new tenders.PgTenderRepository(pool),
      intakeRepository: repo,
    },
  });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const create = await app.inject({
    method: 'POST',
    url: '/api/tenders',
    headers: auth,
    payload: { title: 'SYNTHETIC C remediation ' + caseId },
  });
  assert.equal(create.statusCode, 201);
  const tender = create.json().id,
    base = '/api/tenders/' + tender + '/intake';
  const upload = async (files, key = randomUUID()) => {
    const form = multipart(files),
      r = await app.inject({
        method: 'POST',
        url: base + '/batches',
        headers: { ...auth, ...form.headers, 'idempotency-key': key },
        payload: form.payload,
      });
    assert.ok([200, 201].includes(r.statusCode), r.body);
    return { status: r.statusCode, body: r.json() };
  };
  const get = async (path) => {
    const r = await app.inject({ method: 'GET', url: base + path, headers: auth });
    assert.equal(r.statusCode, 200, r.body);
    return r.json();
  };
  const postReprocess = async (receipt, payload, key) => {
    const r = await app.inject({
      method: 'POST',
      url: base + '/receipts/' + receipt + '/reprocess',
      headers: { ...auth, ...(key ? { 'idempotency-key': key } : {}) },
      payload,
    });
    return { status: r.statusCode, body: r.json() };
  };
  if (['F01', 'F02', 'F03'].includes(caseId)) {
    const files = caseId === 'F03' ? [mainFiles[5]] : mainFiles;
    const accepted = await upload(files),
      before = await snapshot();
    await oldDrain();
    const registry = await get('/companies'),
      rows = await get('/documents'),
      six = rows.find((x) => x.name === 'six.eml'),
      history = await get('/receipts/' + six.receiptId);
    const pages = await native.organizationText(mainFiles[5]),
      orgs = await new native.NativeOrganizationsExtractor().extract({
        tenderId: tender,
        originalId: six.originalId,
        receiptId: six.receiptId,
        contractVersion: native.organizationSchema,
        pages,
        structure: { mime: mainFiles[5].mime },
      });
    const directClassification = await classification.classify(mainFiles[5]);
    const original = await app.inject({
      method: 'GET',
      url: base + '/originals/' + six.originalId + '/download',
      headers: auth,
    });
    assert.equal(sha(original.rawPayload), sha(mainFiles[5].content));
    evidence = {
      accepted,
      before,
      after: await snapshot(),
      registry,
      eml: {
        fixtureSha256: sha(mainFiles[5].content),
        bytes: mainFiles[5].content.length,
        originalSha256: sha(original.rawPayload),
        mime: mainFiles[5].mime,
        pages,
        organizationCandidates: orgs.length,
        classification: directClassification,
        history,
      },
      actual:
        caseId === 'F01'
          ? registry.unassignedReceipts.length
          : caseId === 'F02'
            ? registry.items.map((x) => x.receiptCount).sort()
            : Boolean(history.revisions.length && history.organizationResults.length),
      expected: caseId === 'F01' ? 2 : caseId === 'F02' ? [2, 3, 3] : true,
    };
    reproduced =
      caseId === 'F01'
        ? evidence.actual === 2
        : caseId === 'F02'
          ? JSON.stringify(evidence.actual) === '[2,3,3]'
          : evidence.actual === true;
  } else if (caseId === 'F04') {
    await upload([mainFiles[1]]);
    await oldDrain();
    const r = (
      await pool.query(
        'SELECT o.*,p.policy_version processing_policy_version FROM tender_app.intake_organization_result o JOIN tender_app.intake_result c ON c.id=o.classification_result_id JOIN tender_app.intake_processing_run p ON p.id=c.run_id',
      )
    ).rows[0];
    assert.ok(r);
    const before = await snapshot();
    try {
      await Promise.all([
        repo.replayOrganizations(actor, tender, r.id),
        repo.replayOrganizations(actor, tender, r.id),
      ]);
    } catch (e) {
      evidence.error = { status: e.getStatus?.(), message: e.message };
    }
    evidence = {
      ...evidence,
      before,
      after: await snapshot(),
      storedPolicyVersion: r.processing_policy_version,
      fallbackPolicyVersion: 'native-only-v1',
      expected: 'parallel replay succeeds without new rows',
      actual: evidence.error?.message,
    };
    reproduced = !evidence.error && JSON.stringify(evidence.before) === JSON.stringify(evidence.after);
  } else if (caseId === 'F05') {
    await Promise.all([upload([fixture('a.txt', 213)]), upload([fixture('b.pdf', 214)])]);
    await oldDrain();
    const key = randomUUID(),
      responses = await Promise.all([
        upload([fixture('c.txt', 225)], key),
        upload([fixture('c.txt', 225)], key),
      ]);
    const locked = await pool.connect();
    let processing;
    try {
      await locked.query('BEGIN');
      await locked.query('SELECT id FROM tender_app.tender WHERE id=$1 FOR UPDATE', [tender]);
      processing = oldDrain();
      await new Promise((r) => setTimeout(r, 40));
      evidence = { responses, lockedSnapshot: await snapshot() };
    } finally {
      await locked.query('ROLLBACK');
      locked.release();
    }
    await processing;
    evidence.afterReleaseAndDrain = await snapshot();
    evidence.expected = 3;
    evidence.actual = evidence.afterReleaseAndDrain.counts.intake_organization_observation;
    assert.equal(evidence.actual, 3);
    reproduced = true;
  } else if (['F06', 'F07'].includes(caseId)) {
    await upload([mainFiles[1]]);
    await oldDrain();
    const receipt = (await get('/documents'))[0],
      before = await snapshot();
    const currentRun = before.runs[0],
      key = randomUUID(),
      body = { expectedRunRevision: currentRun.state_revision, reason: 'Synthetic explicit C reprocess' };
    const parallel = await Promise.all([
      postReprocess(receipt.receiptId, body, key),
      postReprocess(receipt.receiptId, body, key),
    ]);
    assert.ok(parallel.every((r) => r.status === 201));
    assert.equal(parallel[0].body.runId, parallel[1].body.runId);
    const changed = await postReprocess(
      receipt.receiptId,
      { ...body, reason: 'Synthetic changed operation' },
      key,
    );
    assert.equal(changed.status, 409);
    await oldDrain();
    const afterCompletion = await snapshot();
    const staleAfterCompletion = await postReprocess(receipt.receiptId, body, randomUUID());
    assert.equal(staleAfterCompletion.status, 409);
    const rows = await get('/documents');
    assert.ok(rows[0].revision > receipt.revision);
    assert.ok(afterCompletion.runs.at(-1).state_revision > currentRun.state_revision);
    evidence = {
      before,
      parallel,
      changed,
      afterCompletion,
      staleAfterCompletion,
      expected: caseId === 'F06' ? 201 : 409,
      actual: caseId === 'F06' ? parallel[0].status : staleAfterCompletion.status,
    };
    reproduced = true;
  } else if (['F08', 'F09', 'F10', 'F11'].includes(caseId)) {
    const accepted = await upload([fixture('rollback.txt', 445)]),
      before = await snapshot(),
      originalQuery = pg.Client.prototype.query;
    let injected = false,
      during;
    pg.Client.prototype.query = function (sql, args, ...rest) {
      if (
        !injected &&
        typeof sql === 'string' &&
        sql.startsWith('INSERT INTO tender_app.intake_company_revision') &&
        args?.[4]?.includes('Synthetic Rollback')
      ) {
        injected = true;
        return snapshot(this).then((s) => {
          during = s;
          throw Error('synthetic_transaction_failure_after_observation');
        });
      }
      return originalQuery.call(this, sql, args, ...rest);
    };
    try {
      await oldDrain();
    } finally {
      pg.Client.prototype.query = originalQuery;
    }
    const after = await snapshot();
    assert.ok(injected);
    assert.equal(during.counts.intake_organization_observation, 1);
    const failed = after.runs[0],
      receipt = accepted.body.outcomes[0].receiptIds[0],
      retry = await postReprocess(
        receipt,
        { expectedRunRevision: failed.state_revision, reason: 'Synthetic explicit C retry' },
        randomUUID(),
      );
    await oldDrain();
    const afterRetry = await snapshot();
    const table =
      caseId === 'F09'
        ? 'intake_batch'
        : caseId === 'F10'
          ? 'intake_document'
          : caseId === 'F11'
            ? 'intake_receipt'
            : null;
    evidence = {
      accepted,
      before,
      during,
      after,
      retry,
      afterRetry,
      expected: table ? 0 : 500,
      actual: table ? after.counts[table] : accepted.status,
      faultInjected: true,
      faultPoint: 'company_revision INSERT after organization observation in completeWorker transaction',
      forbiddenPartialWrites: [
        'intake_result',
        'intake_evidence',
        'intake_organization_result',
        'intake_organization_observation',
        'intake_company',
        'intake_identity_claim',
        'intake_review_decision',
      ].map((t) => ({ table: t, count: after.counts[t] })),
    };
    assert.ok(evidence.forbiddenPartialWrites.every((r) => r.count === 0));
    assert.equal(afterRetry.counts.intake_company, 1);
    assert.equal(afterRetry.counts.intake_identity_claim, 1);
    reproduced = table ? evidence.actual === 1 : evidence.actual === 201;
  } else if (caseId === 'F12') {
    await upload([mainFiles[1]]);
    await oldDrain();
    const company = (await pool.query('SELECT * FROM tender_app.intake_company')).rows[0],
      before = await snapshot(),
      client = await pool.connect();
    try {
      await client.query('BEGIN');
      try {
        await client.query(
          'UPDATE tender_app.intake_company SET state_revision=state_revision+1,confirmed_supplier_id=$2 WHERE id=$1',
          [company.id, randomUUID()],
        );
      } catch (e) {
        evidence.sqlError = { code: e.code, message: e.message, routine: e.routine };
      }
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    evidence = {
      ...evidence,
      before,
      after: await snapshot(),
      expected: '55000',
      actual: evidence.sqlError?.code,
      scope: 'same head guard before FK validation; no business supplier seeded',
    };
    reproduced = evidence.actual === '55000';
  }
  const businessCounts = {};
  for (const table of ['supplier', 'tender_supplier', 'offer_version', 'document', 'offer'])
    businessCounts[table] = Number(
      (await pool.query('SELECT count(*) n FROM tender_app.' + table)).rows[0].n,
    );
  assert.ok(
    Object.values(businessCounts).every((n) => n === 0),
    'business writes forbidden',
  );
  evidence.businessCounts = businessCounts;
} catch (e) {
  fatal = { name: e.name, code: e.code, message: e.message, stack: e.stack };
} finally {
  const result = {
    caseId,
    status: fatal ? 'DIAGNOSTIC_ERROR' : reproduced ? 'PASS' : 'FAIL',
    identity: run.identity,
    evidence,
    errors,
    ...(fatal ? { fatal } : {}),
    fixtureManifestSha256: sha(manifestBytes),
    modelCalls: 0,
    cleanup: 'NOT_AUTHORIZED',
  };
  await json(resolve(run.runRoot, 'C-verified-' + caseId + '.json'), result);
  await app?.close();
  await run.close(
    fatal
      ? 'DIAGNOSTIC_ERROR_RETAINED'
      : reproduced
        ? 'TARGETED_PASSED_RETAINED'
        : 'TARGETED_FAILED_RETAINED',
  );
  console.log(
    JSON.stringify({
      caseId,
      status: result.status,
      runId: run.runId,
      database: run.database,
      runRoot: run.runRoot,
    }),
  );
  if (fatal || !reproduced) process.exitCode = 1;
}
