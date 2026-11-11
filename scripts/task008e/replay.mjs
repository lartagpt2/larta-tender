// Isolates deterministic code changes using the exact retained Gate D model outputs and PDFs.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import contracts from '../../apps/api/dist/document-ai/contracts.js';
import prep from '../../apps/api/dist/document-ai/pages.js';
import { score, aggregate } from '../task008-gate-d/scoring.mjs';
import { frozenFixtures, integrity, workspace, checked, json } from './baseline.mjs';
if (process.argv.includes('--capture')) console.log(JSON.stringify(await integrity(true)));
else {
  await integrity();
  const fixtures = await frozenFixtures(),
    results = [];
  const fresh = process.argv.includes('--fresh');
  const groups = fresh
    ? await Promise.all(
        ['results', 'holdout'].map(async (name) =>
          JSON.parse(
            await readFile(await checked(resolve(workspace, 'temp/task008e/groups', name + '.json')), 'utf8'),
          ),
        ),
      )
    : [];
  const reset = (f) => ({
    rawValue: f.rawValue,
    value: f.rawValue,
    page: f.page,
    evidenceSnippet: f.evidenceSnippet,
    confidence: null,
  });
  for (const c of fixtures) {
    const old = JSON.parse(
      await readFile(
        await checked(
          resolve(
            fresh ? resolve(workspace, 'temp/task008e', groups[c.holdout ? 1 : 0].runId) : c.baselineFolder,
            c.id + '-job.json',
          ),
        ),
        'utf8',
      ),
    );
    const draft = Object.fromEntries(contracts.fieldNames.map((k) => [k, reset(old.result.draft[k])]));
    draft.items = old.result.draft.items.map((row) =>
      Object.fromEntries(contracts.itemNames.map((k) => [k, reset(row[k])])),
    );
    const started = performance.now(),
      pages = await prep.documentPages(await readFile(c.path), 'application/pdf');
    const checkedDraft = contracts.validateDraft(
      draft,
      pages,
      pages.some((p) => p.image),
    );
    const after = { ...old, warnings: checkedDraft.warnings, result: { ...old.result, ...checkedDraft } };
    const result = score(c, after);
    results.push({ ...result, revalidationMs: Math.round(performance.now() - started), sourceSha: c.sha256 });
    await json(
      resolve(
        workspace,
        fresh ? 'temp/task008e/fresh-revalidation' : 'temp/task008e/replay',
        c.id + '-job.json',
      ),
      after,
    );
  }
  const report = {
    at: new Date().toISOString(),
    mode: fresh
      ? 'Final validation of retained TASK-008E outputs, no new inference'
      : 'same Gate D rawValue, no new inference; same frozen scorer and PDF bytes',
    schemaVersion: contracts.schemaVersion,
    promptVersion: contracts.promptVersion,
    summary: aggregate(results),
    results,
  };
  await json(
    resolve(workspace, fresh ? 'temp/task008e/fresh-revalidation.json' : 'temp/task008e/replay-report.json'),
    report,
  );
  console.log(JSON.stringify({ summary: report.summary }, null, 2));
}
