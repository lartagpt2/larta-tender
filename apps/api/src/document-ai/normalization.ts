import type { AIDraft, Evidence } from './contracts';
import Decimal from 'decimal.js';
const ExactDecimal = Decimal.clone({ precision: 60 });
export const fold = (s: string) => s.normalize('NFKC').replace(/\s+/g, ' ').trim();
const units = /^(?:pcs|pieces|шт\.?|м|кг|m|kg)$/i;
export function numeric(
  raw: string | null,
  kind: 'generic' | 'quantity' | 'money' = 'generic',
): string | null {
  if (raw === null) return null;
  const match = fold(raw).match(
    /^(?:(?:Qty|Quantity|Количество|UnitPrice|Unit price|Цена|Amount|Сумма|Grand total|Total|Итого(?: по товарам)?|Стоимость доставки(?: отдельно от итога товаров)?)\s*:?\s*)?((?:\d{1,3}(?: \d{3})+|\d+)(?:[.,]\d{1,6})?)\s*([^\d\s].*)?$/i,
  );
  if (!match) return null;
  const suffix = match[2] ?? '';
  if (suffix) {
    const unit = units.test(suffix),
      currency = /^(?:[A-Z]{3}|руб\.?|₽)$/i.test(suffix) && !unit;
    if (!(kind === 'quantity' ? unit : kind === 'money' ? currency : unit || currency)) return null;
  }
  const value = match[1].replace(/ /g, '').replace(',', '.');
  if (!/^(?:0|[1-9]\d{0,13})(?:\.\d{1,6})?$/.test(value)) return null;
  return new ExactDecimal(value).toFixed();
}
export function printedUnit(raw: string | null) {
  return (
    raw
      ?.normalize('NFKC')
      .trim()
      .match(/\s(pcs|pieces|шт\.?|м|кг|m|kg)$/i)?.[1] ?? null
  );
}
const labels: Record<string, RegExp> = {
  supplierName: /^(?:Поставщик(?: \(продавец\))?|Продавец|Seller|Supplier)\s*:\s*/i,
  buyerName: /^(?:Покупатель(?: \(заказчик\))?|Заказчик|Buyer)\s*:\s*/i,
  taxId: /^(?:ИНН(?: поставщика| продавца)?|Seller tax ID|Tax ID)\s*:\s*/i,
  currency: /^(?:Валюта|Currency)\s*:\s*/i,
  delivery: /^(?:Общий срок поставки|Срок поставки|Срок позиции|Поставка|Delivery)\s*:\s*/i,
  payment: /^(?:Условия оплаты|Оплата|Payment)\s*:\s*/i,
  vat: /^(?:НДС|VAT)\s*:\s*/i,
};
export function normalizedText(key: string, raw: string) {
  return raw
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(labels[key] ?? /$^/, '');
}
export function absent(raw: string) {
  return /^(?:не указан[аоы]?|нет данных|not specified|n\/a)(?:\s+[A-Z]{3})?$/iu.test(fold(raw));
}
// Literal matching with numeric boundaries prevents accepting 10 from the printed 100.
export function containsRaw(text: string, raw: string) {
  const source = fold(text),
    needle = fold(raw);
  if (!needle) return false;
  let i = -1;
  while ((i = source.indexOf(needle, i + 1)) >= 0) {
    if (/^\d/.test(needle) && i > 0 && /\d/.test(source[i - 1])) continue;
    if (/\d$/.test(needle) && /\d/.test(source[i + needle.length] ?? '')) continue;
    // A fractional neighbor is part of the same number: 1 must not match 1.25.
    // Equivalent trailing decimal zeros are safe and do not discard a correct numeric value.
    if (
      /\d$/.test(needle) &&
      (/^[.,]\d/.test(source.slice(i + needle.length)) || /\d[.,]$/.test(source.slice(0, i)))
    ) {
      let left = i,
        right = i + needle.length;
      while (left > 0 && /[\d.,]/.test(source[left - 1])) left--;
      while (right < source.length && /[\d.,]/.test(source[right])) right++;
      const literal = numeric(source.slice(left, right)),
        proposed = numeric(needle);
      if (literal === null || proposed === null || literal !== proposed) continue;
    }
    return true;
  }
  return false;
}
const segmentLabels: Record<string, RegExp> = {
  quantity: /^(?:Количество|Qty|Quantity)\s*:/i,
  unit: /^(?:Количество|Qty|Quantity)\s*:/i,
  unitPrice: /^(?:Цена|UnitPrice|Unit price)\s*:/i,
  lineTotal: /^(?:Сумма|Amount)\s*:/i,
  delivery: /^(?:Срок позиции|Срок поставки|Delivery)\s*:/i,
};
// Re-anchor ONLY a unique, literal description and adjacent labelled row data on the same page.
// The replacement is exact source text; an unrelated page-wide value is never accepted.
export function rowEvidence(
  draft: AIDraft,
  index: number,
  key: string,
  field: Evidence,
  text: string,
): string | null {
  const description = draft.items[index].description;
  if (description.page !== field.page || !description.rawValue || !field.rawValue) return null;
  const anchor = fold(description.rawValue),
    lines = text.split(/\r?\n/).map(fold);
  if (!anchor) return null;
  const matches = lines
    .map((line, n) =>
      line === anchor ||
      line.startsWith(anchor + ' |') ||
      new RegExp('^' + escape(anchor) + '\\s+\\d').test(line)
        ? n
        : -1,
    )
    .filter((n) => n >= 0);
  if (matches.length !== 1) return null;
  const start = matches[0],
    block = [lines[start]];
  const peers = draft.items
    .filter((_, i) => i !== index)
    .map((i) => (i.description.rawValue ? fold(i.description.rawValue) : null))
    .filter(Boolean);
  for (let n = start + 1; n < Math.min(lines.length, start + 3); n++) {
    if (peers.some((p) => lines[n].includes(p!))) break;
    if (
      !/^(?:Количество|Qty|Quantity|Цена|Сумма|UnitPrice|Amount|Срок позиции|Срок поставки|Delivery)\s*:/i.test(
        lines[n],
      )
    )
      break;
    block.push(lines[n]);
  }
  const segments = block.flatMap((s) => s.split('|').map(fold));
  const eligible = segmentLabels[key]
    ? segments.filter((s) => segmentLabels[key].test(s))
    : key === 'description'
      ? [lines[start]]
      : segments;
  const exact = eligible.filter((s) => containsRaw(s, field.rawValue!));
  if (key === 'currency' && exact.length) {
    const codes = new Set(
      segments
        .filter((s) => /^(?:Цена|Сумма|UnitPrice|Amount)\s*:/i.test(s))
        .flatMap((s) => s.match(/\b[A-Z]{3}\b/g) ?? []),
    );
    if (codes.size === 1 && codes.has(field.rawValue.toUpperCase())) return exact[0];
  }
  return exact.length === 1 ? exact[0] : null;
}
function escape(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
