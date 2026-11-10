import { calculate, discount, lineTotal, noReply, ranks, csv, type PriceSnapshot } from './calculation';
const base = (): PriceSnapshot => ({
  fields: {
    amount: '100000',
    currency: 'RUB',
    vatMode: 'included',
    paymentTerms: '100% после поставки',
    deliveryTerms: '7 дней',
    compliance: 'matches',
  },
  items: [],
  costs: [],
  costsEnabled: false,
  intent: 'confirm',
  questions: [],
});
const required = [
  { id: 'a', name: 'Насос', quantity: '2', unit: 'шт' },
  { id: 'b', name: 'Шкаф', quantity: '1', unit: 'шт' },
  { id: 'c', name: 'Монтаж', quantity: '1', unit: 'услуга' },
];
describe('Decimal commercial comparison', () => {
  it.each([
    ['0.1', '0.2', '0.02'],
    ['3', '0.1', '0.3'],
    ['0.000001', '0.000001', '0.000000000001'],
    ['999999999999', '99999999999999.999999', '99999999999899999999000000.000001'],
  ])('quantity %s × %s = exact %s', (q, p, total) => {
    expect(lineTotal(q, p)).toBe(total);
  });
  it('keeps missing price distinct from free goods', () => {
    expect(lineTotal('2', null)).toBeNull();
    expect(lineTotal('2', '0')).toBe('0');
  });
  it('computes all required lines and never substitutes missing third price with zero', () => {
    const s = base();
    s.items = [
      { lotItemId: 'a', quantity: '2', unit: 'шт.', unitPrice: '100.1' },
      { lotItemId: 'b', quantity: '1', unit: 'шт', unitPrice: '20.2' },
    ];
    expect(calculate(s, required, 'lot').comparable).toBeNull();
    expect(calculate(s, required, 'lot').rankable).toBe(false);
    s.items.push({ lotItemId: 'c', quantity: '1', unit: 'услуга', unitPrice: '0' });
    expect(calculate(s, required, 'lot').base).toBe('220.4');
    expect(calculate(s, required, 'items', 'a').base).toBe('200.2');
  });
  it('rejects ranking for quantities/units that need normalization', () => {
    const s = base();
    s.items = [{ lotItemId: 'a', quantity: '2', unit: 'кг', unitPrice: '10' }];
    expect(calculate(s, [required[0]], 'lot').comparable).toBeNull();
    s.items[0].unit = 'шт';
    s.items[0].quantity = '3';
    expect(calculate(s, [required[0]], 'lot').rankable).toBe(false);
  });
  it('expenses are off by default; enabled add differs from included', () => {
    const s = base();
    expect(calculate(s, [], 'lot').comparable).toBe('100000');
    s.costs = [{ name: 'Доставка', amount: '10000', currency: 'RUB', treatment: 'add' }];
    s.costsEnabled = true;
    expect(calculate(s, [], 'lot').comparable).toBe('110000');
    s.costs[0].treatment = 'included';
    expect(calculate(s, [], 'lot').comparable).toBe('100000');
  });
  it('unknown expenses are not zero even if manual cost accounting is switched off', () => {
    const s = base();
    s.costs = [{ name: 'Доставка', amount: null, currency: null, treatment: 'unknown' }];
    expect(calculate(s, [], 'lot').comparable).toBeNull();
    expect(calculate(s, [], 'lot').extra).toBeNull();
  });
  it('does not add expenses in a different currency or allocate lot expenses to items', () => {
    const s = base();
    s.costsEnabled = true;
    s.costs = [{ name: 'Доставка', amount: '10', currency: 'USD', treatment: 'add' }];
    expect(calculate(s, [], 'lot').comparable).toBeNull();
    s.costs[0].currency = 'RUB';
    s.items = [{ lotItemId: 'a', quantity: '2', unit: 'шт', unitPrice: '10' }];
    expect(calculate(s, [required[0]], 'items', 'a').comparable).toBeNull();
  });
  it('fixing delivery by phone does not clear another question', () => {
    const s = base();
    s.fields.deliveryTerms = null;
    expect(calculate(s, [], 'lot').warnings.map((w) => w.code)).toContain('delivery');
    s.fields.deliveryTerms = '7 дней';
    expect(calculate(s, [], 'lot').rankable).toBe(true);
    s.questions = [{ id: 'manual', text: 'Нужна проверка гарантии', resolved: false }];
    expect(calculate(s, [], 'lot').warnings.map((w) => w.code)).toEqual(['manual:manual']);
    s.questions[0].resolved = true;
    expect(calculate(s, [], 'lot').rankable).toBe(true);
  });
  it.each(['currency', 'paymentTerms', 'deliveryTerms'] as const)('missing %s blocks ranking', (key) => {
    const s = base();
    s.fields[key] = null;
    expect(calculate(s, [], 'lot').rankable).toBe(false);
  });
  it('does not call a draft or unknown VAT/compliance verified', () => {
    const s = base();
    s.intent = 'draft';
    expect(calculate(s, [], 'lot').rankable).toBe(false);
    s.intent = 'confirm';
    s.fields.vatMode = 'unknown';
    s.fields.compliance = 'partial';
    expect(calculate(s, [], 'lot').warnings.map((w) => w.code)).toEqual(['vat', 'compliance']);
  });
  it.each([
    ['100000', '95000', '5'],
    ['95000', '90000', '5.2632'],
    ['100000', '90000', '10'],
    ['100', '110', '-10'],
    ['100', '100', '0'],
    ['0', '10', null],
    ['0', '0', null],
    [null, '10', null],
    ['10', null, null],
  ])('discount %s → %s = %s', (before, after, value) => expect(discount(before, after)).toBe(value));
  it('no response preserves last confirmed amount and records zero stage change', () => {
    expect(noReply('90000')).toEqual({ amount: '90000', stageDiscount: '0', response: 'no_reply' });
    expect(noReply(null).amount).toBeNull();
  });
  it('ranks ties and excludes incomplete data', () => {
    expect(
      ranks([
        { value: '10', rankable: true, currency: 'RUB', vatMode: 'included' },
        { value: '10', rankable: true, currency: 'RUB', vatMode: 'included' },
        { value: '9', rankable: false, currency: 'RUB', vatMode: 'included' },
        { value: '11', rankable: true, currency: 'RUB', vatMode: 'included' },
      ]),
    ).toEqual([1, 1, null, 3]);
  });
  it.each([
    ['USD', 'included'],
    ['RUB', 'excluded'],
    ['RUB', 'unknown'],
    [null, 'included'],
  ])('never ranks incompatible currency/VAT %s/%s', (currency, vatMode) => {
    expect(
      ranks([
        { value: '10', rankable: true, currency: 'RUB', vatMode: 'included' },
        { value: '9', rankable: true, currency, vatMode: vatMode! },
      ]),
    ).toEqual([null, null]);
  });
  it('exports quoted attributed values and protects spreadsheet formulas', () => {
    const value = csv(
      [{ key: 'source', label: 'Источник', values: ['Телефон; "7 дней"\nЗакупщик', '=DANGEROUS()'] }],
      ['А', 'Б'],
    );
    expect(value).toContain('"Телефон; ""7 дней""\nЗакупщик"');
    expect(value).toContain('"\'=DANGEROUS()"');
    expect(value).toContain('"Показатель";"А";"Б"');
  });
});
