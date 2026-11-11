// Exploratory diagnosis after primary seal. Candidate matches are never applied or used to rescore primary.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import shared from '../../packages/shared/dist/index.js';
import { repo } from '../task008-gate-d/io.mjs';
import { cases, exclusiveJson } from './baseline.mjs';
const p = JSON.parse(await readFile(resolve(repo, 'docs/evaluations/TASK-008G-primary.json'), 'utf8'));
const seal = JSON.parse(
  await readFile(resolve(repo, 'docs/evaluations/TASK-008G-primary-seal.json'), 'utf8'),
);
const items = [];
for (const c of cases) {
  const j = JSON.parse(await readFile(resolve(seal.out, c.id + '-job.json'), 'utf8'));
  for (const suggestion of p.articleSuggestions.filter((s) => s.caseId === c.id)) {
    const row = j.result.draft.items[suggestion.index];
    const recomputed = shared.suggestArticles(
      row.description.rawValue,
      row.sku.rawValue,
      c.items.map((r, i) => ({ id: `${c.id}-${i}`, name: r.description })),
    );
    assert.deepEqual(recomputed.candidates, suggestion.candidates);
    const candidate = suggestion.candidates.length === 1 ? suggestion.candidates[0] : null;
    const target = candidate ? c.items.find((r) => r.description === candidate.name) : null;
    items.push({
      caseId: c.id,
      index: suggestion.index,
      original: row.description.rawValue,
      candidate,
      actualPrice: row.unitPrice.value,
      actualCurrency: row.currency.value,
      expectedPrice: target?.unitPrice ?? null,
      expectedCurrency: target?.currency ?? null,
      pairCorrectForProposedTarget:
        !!target && row.unitPrice.value === target.unitPrice && row.currency.value === target.currency,
      requiresBuyerConfirmation: true,
      applied: false,
    });
  }
}
await exclusiveJson(resolve(repo, 'docs/evaluations/TASK-008G-candidate-diagnostics.json'), {
  at: new Date().toISOString(),
  primarySha256: seal.sha256,
  phase: 'exploratory AFTER primary seal',
  metric: 'diagnostic price+currency for unique proposed TZ target; NOT primary, NOT confirmed matches',
  candidateRows: items.length,
  correctNumericPairsForProposedTargets: items.filter((i) => i.pairCorrectForProposedTarget).length,
  items,
});
console.log(
  JSON.stringify({
    candidateRows: items.length,
    correctNumericPairsForProposedTargets: items.filter((i) => i.pairCorrectForProposedTarget).length,
    applied: 0,
  }),
);
