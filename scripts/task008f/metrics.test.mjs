import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import Decimal from 'decimal.js';
import { cases, lines } from './corpus.mjs';
import { score } from '../task008-gate-d/scoring.mjs';
import { criticalMetrics } from './metrics.mjs';
import { exclusiveJson, integrity } from './freeze.mjs';
const wrap = (value) => ({ value });
const job = (c) => ({
  status: 'needs_review',
  result: {
    draft: {
      ...Object.fromEntries(Object.entries(c.headers).map(([k, v]) => [k, wrap(v)])),
      items: c.items.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, wrap(v)]))),
    },
  },
});
test('new identities, names and quantities: no known-case reuse', async () => {
  const old = JSON.parse(
    await readFile(new URL('../../tests/fixtures/task008-gate-d-gold.json', import.meta.url), 'utf8'),
  );
  const previous = Array.isArray(old) ? old : old.cases;
  assert.equal(cases.length, 12);
  assert.equal(
    cases.reduce((n, c) => n + c.items.length, 0),
    42,
  );
  assert.equal(
    cases.reduce((n, c) => n + c.pages, 0),
    13,
  );
  assert.equal(cases.filter((c) => c.kind === 'scan').length, 6);
  for (const c of cases)
    for (const d of previous) {
      assert.notEqual(c.id, d.id);
      assert.notEqual(c.headers.supplierName, d.headers.supplierName);
      if (c.headers.taxId) assert.notEqual(c.headers.taxId, d.headers.taxId);
      for (const r of c.items) assert.ok(!d.items.some((p) => p.description === r.description));
    }
});
test('authored arithmetic is exact and source includes literal values and roles', () => {
  for (const c of cases) {
    for (const r of c.items)
      if (r.unitPrice !== null)
        assert.equal(new Decimal(r.quantity).times(r.unitPrice).toFixed(), r.lineTotal);
    if (c.headers.total !== null)
      assert.equal(c.items.reduce((n, r) => n.plus(r.lineTotal), new Decimal(0)).toFixed(), c.headers.total);
    const text = Array.from({ length: c.pages }, (_, p) => lines(c, p).join('\n')).join('\n');
    assert.ok(text.includes(c.headers.supplierName));
    if (c.headers.taxId) assert.ok(text.includes(c.headers.taxId));
    for (const r of c.items) assert.ok(text.includes(r.description));
  }
});
test('perfect responses have preregistered six denominators; nulls separate', () => {
  const m = criticalMetrics(cases.map((c) => score(c, job(c))));
  assert.deepEqual(Object.fromEntries(Object.entries(m.fields).map(([k, v]) => [k, v.total])), {
    supplier: 12,
    taxId: 11,
    nomenclature: 42,
    quantity: 42,
    unitPrice: 41,
    delivery: 51,
  });
  for (const f of Object.values(m.fields)) assert.equal(f.accuracy, 1);
  assert.equal(m.fields.taxId.absentTotal, 1);
  assert.equal(m.fields.unitPrice.absentTotal, 1);
  assert.equal(m.fields.delivery.absentTotal, 3);
});
test('failed inference remains in every known denominator', () => {
  const c = cases[0],
    m = criticalMetrics([score(c, { status: 'failed', error: 'timeout' })]);
  assert.equal(m.fields.quantity.total, 3);
  assert.equal(m.fields.quantity.correct, 0);
  assert.equal(m.aggregate.completed, 0);
});
test('wrong row name penalizes linked numbers, extra rows reduce precision', () => {
  const c = cases[0],
    j = job(c);
  j.result.draft.items[0].description.value = 'Другое имя';
  const m = criticalMetrics([score(c, j)]);
  assert.equal(m.fields.quantity.correct, 2);
  assert.equal(m.rowPrecision, 2 / 3);
  assert.equal(m.rowRecall, 2 / 3);
});
test('missing values cannot inflate known accuracy and zero cannot replace absence', () => {
  const c = cases.find((c) => c.id === 'f08-unquoted'),
    j = job(c);
  j.result.draft.items[1].unitPrice.value = '0';
  const m = criticalMetrics([score(c, j)]);
  assert.equal(m.fields.unitPrice.total, 1);
  assert.equal(m.fields.unitPrice.correct, 1);
  assert.equal(m.fields.unitPrice.absentCorrect, 0);
});
test('leading zeros and terms cannot be guessed or silently accepted', () => {
  const c = cases[0],
    j = job(c);
  j.result.draft.taxId.value = '1201';
  j.result.draft.delivery.value = '12 рабочих дней';
  const m = criticalMetrics([score(c, j)]);
  assert.equal(m.fields.taxId.correct, 0);
  assert.equal(m.deliveryHeader.correct, 0);
});
test('exclusive files cannot overwrite protected artifacts', async () => {
  await assert.rejects(
    exclusiveJson(new URL('../../package.json', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'), {}),
    (e) => e.code === 'EEXIST',
  );
});
if (process.argv.includes('--frozen'))
  test('all frozen sources, gold and PDFs retain SHA256', async () => {
    const m = await integrity();
    assert.equal(m.documents.length, 12);
  });
