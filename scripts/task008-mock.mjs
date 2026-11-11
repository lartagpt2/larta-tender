import contracts from '../apps/api/dist/document-ai/contracts.js';
import { gold } from './task008-fixtures.mjs';
export function mockDraft(pages) {
  const field = (value, page, snippet) => ({
    ...contracts.emptyField(),
    rawValue: value,
    value,
    page,
    evidenceSnippet: snippet,
  });
  const text = pages
      .map((p) => p.text)
      .join('\n')
      .trim(),
    source = text || 'Synthetic raster evidence',
    d = contracts.emptyDraft();
  d.supplierName = field(gold.supplierName, 1, text ? `Seller: ${gold.supplierName}` : source);
  d.buyerName = field(gold.buyerName, 1, text ? `Buyer: ${gold.buyerName}` : source);
  d.taxId = field(gold.taxId, 1, text ? `Seller tax ID: ${gold.taxId}` : source);
  d.email = field(gold.email, 1, text ? `Email printed in document: ${gold.email}` : source);
  const total = text.includes('1260 RUB') ? '1260' : '1400',
    factor = total === '1260' ? 0.9 : 1;
  d.currency = field('RUB', 2, text ? `Grand total: ${total} RUB` : source);
  d.total = field(total, 2, d.currency.evidenceSnippet);
  d.payment = field('After delivery', 2, text ? 'Payment: After delivery' : source);
  d.delivery = field('7 days', 2, text ? 'Delivery: 7 days' : source);
  d.vat = field('included', 2, text ? 'VAT: included' : source);
  d.items = gold.items.map((item) => {
    const row = Object.fromEntries(contracts.itemNames.map((k) => [k, contracts.emptyField()]));
    const snippet = text
      ? pages
          .find((p) => p.page === item.page)
          .text.split('\n')
          .find((s) => s.startsWith(item.name))
      : source;
    for (const [key, value] of Object.entries({
      description: item.name,
      quantity: item.quantity,
      unit: item.unit,
      unitPrice: String(Number(item.unitPrice) * factor),
      lineTotal: String(Number(item.lineTotal) * factor),
      currency: 'RUB',
      delivery: item.delivery,
    }))
      row[key] = field(value, item.page, snippet);
    return row;
  });
  return d;
}
