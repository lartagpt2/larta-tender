import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { aggregate } from '../task008-gate-d/scoring.mjs';
import { repo, workspace, checked, json, integrity, cases } from './baseline.mjs';
const read = async (path) => JSON.parse(await readFile(await checked(path), 'utf8'));
const before = await read(resolve(repo, 'docs/evaluations/TASK-008-GATE-D-summary.json')),
  replay = await read(resolve(workspace, 'temp/task008e/replay-report.json')),
  groups = [];
for (const name of ['results', 'holdout'])
  groups.push(await read(resolve(workspace, 'temp/task008e/groups', name + '.json')));
const rows = groups.flatMap((g) => g.results),
  latencies = rows.map((r) => r.processingMs).sort((a, b) => a - b),
  after = aggregate(rows);
assert.equal(rows.length, 10);
assert.equal(new Set(rows.map((r) => r.id)).size, 10);
for (const row of rows) {
  assert.equal(row.sourceSha, before.cases.find((c) => c.id === row.id).sourceSha);
  assert.equal(row.status, 'needs_review');
  assert.equal(
    row.missingWarnings.length,
    0,
    'All required arithmetic/currency warnings must remain visible',
  );
}
assert.ok(
  groups.every(
    (g) =>
      g.queue.fifo &&
      g.queue.confirmedOffers === 0 &&
      g.queue.stageResponses === 0 &&
      g.preflight.cloud.disabled === true,
  ),
);
const preserved = await integrity(),
  originals = await read(resolve(repo, 'docs/evaluations/TASK-008E-originals.json'));
const report = {
  at: new Date().toISOString(),
  baselineCommit: '098b1c8aa97eb3327d690efd084bdada1a59415d',
  model: before.model,
  digest: before.digest,
  method:
    'Same unchanged PDF bytes, corpus, gold and scoring. Baseline / deterministic revalidation of old rawValue / fresh inference with prompt-v3 and normalization. Results remain needs_review.',
  integrity: {
    verified: preserved.verified,
    files: preserved.files,
    originalPdfCount: preserved.originalPdfCount,
    hashes: preserved.hashes.map((f) => ({
      path: relative(workspace, f.path).replaceAll('\\', '/'),
      sha256: f.sha256,
    })),
  },
  before: before.accepted,
  oldOutputsRevalidated: replay.summary,
  after,
  afterRawValue: aggregate(rows.map((r) => r.rawScore)),
  improvementPercentagePoints: (after.knownAccuracy - before.accepted.knownAccuracy) * 100,
  latency: {
    before: before.latency,
    after: {
      documents: rows.length,
      minMs: latencies[0],
      maxMs: latencies.at(-1),
      p50Ms: latencies[Math.ceil(0.5 * latencies.length) - 1],
      p95Ms: latencies[Math.ceil(0.95 * latencies.length) - 1],
    },
  },
  queue: {
    beforeFIFO: before.groups.every(
      (g, i) =>
        JSON.stringify(g.queue.order) ===
        JSON.stringify(cases.filter((c) => !!c.holdout === !!i).map((c) => c.id)),
    ),
    afterFIFO: groups.every((g) => g.queue.fifo === true),
    before: before.groups.map((g) => ({ runId: g.runId, ...g.queue })),
    after: groups.map((g) => ({ runId: g.runId, ...g.queue })),
    originals,
  },
  cases: rows.map(({ rawScore, ...r }) => {
    const old = before.cases.find((c) => c.id === r.id),
      paired = replay.results.find((c) => c.id === r.id);
    return {
      id: r.id,
      sourceSha: r.sourceSha,
      before: {
        correct: old.knownCorrect,
        total: old.knownTotal,
        processingMs: old.processingMs,
        queueWaitMs: old.queueWaitMs,
      },
      revalidated: { correct: paired.knownCorrect, total: paired.knownTotal, remainingErrors: paired.errors },
      after: {
        ...Object.fromEntries(Object.entries(r).filter(([k]) => !['checks', 'critical'].includes(k))),
        rawCorrect: rawScore.knownCorrect,
        rawTotal: rawScore.knownTotal,
      },
      remainingErrors: r.errors,
    };
  }),
};
await json(resolve(repo, 'docs/evaluations/TASK-008E-comparison.json'), report);
console.log(
  JSON.stringify(
    {
      before: report.before.knownAccuracy,
      revalidated: report.oldOutputsRevalidated.knownAccuracy,
      after: report.after.knownAccuracy,
      latency: report.latency,
      remaining: report.cases
        .filter((c) => c.remainingErrors.length)
        .map((c) => ({ id: c.id, errors: c.remainingErrors })),
      integrity: report.integrity.verified,
      FIFO: report.queue.afterFIFO,
    },
    null,
    2,
  ),
);
