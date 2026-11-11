import { emptyDraft, emptyField, itemNames, validateDraft } from './contracts';
import { numeric } from './normalization';
const field = (raw: string, snippet = raw) => ({
  ...emptyField(),
  rawValue: raw,
  value: raw,
  page: 1,
  evidenceSnippet: snippet,
});
const row = () =>
  Object.fromEntries(itemNames.map((k) => [k, emptyField()])) as unknown as ReturnType<
    typeof emptyDraft
  >['items'][number];
it.each(['0000000005', '000000001234'])(
  'preserves every identifier digit including leading zeros: %s',
  (raw) => {
    const d = emptyDraft();
    d.taxId = field(raw, `ИНН поставщика: ${raw}`);
    const r = validateDraft(d, [{ page: 1, text: `ИНН поставщика: ${raw}` }]);
    expect(r.draft.taxId.value).toBe(raw);
  },
);
it('does not repair omitted INN zeros by guessing or select buyer tax', () => {
  const d = emptyDraft();
  d.taxId = field('000000005', 'ИНН поставщика: 000000005');
  const r = validateDraft(d, [{ page: 1, text: 'ИНН поставщика: 000000005' }]);
  expect(r.draft.taxId.rawValue).toBe('000000005');
  expect(r.draft.taxId.value).toBeNull();
  expect(r.warnings).toContain('tax_id_invalid_format');
  d.taxId = field('9999999999', 'ИНН покупателя: 9999999999');
  const wrong = validateDraft(d, [{ page: 1, text: 'ИНН покупателя: 9999999999' }]);
  expect(wrong.draft.taxId.value).toBeNull();
  expect(wrong.warnings).toContain('tax_id_wrong_role');
});
it.each([
  ['2,5 м', '2.5'],
  ['0,75 кг', '0.75'],
  ['3 м', '3'],
  ['0 кг', '0'],
  ['1\u202f234,50 м', '1234.5'],
])('parses literal quantity %s without floating point', (raw, value) =>
  expect(numeric(raw, 'quantity')).toBe(value),
);
it('rejects incompatible units, ranges, exponents and money in quantity', () => {
  for (const raw of ['2 RUB', '2-3 м', '1e3 кг', '1 2 м', '-5 кг'])
    expect(numeric(raw, 'quantity')).toBeNull();
  expect(numeric('500 кг', 'money')).toBeNull();
  expect(numeric('500 ZZZ', 'money')).toBe('500');
});
it('recovers printed kg independently without guessing a missing unit', () => {
  const d = emptyDraft();
  const r = row();
  r.quantity = field('0,75 кг');
  d.items = [r];
  const actual = validateDraft(d, [{ page: 1, text: '0,75 кг' }]).draft.items[0];
  expect(actual.quantity.value).toBe('0.75');
  expect(actual.unit.value).toBe('кг');
  expect(actual.quantity.rawValue).toBe('0,75 кг');
  r.quantity = field('5');
  expect(validateDraft(d, [{ page: 1, text: '5' }]).draft.items[0].unit.value).toBeNull();
});
it('normalizes only known text labels while preserving raw conditions and null markers', () => {
  const d = emptyDraft();
  d.delivery = field('Общий срок поставки: DAP, склад № 2; 7 дней');
  d.payment = field('Условия оплаты: 50% после поставки');
  d.vat = field('НДС: НДС включён');
  d.total = field('не указано RUB');
  const text = [d.delivery, d.payment, d.vat, d.total].map((f) => f.rawValue).join('\n'),
    r = validateDraft(d, [{ page: 1, text }]);
  expect(r.draft.delivery.value).toBe('DAP, склад № 2; 7 дней');
  expect(r.draft.payment.value).toBe('50% после поставки');
  expect(r.draft.vat.value).toBe('НДС включён');
  expect(r.draft.total.value).toBeNull();
  expect(r.draft.total.rawValue).toBe('не указано RUB');
});
it('reanchors each literal row value while retaining incorrect shared evidence for audit', () => {
  const d = emptyDraft(),
    r = row(),
    bad = 'Клапан А\nКоличество: 2 шт. | Цена: 500 RUB | Сумма: 1000 RUB\nСрок позиции: 2 рабочих дня';
  r.description = field('Клапан А', bad);
  r.quantity = field('2 шт.', bad);
  r.unitPrice = field('500 RUB', bad);
  r.lineTotal = field('1000 RUB', bad);
  r.currency = field('RUB', bad);
  r.delivery = field('2 рабочих дня', bad);
  d.items = [r];
  const text = 'Клапан А\nКоличество: 2 шт. | Цена: 500 RUB | Сумма: 1000 RUB\nСрок позиции: 2 рабочих дней';
  const actual = validateDraft(d, [{ page: 1, text }]);
  expect(actual.draft.items[0].unitPrice.value).toBe('500');
  expect(actual.draft.items[0].currency.value).toBe('RUB');
  expect(actual.draft.items[0].unitPrice.evidenceSnippet).toBe('Цена: 500 RUB');
  expect(actual.draft.items[0].unitPrice.originalEvidenceSnippet).toBe(bad);
  expect(actual.draft.items[0].delivery.value).toBeNull();
  expect(actual.warnings).toContain('evidence_source_reanchored');
});
it('cannot reanchor a neighboring row, another page, a repeated description or a numeric substring', () => {
  const d = emptyDraft(),
    a = row(),
    b = row();
  a.description = field('Клапан А', 'incorrect snippet');
  a.unitPrice = field('999', 'incorrect snippet');
  b.description = field('Клапан Б');
  d.items = [a, b];
  const text = 'Клапан А\nКоличество: 1 шт. | Цена: 100 RUB\nКлапан Б\nКоличество: 1 шт. | Цена: 999 RUB';
  expect(validateDraft(d, [{ page: 1, text }]).draft.items[0].unitPrice.value).toBeNull();
  a.unitPrice = field('10', 'Клапан А Цена: 100 RUB');
  expect(
    validateDraft(d, [{ page: 1, text: 'Клапан А Цена: 100 RUB' }]).draft.items[0].unitPrice.value,
  ).toBeNull();
  a.unitPrice = field('1', 'Клапан А Цена: 1.25 RUB');
  expect(
    validateDraft(d, [{ page: 1, text: 'Клапан А Цена: 1.25 RUB' }]).draft.items[0].unitPrice.value,
  ).toBeNull();
  a.unitPrice = field('500', 'Клапан А Цена: 500,00 RUB');
  expect(
    validateDraft(d, [{ page: 1, text: 'Клапан А Цена: 500,00 RUB' }]).draft.items[0].unitPrice.value,
  ).toBe('500');
  a.unitPrice = field('100', 'incorrect snippet');
  expect(
    validateDraft(d, [{ page: 1, text: 'Клапан А\nЦена: 100 RUB\nКлапан А\nЦена: 100 RUB' }]).draft.items[0]
      .unitPrice.value,
  ).toBeNull();
  a.unitPrice.page = 2;
  expect(
    validateDraft(d, [
      { page: 1, text },
      { page: 2, text: 'Цена: 100 RUB' },
    ]).draft.items[0].unitPrice.value,
  ).toBeNull();
});
it('compares unknown-currency literal arithmetic but never combines different currencies', () => {
  const d = emptyDraft(),
    r = row();
  r.quantity = field('2');
  r.unitPrice = field('500 ZZZ');
  r.lineTotal = field('900 ZZZ');
  r.currency = field('ZZZ');
  d.items = [r];
  d.currency = field('ZZZ');
  d.total = field('1500 ZZZ');
  const text = '2 500 ZZZ 900 ZZZ 1500 ZZZ';
  const result = validateDraft(d, [{ page: 1, text }]);
  expect(result.draft.items[0].unitPrice.value).toBe('500');
  expect(result.warnings).toEqual(
    expect.arrayContaining(['unknown_currency', 'line_arithmetic_mismatch', 'total_arithmetic_mismatch']),
  );
  expect(d.items[0].unitPrice.value).toBe('500 ZZZ');
  const second = row();
  second.quantity = field('1');
  second.unitPrice = field('10');
  second.lineTotal = field('10');
  second.currency = field('USD');
  d.items.push(second);
  d.currency = emptyField();
  const mixed = validateDraft(d, [{ page: 1, text: text + ' 1 10 USD' }]);
  expect(mixed.warnings).toContain('mixed_currency');
  expect(mixed.warnings).not.toContain('total_arithmetic_mismatch');
});

it('treats whitespace and label-only values as missing without looping on empty evidence', () => {
  const d = emptyDraft();
  d.total = field('   ', 'Printed total');
  d.payment = field('Условия оплаты:');
  const result = validateDraft(d, [{ page: 1, text: 'Printed total\nУсловия оплаты:' }]);
  expect(result.draft.total.value).toBeNull();
  expect(result.draft.payment.value).toBeNull();
  expect(result.draft.total.rawValue).toBe('   ');
});
