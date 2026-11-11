// Read-only check through the already-running local portal. Never submits a document to AI.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { workspace, repo, checked, json } from './io.mjs';
const results = [];
for (const group of ['results', 'holdout']) {
  const report = JSON.parse(
    await readFile(await checked(resolve(workspace, 'temp/task008-gate-d/groups', group + '.json')), 'utf8'),
  );
  assert.match(report.runId, /^[0-9TZ.-]+-[a-f0-9]{8}$/);
  const folder = resolve(workspace, 'temp/task008-gate-d', report.runId),
    submission = JSON.parse(await readFile(await checked(resolve(folder, 'submission.json')), 'utf8'));
  assert.match(submission.base, /^\/api\/tenders\/[a-f0-9-]{36}$/);
  for (const entry of submission.jobs) {
    assert.match(entry.caseId, /^ru-[a-z-]+$/);
    assert.match(entry.documentId, /^[a-f0-9-]{36}$/);
    const job = JSON.parse(
      await readFile(await checked(resolve(folder, entry.caseId + '-job.json')), 'utf8'),
    );
    const response = await fetch(
      'http://127.0.0.1:5173' + submission.base + '/offers/' + entry.documentId + '/original',
    );
    assert.equal(response.status, 200);
    assert.equal(
      createHash('sha256')
        .update(Buffer.from(await response.arrayBuffer()))
        .digest('hex'),
      job.sourceSha,
    );
    results.push({ group, id: entry.caseId, originalUnchanged: true });
  }
  const response = await fetch('http://127.0.0.1:5173' + submission.base + '/verification');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).offers.length, 0);
}
const audit = {
  at: new Date().toISOString(),
  downloaded: results.length,
  unchanged: results.length,
  confirmedOffers: 0,
  results,
};
await json(resolve(repo, 'docs/evaluations/TASK-008-GATE-D-integrity.json'), audit);
console.log(JSON.stringify(audit, null, 2));
