// No inference or DB: rescore sealed jobs and verify native-header provenance against original pages.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import prep from '../../apps/api/dist/document-ai/pages.js';
import { repo, checked } from '../task008-gate-d/io.mjs';
import { cases, integrity, frozenFixtures, exclusiveJson, preserveF } from './baseline.mjs';
import { score, aggregate } from '../task008-gate-d/scoring.mjs';
import { criticalMetrics } from '../task008f/metrics.mjs';
import { priceCurrency } from './metrics.mjs';
const read = async (p) => JSON.parse(await readFile(await checked(p), 'utf8'));
const sha = async (p) =>
  createHash('sha256')
    .update(await readFile(await checked(p)))
    .digest('hex');
await integrity();
const p = await read(resolve(repo, 'docs/evaluations/TASK-008G-primary.json'));
const seal = await read(resolve(repo, 'docs/evaluations/TASK-008G-primary-seal.json'));
assert.equal(await sha(resolve(repo, 'docs/evaluations/TASK-008G-primary.json')), seal.sha256);
assert.equal(
  await sha(resolve(repo, 'docs/evaluations/TASK-008G-preregistration.json')),
  p.preregistrationSha256,
);
const scores = [],
  details = [];
let provenances = 0;
for (const c of await frozenFixtures()) {
  const job = await read(resolve(seal.out, c.id + '-job.json')),
    r = p.results.find((r) => r.id === c.id);
  const s = score(c, job);
  scores.push(s);
  for (const [k, v] of Object.entries(s)) assert.deepEqual(r[k], v, c.id + '.' + k);
  assert.equal(job.sourceSha, c.sha256);
  assert.equal(job.attempts, 1);
  assert.equal(job.reviews.length, 0);
  if (job.result) assert.equal(job.status, 'needs_review');
  const pages = await prep.documentPages(await readFile(c.path), 'application/pdf');
  for (const item of job.result?.draft.items ?? []) {
    const h = item.currency.currencySource;
    if (!h) continue;
    const page = pages.find((p) => p.page === h.page),
      rowPage = pages.find((p) => p.page === h.rowPage);
    assert.equal(h.sourceDocumentId, job.documentId);
    assert.equal(item.currency.value, h.code);
    assert.equal(page.text.split(/\r?\n/)[h.line - 1], h.excerpt);
    assert.ok(rowPage.text.split(/\r?\n/)[h.rowLine - 1].includes(item.description.value));
    provenances++;
  }
  details.push({
    id: c.id,
    kind: c.kind,
    status: job.status,
    knownCorrect: r.knownCorrect,
    knownTotal: r.knownTotal,
    rowCounts: [r.actualRows, r.expectedRows],
    processingMs: r.processingMs,
    queueWaitMs: r.queueWaitMs,
    warnings: r.warnings,
    errors: r.errors,
    rows: (job.result?.draft.items ?? []).map((i) => ({
      description: i.description.value,
      original: i.description.rawValue,
      price: i.unitPrice.value,
      currency: i.currency.value,
      provenance: i.currency.currencySource ?? null,
    })),
  });
}
assert.deepEqual(aggregate(scores), p.summary);
assert.deepEqual(criticalMetrics(scores), p.criticalFields);
assert.deepEqual(priceCurrency(scores, cases), p.priceCurrency);
assert.equal(p.priceCurrency.knownPairs.total, 18);
assert.equal(p.priceCurrency.pricedUnknownCurrency.total, 5);
assert.deepEqual(p.queue.submissionOrder, p.queue.processingOrder);
assert.equal(p.queue.originalsVerified, 9);
assert.equal(p.queue.confirmedOffers, 0);
assert.equal(p.queue.stageResponses, 0);
const xs = p.results.map((r) => r.processingMs).sort((a, b) => a - b),
  ys = p.results.map((r) => r.queueWaitMs).sort((a, b) => a - b);
const stats = (a) => ({
  min: a[0],
  p50: a[Math.ceil(a.length * 0.5) - 1],
  p95: a[Math.ceil(a.length * 0.95) - 1],
  max: a.at(-1),
});
const analysis = {
  at: new Date().toISOString(),
  primarySha256: seal.sha256,
  primaryUnchanged: true,
  preservedFFiles: await preserveF(),
  sourceProvenancesVerified: provenances,
  priceCurrency: p.priceCurrency,
  processingMs: stats(xs),
  queueWaitMs: stats(ys),
  articleSuggestions: p.articleSuggestions,
  details,
  realDocumentsAllowed: false,
  autoConfirmations: 0,
};
if (process.argv.includes('--save-analysis'))
  await exclusiveJson(resolve(repo, 'docs/evaluations/TASK-008G-analysis.json'), analysis);
console.log(
  JSON.stringify(
    {
      verified: true,
      primarySha256: seal.sha256,
      preservedFFiles: analysis.preservedFFiles,
      sourceProvenancesVerified: provenances,
      priceCurrency: p.priceCurrency,
      processingMs: analysis.processingMs,
      queueWaitMs: analysis.queueWaitMs,
      articleSuggestions: p.articleSuggestions,
      details,
    },
    null,
    2,
  ),
);
