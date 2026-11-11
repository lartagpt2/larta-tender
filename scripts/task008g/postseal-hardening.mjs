// Post-seal safety hardening: preserve both code snapshots, replay all held-out outputs without inference.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { repo, workspace, checked } from '../task008-gate-d/io.mjs';
import { cases, exclusiveJson, preserveF } from './baseline.mjs';
import prep from '../../apps/api/dist/document-ai/pages.js';
import contracts from '../../apps/api/dist/document-ai/contracts.js';
import { score, aggregate } from '../task008-gate-d/scoring.mjs';
import { priceCurrency } from './metrics.mjs';
const read = async (p) => JSON.parse(await readFile(await checked(p), 'utf8'));
const hash = async (p) =>
  createHash('sha256')
    .update(await readFile(await checked(p)))
    .digest('hex');
const m = await read(resolve(repo, 'docs/evaluations/TASK-008G-preregistration.json'));
const seal = await read(resolve(repo, 'docs/evaluations/TASK-008G-primary-seal.json'));
const primary = await read(resolve(repo, 'docs/evaluations/TASK-008G-primary.json'));
assert.equal(await hash(resolve(repo, 'docs/evaluations/TASK-008G-primary.json')), seal.sha256);
const snapshotRoot = 'temp/task008g/frozen-production',
  changes = [];
for (const f of m.files) {
  assert.equal(await hash(resolve(workspace, snapshotRoot, f.path)), f.sha256);
  const current = await hash(resolve(workspace, f.path));
  if (current !== f.sha256) {
    assert.match(
      f.path,
      /^tender-platform\/apps\/api\/(?:src\/document-ai\/header-currency(?:\.spec)?\.ts|dist\/document-ai\/header-currency\.js)$/,
    );
    changes.push({ path: f.path, primarySha256: f.sha256, finalSha256: current });
  }
}
const replay = [];
for (const c of cases) {
  const original = await read(resolve(seal.out, c.id + '-job.json'));
  const input = structuredClone(original.result.draft),
    fields = [...contracts.fieldNames.map((k) => input[k]), ...input.items.flatMap((r) => Object.values(r))];
  for (const f of fields) {
    if (f.originalEvidenceSnippet !== undefined) f.evidenceSnippet = f.originalEvidenceSnippet;
    if (f.currencySource) f.page = f.currencySource.rowPage;
    delete f.sourceDocumentId;
    delete f.originalEvidenceSnippet;
    delete f.currencySource;
    delete f.evidenceMethod;
    f.value = f.rawValue;
  }
  const source = m.documents.find((d) => d.id === c.id);
  const pages = await prep.documentPages(await readFile(resolve(workspace, source.path)), 'application/pdf');
  const result = contracts.validateDraft(input, pages, c.kind === 'scan');
  const clean = (d) => {
    const copy = structuredClone(d);
    for (const f of [
      ...contracts.fieldNames.map((k) => copy[k]),
      ...copy.items.flatMap((r) => Object.values(r)),
    ]) {
      delete f.sourceDocumentId;
      if (f.currencySource) delete f.currencySource.sourceDocumentId;
    }
    return copy;
  };
  assert.deepEqual(clean(result.draft), clean(original.result.draft), c.id + ' draft unchanged');
  replay.push(score(c, { ...original, result: { ...original.result, ...result } }));
}
assert.deepEqual(aggregate(replay), primary.summary);
assert.deepEqual(priceCurrency(replay, cases), primary.priceCurrency);
await exclusiveJson(resolve(repo, 'docs/evaluations/TASK-008G-postseal-hardening.json'), {
  at: new Date().toISOString(),
  reason:
    'Final code review: stop local table currency at another price/amount heading, table or section, including headers without currency',
  primarySha256: seal.sha256,
  primaryMetricsUnchanged: true,
  snapshotRoot,
  frozenFilesVerified: m.files.length,
  changes,
  noNewInference: true,
  replayedJobs: replay.length,
  replayedDraftsIdentical: true,
  replayedSummary: aggregate(replay),
  replayedPriceCurrency: priceCurrency(replay, cases),
  preservedFFiles: await preserveF(),
});
console.log(
  JSON.stringify({
    postSealHardening: true,
    changedFiles: changes.length,
    primaryMetricsUnchanged: true,
    replayedDraftsIdentical: replay.length,
    knownPairs: primary.priceCurrency.knownPairs.correct + '/' + primary.priceCurrency.knownPairs.total,
  }),
);
