import { test } from 'node:test';
import assert from 'node:assert/strict';
import { score, scoreRaw, aggregate } from './scoring.mjs';
const gold = {
  id: 'metric-check',
  headers: { supplierName: 'ООО «ТЕСТ»', taxId: null, buyerName: 'Покупатель', total: '10' },
  items: [{ description: 'Клапан', quantity: '2', unitPrice: '5', lineTotal: '10', delivery: '7 дней' }],
};
const f = (value) => ({ value });
function job() {
  return {
    status: 'needs_review',
    warnings: [],
    result: {
      draft: {
        supplierName: f('ООО ТЕСТ'),
        taxId: f(null),
        buyerName: f('Покупатель'),
        total: f('10'),
        items: [Object.fromEntries(Object.entries(gold.items[0]).map(([k, v]) => [k, f(v)]))],
      },
    },
  };
}
test('exact expected values and absent tax ID score fully; typographic quotes alone are normalized', () => {
  const r = score(gold, job());
  assert.equal(r.knownCorrect, r.knownTotal);
  assert.equal(r.unknownCorrect, 1);
  assert.equal(r.errors.length, 0);
  assert.equal(aggregate([r]).knownAccuracy, 1);
});
test('buyer substitution, invented tax, wrong price and extra row are detected', () => {
  const j = job();
  j.result.draft.supplierName = f('Покупатель');
  j.result.draft.taxId = f('9999999999');
  j.result.draft.items[0].unitPrice = f('50');
  j.result.draft.items.push({ ...j.result.draft.items[0] });
  const r = score(gold, j);
  assert.equal(r.buyerAsSupplier, true);
  assert.equal(r.supplierCorrect, false);
  assert.equal(r.rowPrecision, 0.5);
  assert.equal(r.errors.length, 4);
  assert.equal(aggregate([r]).nonNullWhenMissing, 1);
});
test('failed job and missing row count as errors, not excluded from denominator', () => {
  const r = score(gold, { status: 'failed', error: 'local_ai_timeout' });
  assert.equal(r.knownCorrect, 0);
  assert.equal(r.knownTotal, 8);
  assert.equal(r.actualRows, 0);
  assert.equal(aggregate([r]).completed, 0);
});
test('row order does not matter and shortened conditions do not pass exact comparison', () => {
  const j = job();
  j.result.draft.items[0].delivery = f('7');
  const r = score(gold, j);
  assert.equal(r.errors[0].path, 'items[0].delivery');
  assert.equal(r.errors[0].type, 'mismatch');
});

test('raw-output metric separates evidence rejection from model transcription and preserves unknowns', () => {
  const j = job();
  for (const [k, f] of Object.entries(j.result.draft)) if (k !== 'items') f.rawValue = f.value;
  for (const f of Object.values(j.result.draft.items[0])) f.rawValue = f.value;
  j.result.draft.items[0].unitPrice = { rawValue: '5 RUB', value: null };
  const g = { ...gold, headers: { ...gold.headers, currency: 'RUB' } };
  j.result.draft.currency = { rawValue: 'RUB', value: 'RUB' };
  assert.equal(score(g, j).knownCorrect, score(g, j).knownTotal - 1);
  assert.equal(scoreRaw(g, j).knownCorrect, scoreRaw(g, j).knownTotal);
  j.result.draft.items[0].unitPrice.rawValue = '999 RUB';
  assert.equal(scoreRaw(g, j).errors[0].actual, '999');
});

test('reordered distinct rows align by name, while known-field accuracy excludes null truth', () => {
  const g = { ...gold, items: [gold.items[0], { ...gold.items[0], description: 'Насос' }] },
    j = job();
  j.result.draft.items.push({ ...j.result.draft.items[0], description: f('Насос') });
  j.result.draft.items.reverse();
  const r = score(g, j),
    a = aggregate([r]);
  assert.equal(r.matchedRows, 2);
  assert.equal(r.errors.length, 0);
  assert.equal(a.byField.taxId.knownTotal, 0);
  assert.equal(a.byField.taxId.missingCorrect, 1);
});

test('exported gold is identical to authored corpus and has ten independent scenario IDs', async () => {
  const { readFile } = await import('node:fs/promises');
  const { cases } = await import('./corpus.mjs');
  const exported = JSON.parse(await readFile('tests/fixtures/task008-gate-d-gold.json', 'utf8'));
  assert.deepEqual(exported.cases, cases);
  assert.equal(new Set(cases.map((c) => c.id)).size, 10);
});
