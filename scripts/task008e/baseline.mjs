import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { cases } from '../task008-gate-d/corpus.mjs';
import { repo, workspace, checked, json } from '../task008-gate-d/io.mjs';
export { repo, workspace, checked, json, cases };
const sha = (b) => createHash('sha256').update(b).digest('hex');
export async function frozenFixtures() {
  const report = JSON.parse(
    await readFile(await checked(resolve(repo, 'docs/evaluations/TASK-008-GATE-D-summary.json')), 'utf8'),
  );
  const fixtures = [];
  for (const c of cases) {
    const original = report.cases.find((r) => r.id === c.id);
    assert.ok(original);
    const group = report.groups[c.holdout ? 1 : 0];
    assert.match(group.runId, /^[0-9TZ.-]+-[a-f0-9]{8}$/);
    const folder = resolve(workspace, 'temp/task008-gate-d', group.runId),
      path = await checked(resolve(folder, c.id + '.pdf'));
    assert.equal(sha(await readFile(path)), original.sourceSha, 'Frozen PDF changed: ' + c.id);
    fixtures.push({ ...c, path, sha256: original.sourceSha, baselineFolder: folder });
  }
  const exported = JSON.parse(
    await readFile(resolve(repo, 'tests/fixtures/task008-gate-d-gold.json'), 'utf8'),
  );
  assert.deepEqual(exported.cases, cases, 'Frozen gold cannot change');
  return fixtures;
}
export async function integrity(capture = false) {
  const fixtures = await frozenFixtures(),
    files = [
      ...fixtures.map((c) => c.path),
      ...[
        'tests/fixtures/task008-gate-d-gold.json',
        'scripts/task008-gate-d/corpus.mjs',
        'scripts/task008-gate-d/scoring.mjs',
        'docs/evaluations/TASK-008-GATE-D-summary.json',
      ].map((p) => resolve(repo, p)),
    ];
  const current = await Promise.all(
    files.map(async (path) => ({ path, sha256: sha(await readFile(await checked(path))) })),
  );
  const manifest = resolve(workspace, 'temp/task008e/baseline-manifest.json');
  if (capture) {
    try {
      await readFile(manifest);
      throw new Error('Baseline already captured');
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    await json(manifest, { at: new Date().toISOString(), files: current });
  } else {
    const before = JSON.parse(await readFile(await checked(manifest), 'utf8'));
    assert.deepEqual(current, before.files, 'Initial PDFs, gold or scorer changed');
  }
  return { verified: true, files: current.length, originalPdfCount: fixtures.length, hashes: current };
}
