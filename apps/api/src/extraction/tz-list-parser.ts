import type { TextPage } from './pdf-text.service';
export interface DraftItem {
  sourceIndex: number;
  number: number;
  name: string;
  quantity: string | null;
  unit: string | null;
  page: number;
  excerpt: string;
  technicalRequirements: string;
}
export interface TechnicalGroup {
  id: string;
  numbers: number[];
  text: string;
  pages: number[];
}
export interface ParsedDraft {
  items: DraftItem[];
  groups: TechnicalGroup[];
  diagnostics: string[];
}
const excluded =
  /^(?:версия|редакция|дата|подпись|реквизиты|корд|ширина|покрытие|согласовано|лист изменений)(?:\s|$)/i;
const technical = /^(?:корд|ширина|покрытие|на зубчатой|с обратной|технические требования)/i;
export function parseTzList(pages: TextPage[]): ParsedDraft {
  const items: DraftItem[] = [],
    groups: TechnicalGroup[] = [],
    diagnostics: string[] = [];
  let pending: { number: number; body: string; page: number } | undefined;
  let recent: number[] = [];
  let group: TechnicalGroup | undefined;
  let listContext = false;
  const flush = () => {
    if (!pending) return;
    const { number, page } = pending;
    const body = pending.body.trim();
    pending = undefined;
    if (excluded.test(body)) return;
    const match = /(?:^|[\s–—-])(\d+(?:[.,]\d+)?)\s*(шт\.?|штук[аи]?)\s*[.;]?$/i.exec(body);
    if (!match && !listContext && !/^(?:ремень|насос|шкаф|монтаж|оборудование)(?:\s|$)/i.test(body)) return;
    const name = (match ? body.slice(0, match.index) : body).replace(/[\s–—-]+$/, '').trim();
    if (!name || items.length >= 100) {
      diagnostics.push('item_limit_or_empty_name');
      return;
    }
    const quantity = match?.[1].replace(',', '.') ?? null;
    const valid =
      quantity !== null && /^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/.test(quantity) && /[1-9]/.test(quantity);
    if (!valid) diagnostics.push('quantity_requires_review');
    if (items.some((i) => i.number === number)) diagnostics.push('duplicate_number');
    items.push({
      sourceIndex: items.length + 1,
      number,
      name,
      quantity: valid ? quantity : null,
      unit: match ? 'шт.' : null,
      page,
      excerpt: body,
      technicalRequirements: '',
    });
    recent.push(number);
  };
  for (const { page, text } of pages) {
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.replace(/\u00a0/g, ' ').trim();
      if (!line) continue;
      if (/^(?:реквизиты|подписи|таблица версий|история изменений|согласовано)/i.test(line)) {
        flush();
        group = undefined;
        listContext = false;
        recent = [];
        continue;
      }
      const range = /(?:позици[ийямх]+|поз\.)\s*(\d{1,3})\s*(?:[–—-]|и|,)\s*(\d{1,3})/i.exec(line);
      if (range) {
        flush();
        const a = Number(range[1]),
          b = Number(range[2]);
        const numbers = b >= a && b - a < 100 ? Array.from({ length: b - a + 1 }, (_, i) => a + i) : [];
        group = { id: `g${groups.length + 1}`, numbers, text: line, pages: [page] };
        groups.push(group);
        recent = [];
        continue;
      }
      const numbered = /^(\d{1,3})[.)](?:\s+(.*))?$/.exec(line);
      if (numbered) {
        flush();
        group = undefined;
        pending = { number: Number(numbered[1]), body: numbered[2] ?? '', page };
        continue;
      }
      if (technical.test(line)) {
        flush();
        if (!group) {
          group = { id: `g${groups.length + 1}`, numbers: [...recent], text: '', pages: [] };
          groups.push(group);
          recent = [];
        }
        group.text += (group.text ? '\n' : '') + line;
        if (!group.pages.includes(page)) group.pages.push(page);
        continue;
      }
      if (group) {
        if (group.text.length < 8000) group.text += '\n' + line;
        if (!group.pages.includes(page)) group.pages.push(page);
        continue;
      }
      if (pending) {
        pending.body += ' ' + line;
        continue;
      }
      if (/перечень|состав закупки|наименование.*количество/i.test(line)) listContext = true;
    }
  }
  flush();
  for (const item of items)
    item.technicalRequirements = groups
      .filter((g) => g.numbers.includes(item.number))
      .map((g) => g.text)
      .join('\n\n');
  if (!items.length) diagnostics.push('no_recognized_items');
  return { items, groups, diagnostics: [...new Set(diagnostics)] };
}
