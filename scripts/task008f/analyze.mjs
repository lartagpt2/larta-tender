// Read-only analysis of sealed first-pass results; never calls Ollama or changes evaluation inputs.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { repo, checked } from '../task008-gate-d/io.mjs';
import { integrity, exclusiveJson, cases } from './freeze.mjs';
import { criticalMetrics } from './metrics.mjs';
const read = async (p) => JSON.parse(await readFile(await checked(p), 'utf8'));
const primaryPath = resolve(repo, 'docs/evaluations/TASK-008F-primary.json');
const seal = await read(resolve(repo, 'docs/evaluations/TASK-008F-primary-seal.json'));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const primary = await read(primaryPath);
assert.equal(sha(await readFile(primaryPath)), seal.sha256);
assert.equal(
  sha(await readFile(resolve(repo, 'docs/evaluations/TASK-008F-preregistration.json'))),
  primary.preregistrationSha256,
);
assert.equal(
  sha(await readFile(resolve(repo, 'docs/evaluations/TASK-008F-preregistration-addendum.json'))),
  primary.preregistrationAddendumSha256,
);
const addendum = await read(resolve(repo, 'docs/evaluations/TASK-008F-preregistration-addendum.json'));
assert.equal(sha(await readFile(resolve(repo, addendum.runner))), addendum.runnerSha256);
const manifest = await integrity();
assert.deepEqual(criticalMetrics(primary.results), primary.criticalFields);
assert.equal(primary.results.length, 12);
assert.equal(primary.queue.confirmedOffers, 0);
assert.equal(primary.queue.stageResponses, 0);
const norm = (s) =>
  s == null
    ? null
    : String(s)
        .normalize('NFKC')
        .toLowerCase()
        .replace(/ё/g, 'е')
        .replace(/[«»„“”"']/g, '')
        .replace(/\s+/g, ' ')
        .trim();
const details = [];
for (const r of primary.results) {
  const gold = cases.find((c) => c.id === r.id),
    job = await read(resolve(seal.out, r.id + '-job.json'));
  assert.equal(job.attempts, 1);
  assert.equal(job.sourceSha, manifest.documents.find((d) => d.id === r.id).sha256);
  if (job.result) assert.equal(job.status, 'needs_review');
  const errors = r.errors.map((e) => {
    const match = /^items\[(\d+)\]\.(\w+)$/.exec(e.path);
    const row = match
      ? job.result?.draft.items.find(
          (a) =>
            norm(a.description.value ?? a.description.rawValue) ===
            norm(gold.items[Number(match[1])].description),
        )
      : null;
    const f = match ? row?.[match[2]] : job.result?.draft[e.path];
    return {
      ...e,
      rawValue: f?.rawValue ?? null,
      page: f?.page ?? null,
      evidenceSnippet: f?.evidenceSnippet ?? null,
      evidenceMethod: f?.evidenceMethod ?? null,
    };
  });
  details.push({
    id: r.id,
    kind: r.kind,
    status: r.status,
    knownCorrect: r.knownCorrect,
    knownTotal: r.knownTotal,
    rawKnownCorrect: r.rawScore.knownCorrect,
    rawKnownTotal: r.rawScore.knownTotal,
    actualRows: r.actualRows,
    matchedRows: r.matchedRows,
    expectedRows: r.expectedRows,
    processingMs: r.processingMs,
    queueWaitMs: r.queueWaitMs,
    warnings: r.warnings,
    errors,
    missingWarnings: r.missingWarnings,
  });
}
const times = primary.results.map((r) => r.processingMs).sort((a, b) => a - b);
const waits = primary.results.map((r) => r.queueWaitMs).sort((a, b) => a - b);
const stats = (xs) => ({
  min: xs[0],
  p50: xs[Math.ceil(0.5 * xs.length) - 1],
  p95: xs[Math.ceil(0.95 * xs.length) - 1],
  max: xs.at(-1),
  mean: xs.reduce((a, b) => a + b, 0) / xs.length,
});
const subgroup = Object.fromEntries(
  ['native', 'scan'].map((k) => [k, criticalMetrics(primary.results.filter((r) => r.kind === k))]),
);
const threshold =
  Object.values(primary.criticalFields.fields).every((f) => f.accuracy >= 0.98) &&
  primary.criticalFields.fields.supplier.accuracy === 1 &&
  primary.criticalFields.fields.taxId.accuracy === 1 &&
  primary.summary.exactRowCounts === 12 &&
  primary.summary.nonNullWhenMissing === 0 &&
  primary.queue.confirmedOffers === 0 &&
  primary.queue.fifo;
// Supplemental paired-money diagnostic, not a change to primary scoring.
const priceChecks = primary.results.flatMap((r) =>
  r.checks
    .filter((c) => /^items\[\d+\]\.unitPrice$/.test(c.path) && !c.expectedMissing)
    .map((c) => ({
      correct:
        c.correct && r.checks.find((x) => x.path === c.path.replace('.unitPrice', '.currency'))?.correct,
    })),
);
const priceAndCurrency = { correct: priceChecks.filter((c) => c.correct).length, total: priceChecks.length };
const analysis = {
  at: new Date().toISOString(),
  primarySha256: seal.sha256,
  unchangedInputs: true,
  inferencePasses: 1,
  documents: 12,
  priceAndCurrency,
  processingMs: stats(times),
  queueWaitMs: stats(waits),
  criticalFields: primary.criticalFields,
  subgroup,
  proposedPilotThresholdPassed: threshold,
  realDocumentsAuthorized: false,
  details,
};
await exclusiveJson(resolve(repo, 'docs/evaluations/TASK-008F-analysis.json'), analysis);
console.log(
  JSON.stringify(
    {
      primarySha256: seal.sha256,
      fields: primary.criticalFields.fields,
      processingMs: analysis.processingMs,
      queueWaitMs: analysis.queueWaitMs,
      proposedPilotThresholdPassed: threshold,
      details,
    },
    null,
    2,
  ),
);
