import type { AIDraft, Evidence } from './contracts';
import { fold, normalizedText, rowEvidence } from './normalization';
export interface CurrencySource {
  kind: 'native_header';
  scope: 'document' | 'table';
  code: string;
  page: number;
  line: number;
  excerpt: string;
  rowPage: number;
  rowLine: number;
  sourceDocumentId?: string;
}
interface Header {
  code: string;
  page: number;
  line: number;
  excerpt: string;
  scope: 'document' | 'table';
}
// Literal headings only; no locale/default currency, fuzzy OCR, cross-document state or model metadata.
export function bindHeaderCurrencies(draft: AIDraft, pages: { page: number; text: string }[]): string[] {
  const warnings = new Set<string>(),
    headers: Header[] = [],
    codes = new Set<string>();
  const lines = pages.map((p) => ({ ...p, lines: p.text.split(/\r?\n/) }));
  for (const p of lines)
    for (const [n, excerpt] of p.lines.entries()) {
      if (excerpt.length > 2000) continue;
      const text = fold(excerpt),
        global =
          /^(?:Валюта(?: предложения| документа| КП)?|Currency(?: of (?:quote|document))?)\s*:\s*([A-Z]{3})[.;]?$/iu.exec(
            text,
          );
      if (global) {
        headers.push({
          code: global[1].toUpperCase(),
          page: p.page,
          line: n + 1,
          excerpt,
          scope: 'document',
        });
        codes.add(global[1].toUpperCase());
      }
      // A table heading is text with price/amount labels, a literal ISO-like code and no numeric data.
      if (!/\d/.test(text) && /(?:Цена|Сумма|Unit price|Amount)/iu.test(text)) {
        for (const code of text.match(/\b[A-Z]{3}\b/g) ?? []) {
          headers.push({ code, page: p.page, line: n + 1, excerpt, scope: 'table' });
          codes.add(code);
        }
      }
      // Any other explicitly printed monetary code vetoes global inheritance when it conflicts.
      for (const m of text.matchAll(/\d[\d\s.,]*\s+([A-Z]{3})(?![A-Za-z])/g)) codes.add(m[1]);
    }
  if (new Set(headers.filter((h) => h.scope === 'document').map((h) => h.code)).size > 1) {
    draft.currency.value = null;
    warnings.add('currency_header_missing_or_ambiguous');
  }
  for (const [index, item] of draft.items.entries()) {
    const page = lines.find((p) => p.page === item.description.page);
    if (!page?.text.trim()) {
      if (item.currency.value === null) warnings.add('currency_header_unverifiable');
      continue; // A scan is still an unconfirmed vision draft; never label its heading verified.
    }
    const original = item.currency;
    const direct = original.value !== null && rowEvidence(draft, index, 'currency', original, page.text);
    if (direct) continue;
    const proposed =
      original.rawValue === null ? null : normalizedText('currency', original.rawValue).toUpperCase();
    const anchor = item.description.value;
    const anchors = anchor
      ? page.lines
          .map((s, n) => {
            const text = fold(s),
              name = fold(anchor);
            return text === name ||
              text.startsWith(name + ' |') ||
              (text.startsWith(name + ' ') && /^\d/.test(text.slice(name.length).trim()))
              ? n
              : -1;
          })
          .filter((n) => n >= 0)
      : [];
    const priced = [item.unitPrice, item.lineTotal].some((f) => f.value !== null && f.page === page.page);
    const global = headers.filter((h) => h.scope === 'document');
    const rowLine = anchors[0] ?? -1;
    const table = headers
      .filter(
        (h) =>
          h.scope === 'table' &&
          h.page === page.page &&
          h.line <= rowLine + 1 &&
          !page.lines
            .slice(h.line, rowLine)
            .some(
              (s) =>
                /^\s*(?:Итого|Всего|Total|Подытог|Таблица|Раздел)(?:\s|:|$)/iu.test(s) ||
                (!/\d/.test(s) && /(?:Цена|Сумма|Unit price|Amount)/iu.test(s)),
            ),
      )
      .sort((a, b) => b.line - a.line);
    const candidates = global.length ? global : table.slice(0, 1);
    const h = candidates[0];
    if (
      !h ||
      codes.size !== 1 ||
      !codes.has(h.code) ||
      anchors.length !== 1 ||
      !priced ||
      (proposed !== null && proposed !== h.code)
    ) {
      original.value = null;
      warnings.add('currency_header_missing_or_ambiguous');
      continue;
    }
    const source: CurrencySource = {
      kind: 'native_header',
      scope: h.scope,
      code: h.code,
      page: h.page,
      line: h.line,
      excerpt: h.excerpt,
      rowPage: page.page,
      rowLine: rowLine + 1,
    };
    // rawValue is the unchanged model transcription, including null. The bound value is draft-only.
    item.currency = {
      ...original,
      value: h.code,
      page: h.page,
      evidenceSnippet: h.excerpt,
      originalEvidenceSnippet: original.evidenceSnippet,
      evidenceMethod: 'native_header_currency',
      currencySource: source,
    } satisfies Evidence;
    warnings.add('currency_from_verified_header');
    if (!['RUB', 'USD', 'EUR', 'CNY'].includes(h.code)) warnings.add('unknown_currency');
  }
  return [...warnings];
}
