// Same retained first-pass F model outputs, new deterministic validation only. No inference or DB.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import prep from '../../apps/api/dist/document-ai/pages.js';
import contracts from '../../apps/api/dist/document-ai/contracts.js';
import shared from '../../packages/shared/dist/index.js';
import { repo, workspace } from '../task008-gate-d/io.mjs';
import { exclusiveJson, preserveF } from './baseline.mjs';
import { score, aggregate } from '../task008-gate-d/scoring.mjs';
import { priceCurrency } from './metrics.mjs';
const gold = JSON.parse(await readFile(resolve(repo, 'tests/fixtures/task008f-gold.json'), 'utf8'));
const old = JSON.parse(await readFile(resolve(repo, 'docs/evaluations/TASK-008F-primary.json'), 'utf8'));
const seal = JSON.parse(
  await readFile(resolve(repo, 'docs/evaluations/TASK-008F-primary-seal.json'), 'utf8'),
);
const results = [],
  suggestions = [],
  provenance = [];
await preserveF();
for (const c of gold) {
  const original = JSON.parse(await readFile(resolve(seal.out, c.id + '-job.json'), 'utf8'));
  const pages = await prep.documentPages(
    await readFile(resolve(workspace, 'temp/task008f/corpus', c.id + '.pdf')),
    'application/pdf',
  );
  const draft = structuredClone(original.result.draft);
  for (const f of [
    ...contracts.fieldNames.map((k) => draft[k]),
    ...draft.items.flatMap((r) => Object.values(r)),
  ]) {
    delete f.sourceDocumentId;
    delete f.originalEvidenceSnippet;
    delete f.evidenceMethod;
    delete f.currencySource;
    f.value = f.rawValue;
  }
  const checked = contracts.validateDraft(draft, pages, c.kind === 'scan'),
    job = { ...original, result: { ...original.result, ...checked }, warnings: checked.warnings };
  const r = score(c, job);
  results.push(r);
  for (const [index, item] of job.result.draft.items.entries()) {
    const required = c.items.map((r, i) => ({ id: `${c.id}-${i}`, name: r.description }));
    const s = shared.suggestArticles(item.description.rawValue, item.sku.rawValue, required);
    if (s.candidates.length)
      suggestions.push({
        caseId: c.id,
        index,
        original: item.description.rawValue,
        ...s,
        automaticallyApplied: false,
      });
    if (item.currency.currencySource)
      provenance.push({ caseId: c.id, index, ...item.currency.currencySource });
    assert.equal(item.description.rawValue, original.result.draft.items[index].description.rawValue);
    assert.equal(
      item.description.value,
      original.result.draft.items[index].description.value,
      'No automatic homoglyph replacement',
    );
  }
  await exclusiveJson(resolve(workspace, 'temp/task008g/regression', c.id + '-job.json'), job);
}
const report = {
  at: new Date().toISOString(),
  method: 'replay retained first F outputs through v4 validator; no new inference',
  oldPrimaryUntouched: true,
  before: { summary: old.summary, pair: priceCurrency(old.results, gold) },
  after: { summary: aggregate(results), pair: priceCurrency(results, gold) },
  suggestions,
  provenance,
  results,
};
await exclusiveJson(resolve(repo, 'docs/evaluations/TASK-008G-regression.json'), report);
await preserveF();
console.log(
  JSON.stringify({
    before: report.before.pair,
    after: report.after.pair,
    known: [report.after.summary.knownCorrect, report.after.summary.knownTotal],
    provenance: provenance.length,
    suggestions: suggestions.length,
  }),
);
