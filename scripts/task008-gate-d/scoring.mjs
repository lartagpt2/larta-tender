import Decimal from 'decimal.js';
// Strict, reproducible comparison. No LLM judge, fuzzy substring or post-hoc accepted answers.
const norm = (s) =>
  s === null || s === undefined
    ? null
    : String(s)
        .normalize('NFKC')
        .toLowerCase()
        .replace(/ё/g, 'е')
        .replace(/[«»„“”"']/g, '')
        .replace(/\s+/g, ' ')
        .trim();
const value = (f) => f?.value ?? null;
export function score(gold, job) {
  const actual = job.result?.draft,
    checks = [],
    errors = [];
  const check = (path, expected, observed) => {
    const correct = norm(expected) === norm(observed);
    checks.push({ path, expected, actual: observed, correct, expectedMissing: expected === null });
    if (!correct)
      errors.push({
        path,
        expected,
        actual: observed,
        type: expected === null ? 'unexpected_non_null' : observed === null ? 'missing' : 'mismatch',
      });
  };
  for (const [k, v] of Object.entries(gold.headers)) check(k, v, value(actual?.[k]));
  const rows = actual?.items ?? [],
    used = new Set();
  let matched = 0;
  for (const [i, row] of gold.items.entries()) {
    const j = rows.findIndex((r, n) => !used.has(n) && norm(value(r.description)) === norm(row.description));
    if (j >= 0) {
      used.add(j);
      matched++;
    }
    for (const [k, v] of Object.entries(row)) check(`items[${i}].${k}`, v, j < 0 ? null : value(rows[j][k]));
  }
  const extra = rows
    .map((r, i) =>
      used.has(i)
        ? null
        : { path: `unmatchedItems[${i}]`, actual: value(r.description), type: 'unmatched_row' },
    )
    .filter(Boolean);
  errors.push(...extra);
  const known = checks.filter((c) => !c.expectedMissing),
    unknown = checks.filter((c) => c.expectedMissing);
  return {
    id: gold.id,
    status: job.status,
    error: job.error ?? null,
    expectedRows: gold.items.length,
    actualRows: rows.length,
    matchedRows: matched,
    rowPrecision: rows.length ? matched / rows.length : 0,
    rowRecall: matched / gold.items.length,
    knownCorrect: known.filter((c) => c.correct).length,
    knownTotal: known.length,
    unknownCorrect: unknown.filter((c) => c.correct).length,
    unknownTotal: unknown.length,
    supplierCorrect: checks.filter((c) => ['supplierName', 'taxId'].includes(c.path)).every((c) => c.correct),
    buyerAsSupplier: !!actual && norm(value(actual.supplierName)) === norm(gold.headers.buyerName),
    critical: checks.filter(
      (c) =>
        ['supplierName', 'taxId', 'total', 'currency', 'delivery', 'payment', 'deliveryCost'].includes(
          c.path,
        ) || /\.(quantity|unitPrice|lineTotal|delivery)$/.test(c.path),
    ),
    expectedWarnings: gold.expectedWarnings ?? [],
    missingWarnings: (gold.expectedWarnings ?? []).filter((w) => !job.warnings?.includes(w)),
    warnings: job.warnings ?? [],
    checks,
    errors,
  };
}
export function aggregate(results) {
  const sum = (k) => results.reduce((n, r) => n + r[k], 0);
  const critical = results.flatMap((r) => r.critical);
  return {
    documents: results.length,
    completed: results.filter((r) => r.status === 'needs_review').length,
    exactRowCounts: results.filter((r) => r.actualRows === r.expectedRows).length,
    supplierCorrect: results.filter((r) => r.supplierCorrect).length,
    buyerAsSupplier: results.filter((r) => r.buyerAsSupplier).length,
    knownCorrect: sum('knownCorrect'),
    knownTotal: sum('knownTotal'),
    knownAccuracy: sum('knownCorrect') / sum('knownTotal'),
    nullCorrect: sum('unknownCorrect'),
    nullTotal: sum('unknownTotal'),
    nonNullWhenMissing: results.flatMap((r) => r.errors).filter((e) => e.type === 'unexpected_non_null')
      .length,
    criticalCorrect: critical.filter((c) => c.correct).length,
    criticalTotal: critical.length,
    byField: Object.fromEntries(
      [
        ...new Set(results.flatMap((r) => r.checks.map((c) => c.path.replace(/items\[\d+\]\./, 'items.')))),
      ].map((k) => {
        const fields = results
          .flatMap((r) => r.checks)
          .filter((c) => c.path.replace(/items\[\d+\]\./, 'items.') === k);
        return [
          k,
          {
            correct: fields.filter((c) => c.correct).length,
            total: fields.length,
            knownCorrect: fields.filter((c) => !c.expectedMissing && c.correct).length,
            knownTotal: fields.filter((c) => !c.expectedMissing).length,
            missingCorrect: fields.filter((c) => c.expectedMissing && c.correct).length,
            missingTotal: fields.filter((c) => c.expectedMissing).length,
          },
        ];
      }),
    ),
  };
}

// Secondary model-output view. Strip only literal labels and the authored unit/currency;
// never guess missing values or substitute expected numbers. Business validation is unchanged.
export function scoreRaw(gold, job) {
  const copy = structuredClone(job),
    draft = copy.result?.draft;
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const number = (raw, suffixes) => {
    if (raw === null || raw === undefined) return null;
    let s = String(raw)
      .trim()
      .replace(
        /^(Количество|Qty|Quantity|Цена|Сумма|Итого по товарам|Итого|Total|Amount|UnitPrice)\s*:?\s*/i,
        '',
      );
    for (const suffix of suffixes.filter(Boolean))
      s = s.replace(new RegExp('\\s*' + escape(suffix) + '$', 'i'), '').trim();
    if (!/^(?:\d{1,3}(?:[ \u00a0]\d{3})+|\d+)(?:[.,]\d+)?$/.test(s)) return raw;
    return new Decimal(s.replace(/[ \u00a0]/g, '').replace(',', '.')).toFixed();
  };
  if (draft) {
    for (const [key, f] of Object.entries(draft))
      if (key !== 'items')
        f.value = ['total', 'deliveryCost'].includes(key)
          ? number(f.rawValue, [gold.headers.currency])
          : f.rawValue;
    for (const row of draft.items) {
      const expected = gold.items.find((i) => norm(i.description) === norm(row.description.rawValue));
      for (const [key, f] of Object.entries(row))
        f.value = ['quantity', 'unitPrice', 'lineTotal'].includes(key)
          ? number(f.rawValue, [expected?.unit, gold.headers.currency])
          : f.rawValue;
    }
  }
  return score(gold, copy);
}
