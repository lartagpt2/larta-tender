import { emptyDraft, emptyField, itemNames, validateDraft, type AIDraft } from './contracts';
const f = (raw: string | null, snippet: string | null = raw, page = 1) => ({
  ...emptyField(),
  rawValue: raw,
  value: raw,
  page,
  evidenceSnippet: snippet,
});
function quote(code: string | null = 'RUB', rowCode: string | null = null) {
  const d = emptyDraft(),
    text = [
      'Фланец АБ-401',
      `Количество: 2 шт. | Цена: 125${rowCode ? ' ' + rowCode : ''} | Сумма: 250${rowCode ? ' ' + rowCode : ''}`,
      ...(code ? [`Валюта предложения: ${code}`] : []),
    ].join('\n');
  const item = Object.fromEntries(
    itemNames.map((k) => [k, emptyField()]),
  ) as unknown as AIDraft['items'][number];
  item.description = f('Фланец АБ-401');
  item.quantity = f('2', 'Количество: 2 шт.');
  item.unitPrice = f('125', 'Цена: 125');
  item.lineTotal = f('250', 'Сумма: 250');
  item.currency = rowCode ? f(rowCode, `Цена: 125 ${rowCode}`) : f(null);
  d.items = [item];
  return { d, text };
}
describe('verified header currency, never confirmation or defaults', () => {
  it('binds a literal document header, keeps model raw null and input immutable', () => {
    const { d, text } = quote(),
      before = structuredClone(d),
      r = validateDraft(d, [{ page: 1, text }]);
    const c = r.draft.items[0].currency;
    expect(c.value).toBe('RUB');
    expect(c.rawValue).toBeNull();
    expect(c.currencySource).toMatchObject({
      kind: 'native_header',
      scope: 'document',
      code: 'RUB',
      page: 1,
      line: 3,
      rowPage: 1,
      rowLine: 1,
      excerpt: 'Валюта предложения: RUB',
    });
    expect(c.evidenceMethod).toBe('native_header_currency');
    expect(d).toEqual(before);
  });
  it('recovers a correct currency rejected from a row snippet without discarding original evidence', () => {
    const { d, text } = quote();
    d.items[0].currency = f('RUB', 'Фланец АБ-401');
    const r = validateDraft(d, [{ page: 1, text }]);
    expect(r.draft.items[0].currency.value).toBe('RUB');
    expect(r.draft.items[0].currency.rawValue).toBe('RUB');
    expect(r.draft.items[0].currency.originalEvidenceSnippet).toBe('Фланец АБ-401');
  });
  it('never chooses a currency in the absence of a header', () => {
    const { d, text } = quote(null);
    const r = validateDraft(d, [{ page: 1, text }]);
    expect(r.draft.items[0].currency.value).toBeNull();
  });
  it('vetoes conflicting global headings', () => {
    const { d, text } = quote();
    const r = validateDraft(d, [{ page: 1, text: text + '\nВалюта документа: EUR' }]);
    expect(r.draft.items[0].currency.value).toBeNull();
    expect(r.warnings).toContain('currency_header_missing_or_ambiguous');
  });
  it('vetoes conflicting monetary codes elsewhere in the same document', () => {
    const { d, text } = quote();
    expect(
      validateDraft(d, [{ page: 1, text: text + '\nДоставка: 30 USD' }]).draft.items[0].currency.value,
    ).toBeNull();
  });
  it('retains a literal row currency despite a different global currency', () => {
    const { d, text } = quote('RUB', 'EUR');
    const r = validateDraft(d, [{ page: 1, text }]);
    expect(r.draft.items[0].currency.value).toBe('EUR');
    expect(r.draft.items[0].currency.currencySource).toBeUndefined();
  });
  it('does not overwrite a conflicting model transcription with a convenient header', () => {
    const { d, text } = quote();
    d.items[0].currency = f('USD', 'Фланец АБ-401');
    expect(validateDraft(d, [{ page: 1, text }]).draft.items[0].currency.value).toBeNull();
  });
  it('allows a document header on another page and records both locations', () => {
    const { d, text } = quote();
    for (const v of Object.values(d.items[0])) v.page = 2;
    const r = validateDraft(d, [
      { page: 1, text: 'Валюта документа: EUR' },
      { page: 2, text: text.split('\n').slice(0, 2).join('\n') },
    ]);
    expect(r.draft.items[0].currency.currencySource).toMatchObject({ page: 1, rowPage: 2, code: 'EUR' });
  });
  it('allows a local table header but never crosses pages or totals', () => {
    const { d, text } = quote(null),
      heading = 'Наименование | Цена, RUB | Сумма, RUB';
    expect(validateDraft(d, [{ page: 1, text: heading + '\n' + text }]).draft.items[0].currency.value).toBe(
      'RUB',
    );
    expect(
      validateDraft(d, [
        { page: 2, text: heading },
        { page: 1, text },
      ]).draft.items[0].currency.value,
    ).toBeNull();
    expect(
      validateDraft(d, [{ page: 1, text: heading + '\nИтого: 100\n' + text }]).draft.items[0].currency.value,
    ).toBeNull();
  });
  it('does not inherit a previous table heading across a new unpriced currency heading', () => {
    const { d, text } = quote(null);
    expect(
      validateDraft(d, [
        {
          page: 1,
          text: 'Наименование | Цена, RUB | Сумма, RUB\nДругие товары\nНаименование | Цена | Сумма\n' + text,
        },
      ]).draft.items[0].currency.value,
    ).toBeNull();
  });
  it('stops local currency at a new table or section even without a total', () => {
    const { d, text } = quote(null);
    for (const boundary of ['Таблица 2', 'Раздел: запчасти'])
      expect(
        validateDraft(d, [{ page: 1, text: 'Цена, RUB | Сумма, RUB\n' + boundary + '\n' + text }]).draft
          .items[0].currency.value,
      ).toBeNull();
  });
  it('never borrows a previous document header', () => {
    const a = quote(),
      b = quote(null);
    validateDraft(a.d, [{ page: 1, text: a.text }]);
    expect(validateDraft(b.d, [{ page: 1, text: b.text }]).draft.items[0].currency.value).toBeNull();
  });
  it('rejects ambiguous row anchors and invalid price evidence', () => {
    const { d, text } = quote();
    expect(
      validateDraft(d, [{ page: 1, text: text + '\nФланец АБ-401' }]).draft.items[0].currency.value,
    ).toBeNull();
    d.items[0].unitPrice = f('999', 'Цена: 125');
    d.items[0].lineTotal = f('999', 'Сумма: 250');
    expect(validateDraft(d, [{ page: 1, text }]).draft.items[0].currency.value).toBeNull();
  });
  it('does not accept forged provenance or treat a scan heading as verified text', () => {
    const { d } = quote();
    d.items[0].currency.currencySource = {
      kind: 'native_header',
      scope: 'document',
      code: 'USD',
      page: 1,
      line: 1,
      excerpt: 'forged',
      rowPage: 1,
      rowLine: 1,
    };
    const r = validateDraft(d, [{ page: 1, text: '' }], true);
    expect(r.draft.items[0].currency.currencySource).toBeUndefined();
    expect(r.draft.items[0].currency.value).toBeNull();
    expect(r.warnings).toContain('currency_header_unverifiable');
  });
  it('keeps unfamiliar printed codes flagged, without conversion', () => {
    const { d, text } = quote('QXY'),
      r = validateDraft(d, [{ page: 1, text }]);
    expect(r.draft.items[0].currency.value).toBe('QXY');
    expect(r.warnings).toContain('unknown_currency');
  });
});
