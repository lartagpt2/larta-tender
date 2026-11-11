// Preregistered TASK-008F first-pass benchmark: new synthetic files only, no tuning, DDL or confirmations.
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { config } from 'dotenv';
import pg from 'pg';
import application from '../../apps/api/dist/application.js';
import repositories from '../../apps/api/dist/data/repository.js';
import scopes from '../../apps/api/dist/data/scope-repository.js';
import offers from '../../apps/api/dist/data/offer-repository.js';
import verifications from '../../apps/api/dist/comparison/verification-repository.js';
import stages from '../../apps/api/dist/stages/stage-repository.js';
import ai from '../../apps/api/dist/document-ai/ai-repository.js';
import adapter from '../../apps/api/dist/document-ai/ollama.js';
import prep from '../../apps/api/dist/document-ai/pages.js';
import { frozenFixtures, integrity, cases } from './freeze.mjs';
import { score, scoreRaw, aggregate } from '../task008-gate-d/scoring.mjs';
import { exclusiveJson } from './freeze.mjs';
import { criticalMetrics } from './metrics.mjs';
import { repo, workspace, json } from '../task008-gate-d/io.mjs';
const model = 'qwen3-vl:8b-instruct',
  digest = '0533d74300e4f9bc367d675d4e64ffd073d50ff16a2b4096cc2e8a1cf8c96319';
const hash = (b) => createHash('sha256').update(b).digest('hex');
function metadata(path, body) {
  return new Promise((done, fail) => {
    const bytes = body ? Buffer.from(JSON.stringify(body)) : undefined;
    const r = http.request(
      {
        hostname: '10.216.10.116',
        port: 11434,
        path,
        method: bytes ? 'POST' : 'GET',
        headers: bytes ? { 'content-type': 'application/json', 'content-length': bytes.length } : {},
      },
      (res) => {
        let size = 0;
        const chunks = [];
        res.on('data', (b) => {
          size += b.length;
          if (size > 1024 * 1024) res.destroy(new Error('metadata_limit'));
          else chunks.push(b);
        });
        res.on('error', fail);
        res.on('end', () => {
          clearTimeout(timer);
          try {
            assert.equal(res.statusCode, 200);
            done(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch {
            fail(new Error('metadata_invalid'));
          }
        });
      },
    );
    const timer = setTimeout(() => r.destroy(new Error('metadata_timeout')), 5000);
    r.on('error', (e) => {
      clearTimeout(timer);
      fail(e);
    });
    r.end(bytes);
  });
}
const live = process.argv.includes('--run-synthetic'),
  generateOnly = process.argv.includes('--generate');
if (!live && !generateOnly)
  console.log(
    'Preview only. --generate validates frozen TASK-008F files without changing them; --run-synthetic also runs the approved corporate model and test-DB queue. No arbitrary files accepted.',
  );
else {
  config({ path: resolve(repo, '.env'), quiet: true });
  if (live) assert.equal(process.env.PGDATABASE, 'larta_test_task003', 'Only approved synthetic test DB');
  const runId = new Date().toISOString().replaceAll(':', '-') + '-' + randomUUID().slice(0, 8),
    out = resolve(workspace, 'temp/task008f', runId);
  const addendumBytes = await readFile(
    resolve(repo, 'docs/evaluations/TASK-008F-preregistration-addendum.json'),
  );
  const addendum = JSON.parse(addendumBytes);
  assert.equal(
    hash(await readFile(new URL(import.meta.url))),
    addendum.runnerSha256,
    'Pre-inference runner amendment unchanged',
  );
  assert.equal(
    hash(await readFile(resolve(repo, 'docs/evaluations/TASK-008F-preregistration.json'))),
    addendum.originalManifestSha256,
  );
  let preflight;
  if (live) {
    const status = await metadata('/api/status'),
      show = await metadata('/api/show', { model }),
      tags = await metadata('/api/tags');
    assert.equal(status.cloud?.disabled, true);
    assert.ok(!show.remote_host && !show.remote_model && show.capabilities?.includes('vision'));
    assert.equal(tags.models?.find((m) => m.name === model)?.digest, digest);
    preflight = {
      at: new Date().toISOString(),
      cloud: status.cloud,
      model,
      digest,
      version: (await metadata('/api/version')).version,
    };
  }
  const holdout = false;
  if (live)
    await exclusiveJson(resolve(workspace, 'temp/task008f/primary-run-v2-claim.json'), {
      runId,
      claimedAt: new Date().toISOString(),
      note: 'One primary pass only; do not delete claim or cherry-pick retries.',
    });
  await integrity();
  const fixtures = (await frozenFixtures()).filter((c) => !!c.holdout === holdout),
    prepared = [];
  for (const c of fixtures) {
    const pages = await prep.documentPages(await readFile(c.path), 'application/pdf');
    assert.equal(pages.length, c.pages, c.id + ' page count');
    if (c.kind === 'native') {
      assert.ok(pages.every((p) => p.text && !p.image));
      const text = pages.map((p) => p.text).join('\n');
      for (const item of c.items) assert.ok(text.includes(item.description), c.id + ' fixture text');
      assert.ok(text.includes(c.headers.supplierName));
    } else assert.ok(pages.every((p) => !p.text && p.image));
    prepared.push({
      id: c.id,
      pages: pages.length,
      vision: pages.some((p) => p.image),
      characters: pages.reduce((n, p) => n + p.text.length, 0),
      fingerprint: hash(JSON.stringify(pages)),
    });
  }
  await json(resolve(out, 'prepared.json'), prepared);
  console.log(
    JSON.stringify({
      phase: 'fixtures_validated',
      out,
      documents: fixtures.length,
      pages: prepared.reduce((n, p) => n + p.pages, 0),
      live,
      preflight,
    }),
  );
  if (live) {
    const pool = new pg.Pool({ max: 5, connectionTimeoutMillis: 5000, statement_timeout: 10000 }),
      token = randomBytes(32).toString('hex'),
      actor = process.env.DEV_ACTOR_ID;
    const trace = [],
      local = new adapter.OllamaDocumentAI({
        baseUrl: 'http://10.216.10.116:11434',
        model,
        digest,
        timeoutMs: 120000,
      });
    let active = 0,
      maxActive = 0,
      release;
    const barrier = new Promise((r) => {
      release = r;
    });
    const provider = {
      async extract(pages) {
        const id = prepared.find((p) => p.fingerprint === hash(JSON.stringify(pages)))?.id;
        assert.ok(id, 'Only generated fixtures reach inference');
        await barrier;
        const event = { id, start: new Date().toISOString() };
        trace.push(event);
        active++;
        maxActive = Math.max(maxActive, active);
        console.log(JSON.stringify({ phase: 'inference_start', id, active }));
        try {
          return await local.extract(pages);
        } finally {
          active--;
          event.end = new Date().toISOString();
          event.durationMs = Date.parse(event.end) - Date.parse(event.start);
          await json(resolve(out, 'trace.json'), trace);
          console.log(JSON.stringify({ phase: 'inference_end', ...event }));
        }
      },
    };
    const malformed = Buffer.from('%PDF-1.7\n% SYNTHETIC TASK-008F intentionally truncated fixture\n');
    const aiRepo = new ai.PgAIRepository(pool, {
      enabled: true,
      storageRoot: process.env.STORAGE_ROOT,
      jobRoot: resolve(out, 'jobs'),
      workspace,
      syntheticHashes: [...fixtures.map((c) => c.sha256), hash(malformed)],
      provider,
      model,
      digest,
      baseUrl: 'http://10.216.10.116:11434',
      timeoutMs: 120000,
    });
    const app = await application.createApplication({
      logger: false,
      environment: 'test',
      data: {
        enabled: true,
        token,
        actorId: actor,
        repository: new repositories.PgTenderRepository(pool),
        scopeRepository: new scopes.PgScopeRepository(pool),
        offerRepository: new offers.PgOfferRepository(pool),
        verificationRepository: new verifications.PgVerificationRepository(pool),
        stageRepository: new stages.PgStageRepository(pool),
        aiRepository: aiRepo,
      },
    });
    const req = async (method, url, payload, expected = method === 'POST' ? 201 : 200) => {
      const r = await app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload });
      assert.equal(r.statusCode, expected, url);
      return r.json();
    };
    const jobs = [],
      results = [];
    let base, start;
    try {
      const migration = (
        await pool.query(
          "SELECT sha256 FROM tender_app.schema_migrations WHERE name='002_domain_foundation.sql'",
        )
      ).rows[0]?.sha256;
      assert.equal(
        migration,
        hash(await readFile(resolve(repo, 'infra/migrations/002_domain_foundation.sql'))),
      );
      await app.init();
      await app.getHttpAdapter().getInstance().ready();
      const tender = await req('POST', '/api/tenders', {
        title: 'СИНТЕТИЧЕСКИЙ TASK-008F — пакет русских КП ' + runId,
      });
      base = '/api/tenders/' + tender.id;
      const lot = await req('POST', base + '/verification/lot', { expectedRevision: tender.revision });
      const queueFixtures = [...fixtures];
      queueFixtures.splice(Math.floor(fixtures.length / 2), 0, { id: 'ru-malformed', bytes: malformed });
      for (let offset = 0; offset < queueFixtures.length; offset += 8) {
        const batch = queueFixtures.slice(offset, offset + 8),
          boundary = 'gate-f-' + randomUUID(),
          chunks = [];
        for (const c of batch)
          chunks.push(
            Buffer.from(
              `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${c.id}.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
            ),
            c.bytes ?? (await readFile(c.path)),
            Buffer.from('\r\n'),
          );
        chunks.push(Buffer.from(`--${boundary}--\r\n`));
        const uploaded = await app.inject({
          method: 'POST',
          url: base + '/offers/batches',
          headers: {
            authorization: `Bearer ${token}`,
            'idempotency-key': randomUUID(),
            'content-type': `multipart/form-data; boundary=${boundary}`,
          },
          payload: Buffer.concat(chunks),
        });
        assert.equal(uploaded.statusCode, 201);
        assert.equal(uploaded.json().outcomes.length, batch.length);
        assert.ok(uploaded.json().outcomes.every((o) => o.documents?.length === 1));
      }
      const ctx = await req('GET', base + '/verification');
      assert.equal(ctx.documents.length, fixtures.length + 1);
      start = performance.now();
      for (const c of queueFixtures) {
        const doc = ctx.documents.find((d) => d.name === c.id + '.pdf');
        assert.ok(doc);
        const input = { documentId: doc.id, receiptId: doc.receipts[0].id, lotId: lot.id, kind: 'offer' };
        const job = await req('POST', base + '/document-ai', input);
        assert.equal((await req('POST', base + '/document-ai', input)).id, job.id);
        jobs.push({ caseId: c.id, id: job.id, documentId: doc.id, receiptId: doc.receipts[0].id });
      }
      const before = await Promise.all(jobs.map((j) => req('GET', base + '/document-ai/' + j.id)));
      assert.equal(
        before.filter((j) => j.status === 'pending' || j.status === 'running').length,
        fixtures.length + 1,
      );
      await json(resolve(out, 'submission.json'), {
        runId,
        base,
        jobs,
        queuedStatuses: before.map((j) => ({ id: j.id, status: j.status })),
      });
      console.log(
        JSON.stringify({
          phase: 'queue_submitted',
          jobs: jobs.length,
          pending: before.filter((j) => j.status === 'pending').length,
          running: before.filter((j) => j.status === 'running').length,
          idempotent: true,
        }),
      );
      release();
      const deadline = Date.now() + 20 * 60 * 1000,
        finished = new Set();
      let peakRunning = 0,
        peakPending = 0;
      while (finished.size < jobs.length && Date.now() < deadline) {
        const current = await Promise.all(jobs.map((j) => req('GET', base + '/document-ai/' + j.id)));
        peakRunning = Math.max(peakRunning, current.filter((j) => j.status === 'running').length);
        peakPending = Math.max(peakPending, current.filter((j) => j.status === 'pending').length);
        for (let i = 0; i < current.length; i++) {
          const job = current[i],
            entry = jobs[i];
          if (['pending', 'running'].includes(job.status) || finished.has(job.id)) continue;
          finished.add(job.id);
          await json(resolve(out, entry.caseId + '-job.json'), job);
          if (entry.caseId === 'ru-malformed') {
            assert.equal(job.status, 'failed');
            assert.equal(job.error, 'document_parse_failed');
            continue;
          }
          const gold = cases.find((c) => c.id === entry.caseId),
            result = { ...score(gold, job), rawScore: scoreRaw(gold, job) },
            running = job.events.find((e) => e.status === 'running'),
            terminal = job.events.at(-1);
          Object.assign(result, {
            kind: gold.kind,
            pages: gold.pages,
            sourceSha: job.sourceSha,
            model: job.result?.model ?? null,
            digest: job.result?.digest ?? null,
            createdAt: job.createdAt,
            startAt: running?.at,
            endAt: terminal.at,
            queueWaitMs: Date.parse(running.at) - Date.parse(job.createdAt),
            processingMs: Date.parse(terminal.at) - Date.parse(running.at),
            inferenceMs: job.result?.durationMs ?? null,
            totalMs: Date.parse(terminal.at) - Date.parse(job.createdAt),
            attempts: job.attempts,
          });
          results.push(result);
          await json(resolve(out, 'results-checkpoint.json'), {
            runId,
            preflight,
            summary: aggregate(results),
            summaryRaw: aggregate(results.map((r) => r.rawScore)),
            results,
          });
          console.log(
            JSON.stringify({
              phase: 'document_scored',
              id: result.id,
              status: result.status,
              known: `${result.knownCorrect}/${result.knownTotal}`,
              supplier: result.supplierCorrect,
              rows: `${result.actualRows}/${result.expectedRows}`,
              processingMs: result.processingMs,
              errors: result.errors.length,
            }),
          );
        }
        if (finished.size < jobs.length) await delay(1000);
      }
      assert.equal(finished.size, jobs.length, 'Every queued job must reach terminal state');
      assert.equal(maxActive, 1, 'Model concurrency must stay one');
      assert.ok(peakPending >= Math.min(3, fixtures.length));
      assert.ok(peakRunning <= 1);
      const terminalJobs = await Promise.all(jobs.map((j) => req('GET', base + '/document-ai/' + j.id)));
      const processingOrder = terminalJobs
        .sort(
          (a, b) =>
            a.events
              .find((e) => e.status === 'running')
              .at.localeCompare(b.events.find((e) => e.status === 'running').at) ||
            a.createdAt.localeCompare(b.createdAt) ||
            a.id.localeCompare(b.id),
        )
        .map((j) => jobs.find((x) => x.id === j.id).caseId);
      assert.deepEqual(
        processingOrder,
        jobs.map((j) => j.caseId),
        'FIFO must preserve submission order including the failed job',
      );
      assert.deepEqual(
        trace.map((t) => t.id),
        fixtures.map((c) => c.id),
        'No later model job can jump the queue',
      );
      // Audit original bytes and one-attempt draft-only behavior in this new run.
      let originalsVerified = 0;
      for (const entry of jobs) {
        const job = await req('GET', base + '/document-ai/' + entry.id);
        assert.equal(job.attempts, 1, 'No selective retries in the primary pass');
        if (entry.caseId !== 'ru-malformed' && job.result) assert.equal(job.status, 'needs_review');
        const response = await app.inject({
          method: 'GET',
          url: base + '/offers/' + entry.documentId + '/original',
          headers: { authorization: `Bearer ${token}` },
        });
        assert.equal(response.statusCode, 200);
        assert.equal(hash(response.rawPayload), job.sourceSha);
        if (entry.caseId !== 'ru-malformed')
          assert.equal(job.sourceSha, fixtures.find((c) => c.id === entry.caseId).sha256);
        originalsVerified++;
      }
      const final = await req('GET', base + '/verification');
      assert.equal(final.offers.length, 0, 'No AI price confirmations');
      assert.equal(
        Number(
          (await pool.query('SELECT count(*) FROM tender_app.stage_response WHERE tender_id=$1', [tender.id]))
            .rows[0].count,
        ),
        0,
      );
      assert.equal(
        (
          await pool.query(
            "SELECT sha256 FROM tender_app.schema_migrations WHERE name='002_domain_foundation.sql'",
          )
        ).rows[0].sha256,
        migration,
      );
      // A new repository can read completed jobs without memory from the processing instance.
      const reloaded = new ai.PgAIRepository(pool, {
        enabled: false,
        storageRoot: process.env.STORAGE_ROOT,
        jobRoot: resolve(out, 'jobs'),
        workspace,
        syntheticHashes: [],
      });
      for (const j of jobs) assert.ok(await reloaded.get(actor, tender.id, j.id));
      const latencies = results.map((r) => r.processingMs).sort((a, b) => a - b),
        percentile = (p) => latencies[Math.ceil(p * latencies.length) - 1];
      const report = {
        version: 'task008f-primary-v1',
        runId,
        at: new Date().toISOString(),
        baseCommit: '93b8e914e943089b765174b23636f0d3e795767d',
        preflight,
        corpus: {
          documents: fixtures.length,
          native: fixtures.filter((c) => c.kind === 'native').length,
          scan: fixtures.filter((c) => c.kind === 'scan').length,
          pages: prepared.reduce((n, p) => n + p.pages, 0),
          validations: prepared,
        },
        criticalFields: criticalMetrics(results),
        summary: aggregate(results),
        summaryRaw: aggregate(results.map((r) => r.rawScore)),
        queue: {
          submitted: jobs.length,
          validDocuments: fixtures.length,
          expectedMalformed: 1,
          maxActive,
          peakRunning,
          peakPending,
          wallMs: Math.round(performance.now() - start),
          processingP50Ms: percentile(0.5),
          processingP95Ms: percentile(0.95),
          allTerminal: true,
          fifo: true,
          submissionOrder: jobs.map((j) => j.caseId),
          processingOrder,
          idempotency: true,
          persistedReload: true,
          originalsVerified,
          confirmedOffers: 0,
          stageResponses: 0,
          order: trace.map((t) => t.id),
          trace,
        },
        results: results.sort(
          (a, b) => cases.findIndex((c) => c.id === a.id) - cases.findIndex((c) => c.id === b.id),
        ),
      };
      report.criticalFields = criticalMetrics(results);
      await exclusiveJson(resolve(out, 'results.json'), report);
      const manifestBytes = await readFile(resolve(repo, 'docs/evaluations/TASK-008F-preregistration.json'));
      await exclusiveJson(resolve(repo, 'docs/evaluations/TASK-008F-primary.json'), {
        ...report,
        preregistrationSha256: hash(manifestBytes),
        preregistrationAddendumSha256: hash(addendumBytes),
      });
      await exclusiveJson(resolve(repo, 'docs/evaluations/TASK-008F-primary-seal.json'), {
        frozenAt: new Date().toISOString(),
        sha256: hash(await readFile(resolve(repo, 'docs/evaluations/TASK-008F-primary.json'))),
        out,
      });
      await json(
        resolve(workspace, 'temp/task008f/groups', holdout ? 'holdout.json' : 'results.json'),
        report,
      );
      await integrity();
      console.log(
        JSON.stringify({ phase: 'finished', out, summary: report.summary, queue: report.queue }, null, 2),
      );
    } finally {
      release();
      await aiRepo.close();
      await app.close();
      await pool.end();
    }
  }
}
