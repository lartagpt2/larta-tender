// Re-score retained synthetic job files; never run inference or change expected values.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { cases } from './corpus.mjs';
import { score, scoreRaw, aggregate } from './scoring.mjs';
import { repo, workspace, checked, json } from './io.mjs';
const groups = [];
for (const name of ['results', 'holdout']) {
  const path = resolve(workspace, 'temp/task008-gate-d/groups', `${name}.json`);
  const report = JSON.parse(await readFile(await checked(path), 'utf8'));
  assert.match(report.runId, /^[0-9TZ.-]+-[a-f0-9]{8}$/);
  const folder = resolve(workspace, 'temp/task008-gate-d', report.runId);
  for (const old of report.results) {
    const gold = cases.find((c) => c.id === old.id);
    assert.ok(gold);
    const job = JSON.parse(await readFile(await checked(resolve(folder, old.id + '-job.json')), 'utf8'));
    assert.equal(job.sourceSha, old.sourceSha);
    assert.equal(job.result?.digest, report.preflight.digest);
    const current = score(gold, job);
    assert.equal(current.knownCorrect, old.knownCorrect, 'No post-hoc truth change');
    Object.assign(old, current, { rawScore: scoreRaw(gold, job) });
  }
  report.summary = aggregate(report.results);
  report.summaryRaw = aggregate(report.results.map((r) => r.rawScore));
  await json(path, report);
  groups.push(report);
}
const rows = groups.flatMap((g) => g.results),
  raw = rows.map((r) => r.rawScore),
  latencies = rows.map((r) => r.processingMs).sort((a, b) => a - b),
  percentile = (p) => latencies[Math.ceil(p * latencies.length) - 1];
const summary = {
  version: 'gate-d-ru-combined-v1',
  at: new Date().toISOString(),
  baseCommit: groups[0].baseCommit,
  model: groups[0].preflight.model,
  digest: groups[0].preflight.digest,
  method:
    'Exact normalized spelling of accepted draft fields; nulls scored separately. Secondary rawValue metric normalizes only literal numeric labels/unit/currency. No semantic judge or post-hoc gold changes.',
  groups: groups.map((g) => ({ runId: g.runId, cloud: g.preflight.cloud, queue: g.queue })),
  accepted: aggregate(rows),
  rawValue: aggregate(raw),
  latency: {
    documents: rows.length,
    minMs: latencies[0],
    maxMs: latencies.at(-1),
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
  },
  cases: rows.map(({ rawScore, ...r }) => ({
    ...Object.fromEntries(Object.entries(r).filter(([key]) => !['checks', 'critical'].includes(key))),
    rawValue: {
      knownCorrect: rawScore.knownCorrect,
      knownTotal: rawScore.knownTotal,
      unknownCorrect: rawScore.unknownCorrect,
      unknownTotal: rawScore.unknownTotal,
      errors: rawScore.errors,
    },
  })),
};
await json(resolve(repo, 'docs/evaluations/TASK-008-GATE-D-summary.json'), summary);
console.log(
  JSON.stringify(
    { accepted: summary.accepted, rawValue: summary.rawValue, latency: summary.latency },
    null,
    2,
  ),
);
