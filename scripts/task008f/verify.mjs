// Read-only reproducibility check: no inference, database connection, or file writes.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { repo, checked } from '../task008-gate-d/io.mjs';
import { integrity, cases } from './freeze.mjs';
import { score, scoreRaw, aggregate } from '../task008-gate-d/scoring.mjs';
import { criticalMetrics } from './metrics.mjs';
const read = async (p) => JSON.parse(await readFile(await checked(p), 'utf8'));
const hash = async (p) =>
  createHash('sha256')
    .update(await readFile(await checked(p)))
    .digest('hex');
const m = await integrity(),
  p = await read(resolve(repo, 'docs/evaluations/TASK-008F-primary.json')),
  seal = await read(resolve(repo, 'docs/evaluations/TASK-008F-primary-seal.json')),
  add = await read(resolve(repo, 'docs/evaluations/TASK-008F-preregistration-addendum.json'));
assert.equal(await hash(resolve(repo, 'docs/evaluations/TASK-008F-primary.json')), seal.sha256);
assert.equal(
  await hash(resolve(repo, 'docs/evaluations/TASK-008F-preregistration.json')),
  p.preregistrationSha256,
);
assert.equal(
  await hash(resolve(repo, 'docs/evaluations/TASK-008F-preregistration-addendum.json')),
  p.preregistrationAddendumSha256,
);
assert.equal(await hash(resolve(repo, add.runner)), add.runnerSha256);
assert.equal(
  await hash(resolve(repo, 'docs/evaluations/TASK-008F-preregistration-addendum.md')),
  add.noteSha256,
);
const scores = [],
  raw = [];
for (const c of cases) {
  const j = await read(resolve(seal.out, c.id + '-job.json')),
    r = p.results.find((r) => r.id === c.id);
  assert.equal(j.attempts, 1);
  assert.ok(['needs_review', 'failed', 'unsupported'].includes(j.status));
  assert.equal(j.sourceSha, m.documents.find((d) => d.id === c.id).sha256);
  const s = score(c, j);
  scores.push(s);
  raw.push(scoreRaw(c, j));
  for (const [k, v] of Object.entries(s)) assert.deepEqual(r[k], v, c.id + '.' + k);
  assert.deepEqual(r.rawScore, raw.at(-1));
}
assert.deepEqual(aggregate(scores), p.summary);
assert.deepEqual(aggregate(raw), p.summaryRaw);
assert.deepEqual(criticalMetrics(scores), p.criticalFields);
assert.deepEqual(p.queue.submissionOrder, p.queue.processingOrder);
assert.equal(p.queue.confirmedOffers, 0);
assert.equal(p.queue.stageResponses, 0);
assert.equal(p.queue.originalsVerified, 13);
assert.equal(p.preflight.cloud.disabled, true);
assert.equal(p.preflight.digest, m.digest);
console.log(
  JSON.stringify({
    verified: true,
    sourceFiles: m.files.length,
    pdfFiles: m.documents.length,
    firstPassJobs: scores.length,
    primarySha256: seal.sha256,
    known: `${p.summary.knownCorrect}/${p.summary.knownTotal}`,
    fifo: true,
    confirmedOffers: 0,
  }),
);
