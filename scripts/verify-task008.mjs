import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { config } from 'dotenv';
import pg from 'pg';
import application from '../apps/api/dist/application.js';
import repositories from '../apps/api/dist/data/repository.js';
import scopes from '../apps/api/dist/data/scope-repository.js';
import offers from '../apps/api/dist/data/offer-repository.js';
import verifications from '../apps/api/dist/comparison/verification-repository.js';
import stages from '../apps/api/dist/stages/stage-repository.js';
import ai from '../apps/api/dist/document-ai/ai-repository.js';
import contracts from '../apps/api/dist/document-ai/contracts.js';
import stores from '../apps/api/dist/document-ai/job-store.js';
import prep from '../apps/api/dist/document-ai/pages.js';
import { gold, quotePdf } from './task008-fixtures.mjs';
const root = fileURLToPath(new URL('../', import.meta.url)),
  workspace = resolve(root, '..');
if (!process.argv.includes('--run'))
  console.log(
    'Preview only. --run uses approved larta_test_task003, mock model and synthetic fixtures; no migrations.',
  );
else {
  config({ path: resolve(root, '.env'), quiet: true });
  if (process.env.PGDATABASE !== 'larta_test_task003') throw new Error('Approved test DB required');
  const pool = new pg.Pool({ connectionTimeoutMillis: 5000, statement_timeout: 10000 }),
    apps = [],
    actor = randomUUID(),
    reviewer = randomUUID(),
    outsider = randomUUID(),
    token = randomBytes(32).toString('hex'),
    headers = { authorization: `Bearer ${token}` };
  const native = quotePdf(),
    scan = quotePdf(true),
    later = quotePdf(false, 0.9),
    hash = (b) => createHash('sha256').update(b).digest('hex'),
    runRoot = resolve(workspace, 'temp/task008-integration', randomUUID());
  let mode = 'normal';
  let calls = 0,
    fail = false;
  const field = (value, page, snippet) => ({
    ...contracts.emptyField(),
    rawValue: value,
    value,
    page,
    evidenceSnippet: snippet,
  });
  const provider = {
    async extract(pages) {
      calls++;
      if (fail) throw new Error('local_ai_unavailable');
      const d = contracts.emptyDraft();
      const text = pages
          .map((p) => p.text)
          .join('\n')
          .trim(),
        source = text || 'Synthetic raster evidence';
      d.supplierName = field(gold.supplierName, 1, text ? `Seller: ${gold.supplierName}` : source);
      d.buyerName = field(gold.buyerName, 1, text ? `Buyer: ${gold.buyerName}` : source);
      const tax = text.match(/Seller tax ID: (\d+)/)?.[1] ?? gold.taxId;
      d.taxId =
        mode === 'omit-tax' ? contracts.emptyField() : field(tax, 1, text ? `Seller tax ID: ${tax}` : source);
      d.email = field(gold.email, 1, text ? `Email printed in document: ${gold.email}` : source);
      d.currency = field(
        'RUB',
        2,
        text ? `Grand total: ${text.includes('1260 RUB') ? '1260' : '1400'} RUB` : source,
      );
      d.total = field(text.includes('1260 RUB') ? '1260' : '1400', 2, d.currency.evidenceSnippet);
      const factor = text.includes('1260 RUB') ? 0.9 : 1;
      d.items = gold.items.map((item) => {
        const row = Object.fromEntries(contracts.itemNames.map((k) => [k, contracts.emptyField()]));
        const snippet = text
          ? pages
              .find((p) => p.page === item.page)
              .text.split('\n')
              .find((s) => s.startsWith(item.name))
          : source;
        for (const [key, value] of Object.entries({
          description: item.name,
          quantity: item.quantity,
          unit: item.unit,
          unitPrice: String(Number(item.unitPrice) * factor),
          lineTotal: String(Number(item.lineTotal) * factor),
          currency: 'RUB',
          delivery: item.delivery,
        }))
          row[key] = field(value, item.page, snippet);
        return row;
      });
      const checked = contracts.validateDraft(
        d,
        pages,
        pages.some((p) => p.image),
      );
      return { ...checked, model: 'mock/qwen3-vl', digest: 'synthetic-digest', durationMs: 1 };
    },
  };
  const options = {
    enabled: true,
    storageRoot: process.env.STORAGE_ROOT,
    jobRoot: runRoot,
    workspace,
    syntheticHashes: [native, scan, later].map(hash),
    provider,
    digest: 'synthetic-digest',
  };
  const make = async (user, enabled = true) => {
    const aiRepo = new ai.PgAIRepository(pool, { ...options, enabled });
    const app = await application.createApplication({
      logger: false,
      environment: 'test',
      data: {
        enabled: true,
        token,
        actorId: user,
        repository: new repositories.PgTenderRepository(pool),
        scopeRepository: new scopes.PgScopeRepository(pool),
        offerRepository: new offers.PgOfferRepository(pool),
        verificationRepository: new verifications.PgVerificationRepository(pool),
        stageRepository: new stages.PgStageRepository(pool),
        aiRepository: aiRepo,
      },
    });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    apps.push(app);
    return { app, aiRepo };
  };
  let phase = 'setup';
  try {
    assert.equal(
      (
        await pool.query(
          "SELECT sha256 FROM tender_app.schema_migrations WHERE name='002_domain_foundation.sql'",
        )
      ).rows[0]?.sha256,
      hash(await readFile(resolve(root, 'infra/migrations/002_domain_foundation.sql'))),
    );
    for (const user of [actor, reviewer, outsider])
      await pool.query('INSERT INTO tender_app.app_user(id,external_subject,display_name) VALUES($1,$2,$3)', [
        user,
        `synthetic:008:${user}`,
        'Synthetic AI reviewer',
      ]);
    const { app: owner, aiRepo } = await make(actor),
      { app: readOnly } = await make(reviewer, false),
      { app: other } = await make(outsider, false),
      { app: disabled } = await make(actor, false);
    const req = (app, method, url, payload) => app.inject({ method, url, headers, payload });
    const r = await req(owner, 'POST', '/api/tenders', { title: 'Synthetic TASK008 isolated AI drafts' });
    assert.equal(r.statusCode, 201);
    const id = r.json().id,
      base = `/api/tenders/${id}`;
    await pool.query(
      "INSERT INTO tender_app.tender_member(tender_id,user_id,role) VALUES($1,$2,'reviewer')",
      [id, reviewer],
    );
    const lot = (await req(owner, 'POST', base + '/verification/lot', { expectedRevision: 1 })).json().id;
    const upload = async (bytes, purpose = 'offer', stage) => {
      const boundary = 'fixture-' + randomUUID();
      const r = await owner.inject({
        method: 'POST',
        url: base + (purpose === 'offer' ? '/offers/batches' : '/tz'),
        headers: {
          ...headers,
          'idempotency-key': randomUUID(),
          'content-type': `multipart/form-data; boundary=${boundary}`,
          ...(stage ? { 'x-tender-stage-id': stage } : {}),
        },
        payload: Buffer.concat([
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="${purpose === 'offer' ? 'files' : 'file'}"; filename="synthetic.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
          ),
          bytes,
          Buffer.from(`\r\n--${boundary}--\r\n`),
        ]),
      });
      assert.equal(r.statusCode, 201);
      return purpose === 'offer' ? r.json().outcomes[0].documents[0] : r.json().id;
    };
    const doc = await upload(native);
    await upload(native);
    const suppliers = [];
    for (const name of [gold.supplierName, 'Synthetic Supplier Other']) {
      const docs = (await req(owner, 'GET', base + '/offers')).json();
      const r = await req(owner, 'PATCH', base + `/offers/${doc}/association`, {
        revision: docs[0].revision,
        newSupplier: { name, registrationNumber: name === gold.supplierName ? gold.taxId : undefined },
        note: 'Synthetic supplier explicit buyer action',
      });
      assert.equal(r.statusCode, 200);
      suppliers.push(r.json().supplierId);
    }
    const context = (await req(owner, 'GET', base + '/verification')).json(),
      receipts = context.documents[0].receipts;
    const input = {
      kind: 'offer',
      documentId: doc,
      receiptId: receipts[0].id,
      supplierId: suppliers[0],
      lotId: lot,
    };
    phase = 'permissions and boundaries';
    assert.equal((await req(readOnly, 'POST', base + '/document-ai', input)).statusCode, 403);
    assert.equal((await req(other, 'GET', base + '/document-ai')).statusCode, 404);
    assert.equal((await req(disabled, 'POST', base + '/document-ai', input)).statusCode, 503);
    assert.equal(
      (await req(owner, 'POST', base + '/document-ai', { ...input, receiptId: randomUUID() })).statusCode,
      400,
    );
    assert.equal(
      (await req(owner, 'POST', base + '/document-ai', { ...input, lotId: randomUUID() })).statusCode,
      400,
    );
    const unapproved = await upload(Buffer.from('%PDF-1.7\n% Synthetic unapproved original'));
    assert.equal(
      (await req(owner, 'POST', base + '/document-ai', { ...input, documentId: unapproved })).statusCode,
      400,
    );
    phase = 'draft and persistence';
    const queued = await req(owner, 'POST', base + '/document-ai', input);
    assert.equal(queued.statusCode, 201);
    const jobId = queued.json().id;
    const replay = await req(owner, 'POST', base + '/document-ai', input);
    assert.equal(replay.statusCode, 201);
    assert.equal(replay.json().id, jobId);
    async function finished(jobId) {
      for (let n = 0; n < 100; n++) {
        const result = await req(owner, 'GET', base + '/document-ai/' + jobId);
        assert.equal(result.statusCode, 200);
        const j = result.json();
        if (!['pending', 'running'].includes(j.status)) return j;
        await delay(100);
      }
      throw new Error('synthetic_job_timeout');
    }
    let job = await finished(jobId);
    assert.equal(job.status, 'needs_review');
    assert.equal(job.result.draft.items.length, 7);
    assert.equal(job.result.draft.supplierName.value, gold.supplierName);
    assert.equal(job.result.draft.buyerName.value, gold.buyerName);
    assert.equal(job.result.draft.total.value, '1400');
    assert.equal(job.result.draft.email.value, gold.email);
    assert.equal(job.result.draft.taxId.sourceDocumentId, doc);
    assert.equal(job.matches[0].id, suppliers[0]);
    assert.ok(!job.warnings.includes('total_arithmetic_mismatch'));
    for (const item of job.result.draft.items) assert.equal(item.unitPrice.confidence, null);
    assert.equal((await req(owner, 'GET', base + '/verification')).json().offers.length, 0);
    let comparison = (await req(owner, 'GET', base + '/comparison')).json();
    assert.equal(comparison.columns.length, 0);
    const verifiedFields = {
      amount: '1400',
      currency: 'RUB',
      vatMode: 'included',
      paymentTerms: 'After delivery',
      deliveryTerms: '7 days',
      compliance: 'matches',
    };
    const manual = {
      supplierId: suppliers[0],
      lotId: lot,
      documentId: doc,
      receiptId: receipts[0].id,
      expectedVersion: 0,
      contextConfirmed: true,
      intent: 'draft',
      fields: verifiedFields,
      original: verifiedFields,
      sourceType: 'document',
      sourceNote: 'Synthetic explicit transfer from AI draft',
      items: [],
      costs: [],
      costsEnabled: false,
      newQuestions: [],
      resolveQuestionIds: [],
    };
    const saved = await req(owner, 'POST', base + `/document-ai/${jobId}/review`, {
      revision: job.revision,
      fields: { payment: 'Edited synthetic payment' },
      note: 'Synthetic manual draft edit',
      verification: manual,
    });
    assert.equal(saved.statusCode, 201);
    assert.equal(
      (
        await req(owner, 'POST', base + `/document-ai/${jobId}/review`, {
          revision: job.revision,
          fields: {},
          note: 'Stale edit',
        })
      ).statusCode,
      409,
    );
    assert.equal((await req(owner, 'GET', base + '/verification')).json().offers.length, 0);
    job = await finished(jobId);
    assert.equal(job.reviews.at(-1).verification.fields.amount, '1400');
    assert.equal(job.result.draft.payment.value, null);
    assert.equal(
      (
        await req(readOnly, 'POST', base + `/document-ai/${jobId}/review`, {
          revision: job.revision,
          fields: {},
          note: 'Forbidden',
        })
      ).statusCode,
      403,
    );
    phase = 'independent receipts and supplier context';
    const independent = await req(owner, 'POST', base + '/document-ai', {
      ...input,
      receiptId: receipts[1].id,
      supplierId: suppliers[1],
    });
    assert.equal(independent.statusCode, 201);
    assert.notEqual(independent.json().id, jobId);
    const b = await finished(independent.json().id);
    assert.equal(b.supplierId, suppliers[1]);
    assert.equal(b.reviews.length, 0);
    assert.ok(b.warnings.includes('candidate_differs_selected_supplier'));
    phase = 'manual confirmation and stages';
    const confirmed = await req(owner, 'POST', base + '/verification', { ...manual, intent: 'confirm' });
    assert.equal(confirmed.statusCode, 201);
    const offer = confirmed.json();
    const rev = (await req(owner, 'GET', base + '/scope')).json().revision;
    const stage = (
      await req(owner, 'POST', base + '/stages', {
        kind: 'negotiation',
        label: 'Synthetic AI second stage',
        comment: 'Synthetic',
        expectedRevision: rev,
      })
    ).json().id;
    const laterDoc = await upload(later, 'offer', stage),
      newContext = (await req(owner, 'GET', base + '/verification')).json(),
      laterReceipt = newContext.documents.find((d) => d.id === laterDoc).receipts.at(-1).id;
    const laterJob = await req(owner, 'POST', base + '/document-ai', {
      ...input,
      documentId: laterDoc,
      receiptId: laterReceipt,
    });
    assert.equal(laterJob.statusCode, 201);
    const next = await finished(laterJob.json().id);
    assert.equal(next.stageId, stage);
    assert.equal(next.result.draft.total.value, '1260');
    const after = (await req(owner, 'GET', base + '/verification')).json().offers[0];
    assert.equal(after.versions.at(-1).id, offer.versionId);
    assert.equal(after.versions.find((v) => v.isInitial).amount, '1400.000000');
    assert.equal(
      (await pool.query('SELECT count(*) FROM tender_app.stage_response WHERE tender_id=$1', [id])).rows[0]
        .count,
      '0',
    );
    comparison = (await req(owner, 'GET', base + '/comparison')).json();
    assert.equal(comparison.rows.find((r) => r.key === 'current').values[0], '1400 RUB');
    phase = 'vision, deterministic specification, failure and retry';
    const scanDoc = await upload(scan),
      scanContext = (await req(owner, 'GET', base + '/verification')).json(),
      scanReceipt = scanContext.documents.find((d) => d.id === scanDoc).receipts[0].id;
    const scanJob = await req(owner, 'POST', base + '/document-ai', {
      ...input,
      documentId: scanDoc,
      receiptId: scanReceipt,
    });
    assert.equal((await finished(scanJob.json().id)).status, 'needs_review');
    const tz = await upload(
      await readFile(resolve(root, 'tests/fixtures/tz-seven-items.pdf')),
      'specification',
    );
    options.syntheticHashes.push(hash(await readFile(resolve(root, 'tests/fixtures/tz-seven-items.pdf'))));
    const callsBefore = calls;
    const tzJob = await req(owner, 'POST', base + '/document-ai', { kind: 'specification', documentId: tz });
    assert.equal(tzJob.statusCode, 201);
    const tzDraft = await finished(tzJob.json().id);
    assert.equal(tzDraft.result.model, 'native-pdfjs-6.5.438');
    assert.equal(tzDraft.result.digest, null);
    assert.equal(tzDraft.result.draft.items.length, 7);
    assert.equal(calls, callsBefore);
    assert.equal((await req(owner, 'GET', base + '/scope')).json().items.length, 0);
    fail = true;
    const retry = await req(owner, 'POST', base + '/document-ai', { ...input, retryOf: jobId });
    assert.equal(retry.statusCode, 201);
    const failed = await finished(retry.json().id);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error, 'local_ai_unavailable');
    assert.equal((await req(owner, 'GET', base + `/offers/${doc}/original`)).statusCode, 200);
    fail = false;
    const retryAgain = await req(owner, 'POST', base + '/document-ai', { ...input, retryOf: failed.id });
    const recovered = await finished(retryAgain.json().id);
    assert.equal(recovered.status, 'needs_review');
    assert.equal((await finished(jobId)).reviews.length, 1);
    phase = 'candidate ambiguity and document email is not From';
    assert.equal(
      (await pool.query('SELECT count(*) FROM tender_app.contact WHERE tender_id=$1 AND verified', [id]))
        .rows[0].count,
      '0',
    );
    assert.equal((await req(owner, 'GET', base + '/offers')).json().find((d) => d.id === doc).email, null);
    const unknownBytes = Buffer.from(native.toString('latin1').replace(gold.taxId, '1111111111'), 'latin1');
    options.syntheticHashes.push(hash(unknownBytes));
    const unknownDoc = await upload(unknownBytes),
      unknownContext = (await req(owner, 'GET', base + '/verification')).json(),
      unknownReceipt = unknownContext.documents.find((d) => d.id === unknownDoc).receipts[0].id;
    const unknown = await req(owner, 'POST', base + '/document-ai', {
      ...input,
      documentId: unknownDoc,
      receiptId: unknownReceipt,
    });
    const unknownDraft = await finished(unknown.json().id);
    assert.equal(unknownDraft.matches.length, 0);
    assert.equal(unknownDraft.result.draft.taxId.value, '1111111111');
    const currentDoc = (await req(owner, 'GET', base + '/offers')).json().find((d) => d.id === doc);
    assert.equal(
      (
        await req(owner, 'PATCH', base + `/offers/${doc}/association`, {
          revision: currentDoc.revision,
          newSupplier: { name: gold.supplierName },
          note: 'Synthetic duplicate-name ambiguity',
        })
      ).statusCode,
      200,
    );
    mode = 'omit-tax';
    const ambiguous = await req(owner, 'POST', base + '/document-ai', { ...input, retryOf: recovered.id });
    const ambiguousDraft = await finished(ambiguous.json().id);
    assert.equal(ambiguousDraft.matches.length, 2);
    assert.ok(ambiguousDraft.warnings.includes('supplier_unresolved_or_ambiguous'));
    mode = 'normal';
    phase = 'malformed synthetic PDF';
    const brokenBytes = Buffer.from('%PDF-1.7\nSYNTHETIC broken document');
    options.syntheticHashes.push(hash(brokenBytes));
    const brokenDoc = await upload(brokenBytes),
      brokenContext = (await req(owner, 'GET', base + '/verification')).json(),
      brokenReceipt = brokenContext.documents.find((d) => d.id === brokenDoc).receipts[0].id;
    const broken = await req(owner, 'POST', base + '/document-ai', {
      ...input,
      documentId: brokenDoc,
      receiptId: brokenReceipt,
    });
    const brokenDraft = await finished(broken.json().id);
    assert.equal(brokenDraft.status, 'failed');
    assert.equal(brokenDraft.error, 'document_parse_failed');
    assert.equal((await req(owner, 'GET', base + `/offers/${brokenDoc}/original`)).statusCode, 200);
    phase = 'restart recovery';
    await aiRepo.close();
    const state = new stores.JobStore(runRoot, workspace);
    const interrupted = await state.read(recovered.id);
    interrupted.status = 'running';
    await state.write(interrupted);
    const restarted = new ai.PgAIRepository(pool, options);
    await restarted.start();
    for (let n = 0; n < 100; n++) {
      if ((await state.read(interrupted.id)).status === 'needs_review') break;
      await delay(100);
    }
    assert.equal((await state.read(interrupted.id)).status, 'needs_review');
    await restarted.close();
    assert.equal((await req(other, 'GET', base + '/document-ai/' + jobId)).statusCode, 404);
    const prepared = await prep.documentPages(native, 'application/pdf');
    assert.equal(prepared.length, 2);
    assert.ok(prepared[0].text.includes(gold.buyerName));
    console.log(
      'PASS TASK008: mock/native/vision, seven rows on two pages, supplier vs buyer, evidence/digest, per-receipt drafts, draft save/restart/idempotency, explicit manual confirmation only, immutable initial/stage price, failure/retry, synthetic SHA policy, RBAC and 409. No migrations.',
    );
  } catch (error) {
    console.error('TASK008 failed during ' + phase + ' (' + (error.code ?? error.name) + ')');
    throw error;
  } finally {
    for (const app of apps) await app.close();
    await pool.end();
  }
}
