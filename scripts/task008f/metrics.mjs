import { aggregate } from '../task008-gate-d/scoring.mjs';
const groups = {
  supplier: (p) => p === 'supplierName',
  taxId: (p) => p === 'taxId',
  nomenclature: (p) => /^items\[\d+\]\.description$/.test(p),
  quantity: (p) => /^items\[\d+\]\.quantity$/.test(p),
  unitPrice: (p) => /^items\[\d+\]\.unitPrice$/.test(p),
  delivery: (p) => p === 'delivery' || /^items\[\d+\]\.delivery$/.test(p),
};
export function criticalMetrics(results) {
  const checks = results.flatMap((r) => r.checks);
  const summarize = (selected) => {
    const known = selected.filter((c) => !c.expectedMissing),
      missing = selected.filter((c) => c.expectedMissing);
    const correct = known.filter((c) => c.correct).length;
    return {
      correct,
      total: known.length,
      accuracy: known.length ? correct / known.length : null,
      absentCorrect: missing.filter((c) => c.correct).length,
      absentTotal: missing.length,
      errors: selected.filter((c) => !c.correct),
    };
  };
  const fields = Object.fromEntries(
    Object.entries(groups).map(([k, test]) => [k, summarize(checks.filter((c) => test(c.path)))]),
  );
  const matched = results.reduce((n, r) => n + r.matchedRows, 0),
    actual = results.reduce((n, r) => n + r.actualRows, 0),
    expected = results.reduce((n, r) => n + r.expectedRows, 0);
  return {
    fields,
    deliveryHeader: summarize(checks.filter((c) => c.path === 'delivery')),
    deliveryItems: summarize(checks.filter((c) => /^items\[\d+\]\.delivery$/.test(c.path))),
    rowPrecision: actual ? matched / actual : 0,
    rowRecall: expected ? matched / expected : 0,
    matchedRows: matched,
    actualRows: actual,
    expectedRows: expected,
    documentsAllCriticalCorrect: results.filter(
      (r) =>
        r.checks.filter((c) => Object.values(groups).some((test) => test(c.path))).every((c) => c.correct) &&
        r.actualRows === r.expectedRows,
    ).length,
    aggregate: aggregate(results),
  };
}
