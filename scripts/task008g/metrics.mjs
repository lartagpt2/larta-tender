export function priceCurrency(scores, gold) {
  const paired = [],
    unknown = [],
    missing = [];
  for (const c of gold) {
    const r = scores.find((r) => r.id === c.id);
    for (const [i, row] of c.items.entries()) {
      const checks = r.checks,
        field = (k) => checks.find((x) => x.path === `items[${i}].${k}`)?.correct === true;
      const record = {
        id: c.id,
        index: i,
        description: row.description,
        price: row.unitPrice,
        currency: row.currency,
        correct: field('description') && field('unitPrice') && field('currency'),
      };
      if (row.unitPrice === null) missing.push(record);
      else if (row.currency === null) unknown.push(record);
      else paired.push(record);
    }
  }
  const sum = (rows) => ({
    correct: rows.filter((r) => r.correct).length,
    total: rows.length,
    accuracy: rows.length ? rows.filter((r) => r.correct).length / rows.length : null,
    errors: rows.filter((r) => !r.correct),
  });
  return { knownPairs: sum(paired), pricedUnknownCurrency: sum(unknown), unpriced: sum(missing) };
}
