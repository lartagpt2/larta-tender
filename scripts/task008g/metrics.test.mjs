import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import Decimal from 'decimal.js';
import { cases } from './corpus.mjs';
import { score } from '../task008-gate-d/scoring.mjs';
import { priceCurrency } from './metrics.mjs';
const field = (value) => ({ value });
const job = (c) => ({
  status: 'needs_review',
  result: {
    draft: {
      ...Object.fromEntries(Object.entries(c.headers).map(([k, v]) => [k, field(v)])),
      items: c.items.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, field(v)]))),
    },
  },
});
test('new synthetic hold-out: 8 documents, 24 rows, 9 pages, no F names/IDs/INNs', async () => {
  const old = JSON.parse(
    await readFile(new URL('../../tests/fixtures/task008f-gold.json', import.meta.url), 'utf8'),
  );
  assert.equal(cases.length, 8);
  assert.equal(
    cases.reduce((n, c) => n + c.items.length, 0),
    24,
  );
  assert.equal(
    cases.reduce((n, c) => n + c.pages, 0),
    9,
  );
  for (const c of cases) {
    assert.ok(
      !old.some(
        (o) =>
          o.id === c.id ||
          o.headers.taxId === c.headers.taxId ||
          o.headers.supplierName === c.headers.supplierName,
      ),
    );
    for (const r of c.items)
      assert.ok(!old.some((o) => o.items.some((i) => i.description === r.description)));
  }
});
test('exact authored arithmetic and expected unknowns', () => {
  for (const c of cases)
    for (const r of c.items)
      if (r.unitPrice !== null) assert.equal(new Decimal(r.quantity).mul(r.unitPrice).toFixed(), r.lineTotal);
  const m = priceCurrency(
    cases.map((c) => score(c, job(c))),
    cases,
  );
  assert.equal(m.knownPairs.total, 18);
  assert.equal(m.knownPairs.correct, 18);
  assert.equal(m.pricedUnknownCurrency.total, 5);
  assert.equal(m.pricedUnknownCurrency.correct, 5);
  assert.equal(m.unpriced.total, 1);
});
test('right numerical price with wrong currency fails pair', () => {
  const c = cases[0],
    j = job(c);
  j.result.draft.items[0].currency.value = 'RUB';
  assert.equal(priceCurrency([score(c, j)], [c]).knownPairs.correct, 2);
});
test('failed document is not dropped; name mismatches penalize paired values', () => {
  const c = cases[0];
  assert.equal(priceCurrency([score(c, { status: 'failed' })], [c]).knownPairs.total, 3);
  assert.equal(priceCurrency([score(c, { status: 'failed' })], [c]).knownPairs.correct, 0);
  const j = job(c);
  j.result.draft.items[0].description.value = 'Unmatched';
  assert.equal(priceCurrency([score(c, j)], [c]).knownPairs.correct, 2);
});
test('missing currency is a separate safety metric, never a successful known pair', () => {
  const c = cases.find((c) => c.id === 'g08-no-currency'),
    j = job(c);
  j.result.draft.items[0].currency.value = 'RUB';
  const m = priceCurrency([score(c, j)], [c]);
  assert.equal(m.knownPairs.total, 0);
  assert.equal(m.pricedUnknownCurrency.correct, 1);
  assert.equal(m.pricedUnknownCurrency.total, 2);
});
