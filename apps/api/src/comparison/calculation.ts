import Decimal from 'decimal.js';
const D = Decimal.clone({ precision: 60, rounding: Decimal.ROUND_HALF_UP });
export interface Fields {
  amount: string | null;
  currency: string | null;
  vatMode: string;
  paymentTerms: string | null;
  deliveryTerms: string | null;
  compliance: string;
}
export interface RequiredItem {
  id: string;
  name: string;
  quantity: string;
  unit: string;
}
export interface ItemPrice {
  lotItemId: string;
  quantity: string;
  unit: string;
  unitPrice: string | null;
}
export interface Cost {
  name: string;
  treatment: string;
  amount: string | null;
  currency: string | null;
}
export interface Warning {
  code: string;
  message: string;
}
export interface Question {
  id: string;
  text: string;
  resolved: boolean;
}
export interface PriceSnapshot {
  fields: Fields;
  items: ItemPrice[];
  costs: Cost[];
  costsEnabled: boolean;
  intent: 'draft' | 'confirm';
  questions: Question[];
}
const normalizedUnit = (value: string) => value.trim().toLocaleLowerCase('ru').replace(/\.$/, '');
export function lineTotal(quantity: string, price: string | null): string | null {
  return price === null ? null : new D(quantity).mul(price).toFixed();
}
export function discount(previous: string | null, current: string | null): string | null {
  if (previous === null || current === null || new D(previous).lte(0)) return null;
  return new D(previous).sub(current).div(previous).mul(100).toDecimalPlaces(4).toFixed();
}
export function noReply(lastConfirmed: string | null) {
  return { amount: lastConfirmed, stageDiscount: lastConfirmed === null ? null : '0', response: 'no_reply' };
}
export function calculate(
  snapshot: PriceSnapshot,
  required: RequiredItem[],
  mode: 'lot' | 'items',
  itemId?: string,
) {
  const { fields, items, costs, costsEnabled } = snapshot,
    warnings: Warning[] = [];
  const warn = (code: string, message: string) => warnings.push({ code, message });
  if (snapshot.intent !== 'confirm') warn('draft', 'Данные не подтверждены');
  if (!fields.currency) warn('currency', 'Не указана валюта');
  if (fields.vatMode === 'unknown') warn('vat', 'Не уточнён НДС');
  if (!fields.paymentTerms?.trim()) warn('payment', 'Не указаны условия оплаты');
  if (!fields.deliveryTerms?.trim()) warn('delivery', 'Не указан срок поставки');
  if (fields.compliance !== 'matches') warn('compliance', 'Не подтверждено соответствие ТЗ');
  for (const q of snapshot.questions.filter((q) => !q.resolved)) warn('manual:' + q.id, q.text);
  const lineValues = required.map((r) => {
    const item = items.find((i) => i.lotItemId === r.id);
    if (!item || item.unitPrice === null) {
      warn('item:' + r.id, 'Нет цены позиции: ' + r.name);
      return null;
    }
    if (normalizedUnit(item.unit) !== normalizedUnit(r.unit) || !new D(item.quantity).eq(r.quantity)) {
      warn('unit:' + r.id, 'Не совпадают количество или единица: ' + r.name);
      return null;
    }
    return lineTotal(item.quantity, item.unitPrice);
  });
  let base: string | null = required.length
    ? lineValues.every((v) => v !== null)
      ? lineValues.reduce((a, v) => new D(a!).add(v!).toFixed(), '0')
      : null
    : fields.amount;
  if (mode === 'items') {
    const index = required.findIndex((r) => r.id === itemId);
    base = index < 0 ? null : lineValues[index];
    if (index < 0) warn('item_context', 'Выберите позицию');
  }
  if (base === null) warn('incomplete', 'Неполный лот или неизвестная цена');
  let extra = new D(0),
    unknownCost = false;
  for (const cost of costs) {
    if (cost.treatment === 'unknown' || cost.amount === null || cost.currency === null) {
      unknownCost = true;
      warn('cost_unknown', 'Не уточнён расход: ' + cost.name);
      continue;
    }
    if (cost.currency !== fields.currency) {
      unknownCost = true;
      warn('cost_currency', 'Валюта расхода отличается: ' + cost.name);
      continue;
    }
    if (costsEnabled && cost.treatment === 'add') extra = extra.add(cost.amount);
  }
  if (mode === 'items' && costsEnabled && costs.some((c) => c.treatment === 'add')) {
    // No implicit allocation of lot-level delivery to individual positions.
    unknownCost = true;
    warn('cost_allocation', 'Расходы лота не распределены по позициям');
  }
  const comparable = base === null || unknownCost ? null : new D(base).add(extra).toFixed();
  return {
    base,
    extra: unknownCost ? null : extra.toFixed(),
    comparable,
    warnings,
    rankable: comparable !== null && warnings.length === 0,
  };
}
export function ranks(
  values: { value: string | null; rankable: boolean; currency: string | null; vatMode: string }[],
): (number | null)[] {
  // Never mix currencies or VAT bases, even when some entries are currently incomplete.
  const comparableBasis = new Set(values.map((v) => `${v.currency ?? 'unknown'}:${v.vatMode}`));
  if (comparableBasis.size !== 1 || values.some((v) => !v.currency || v.vatMode === 'unknown'))
    return values.map(() => null);
  const amounts = values.filter((v) => v.rankable && v.value !== null).map((v) => v.value!);
  return values.map((v) =>
    v.rankable && v.value !== null ? 1 + amounts.filter((a) => new D(a).lt(v.value!)).length : null,
  );
}
export interface ComparisonRow {
  key: string;
  label: string;
  values: string[];
  tone?: string;
}
export function csv(rows: ComparisonRow[], suppliers: string[]): string {
  const cell = (value: string) =>
    '"' +
    (/^[\s]*[=+\-@\t\r\n]/.test(value) && !/^-?\d+(?:\.\d+)?%?$/.test(value) ? "'" : '') +
    value.replace(/"/g, '""') +
    '"';
  return (
    '\uFEFF' +
    [['Показатель', ...suppliers], ...rows.map((r) => [r.label, ...r.values])]
      .map((row) => row.map(cell).join(';'))
      .join('\r\n')
  );
}
