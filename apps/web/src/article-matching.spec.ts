import { describe, it, expect } from 'vitest';
import { suggestArticles } from '@tender/shared';
import { aiLineIssue } from './ai-line-transfer';
const field = (value: string | null) => ({ value });
const target = { id: 'a', name: 'Энкодер СО-981' },
  other = { id: 'b', name: 'Энкодер CO-981' };
const item = {
  description: field('Энкодер CO-981'),
  sku: field(null),
  quantity: field('3'),
  unit: field('шт.'),
  unitPrice: field('286.4'),
  currency: field('EUR'),
};
const row = { quantity: '3', unit: 'шт.', unitPrice: null };
describe('homoglyph suggestions preserve raw spelling and require human confirmation', () => {
  it('detects Unicode differences, offers only supplied TZ targets and never mutates', () => {
    const before = structuredClone(item),
      required = [target, other];
    const result = suggestArticles(item.description.value, null, required);
    expect(result.candidates).toEqual([
      { ...target, sourceArticle: 'CO-981', targetArticle: 'СО-981', reason: 'visual_homoglyph' },
    ]);
    expect(result.originals).toContain('CO-981');
    expect(result.ambiguous[0].characters.map((c) => c.codepoint)).toEqual(['U+0043', 'U+004F']);
    expect(item).toEqual(before);
    expect(required).toEqual([target, other]);
  });
  it('preserves multiple candidates without selecting either', () => {
    const r = suggestArticles('Энкодер CO-981', null, [target, { id: 'c', name: 'Другой энкодер СO-981' }]);
    expect(r.candidates).toHaveLength(2);
    expect(r).not.toHaveProperty('selected');
  });
  it('does not propose a different digit, punctuation or arbitrary similar word', () => {
    expect(
      suggestArticles('Энкодер CO-981', null, [
        { id: 'x', name: 'Энкодер СО-982' },
        { id: 'y', name: 'Энкодер СО981' },
      ]).candidates,
    ).toHaveLength(0);
    expect(suggestArticles('насос', null, [{ id: 'x', name: 'наcоc' }]).candidates).toHaveLength(0);
  });
  it('handles explicit SKU, mixed scripts, missing data and an empty lot', () => {
    expect(suggestArticles(null, 'СO-981', [target]).ambiguous[0].mixedScripts).toBe(true);
    expect(suggestArticles(null, 'CO-981', [target]).candidates).toHaveLength(1);
    expect(suggestArticles(null, null, [target]).candidates).toHaveLength(0);
    expect(suggestArticles('Энкодер CO-981', null, []).candidates).toHaveLength(0);
  });
  it('limits untrusted document tokens and candidate output', () => {
    const r = suggestArticles(
      'CO-981',
      null,
      Array.from({ length: 100 }, (_, i) => ({ id: String(i), name: 'СО-981' })),
    );
    expect(r.candidates).toHaveLength(20);
    expect(r.truncated).toBe(true);
  });
  it('does not copy a price for an unconfirmed or arbitrary description mismatch', () => {
    expect(aiLineIssue(item, row, target, 'EUR', false)).toContain('явно подтвердите');
    expect(aiLineIssue(item, row, { id: 'z', name: 'Другая позиция ZZ-123' }, 'EUR', true)).toContain(
      'явно подтвердите',
    );
  });
  it('permits only the explicit confirmed candidate with matching quantity, unit and currency', () => {
    expect(aiLineIssue(item, row, target, 'EUR', true)).toBeNull();
    expect(aiLineIssue(item, { ...row, unitPrice: '1' }, target, 'EUR', true)).toContain('уже заполнена');
    expect(aiLineIssue(item, { ...row, quantity: '12' }, target, 'EUR', true)).toContain('Количество');
    expect(aiLineIssue(item, { ...row, unit: 'кг' }, target, 'EUR', true)).toContain('Количество');
    expect(aiLineIssue(item, row, undefined, 'EUR', true)).toContain('лоту');
  });
  it.each([null, 'USD', 'ZZZ'])('blocks copying a price when the form currency is %s', (currency) => {
    expect(aiLineIssue(item, row, target, currency, true)).toContain('валют');
  });
  it('blocks unknown or absent row currency even for exact names', () => {
    expect(aiLineIssue({ ...item, currency: field('ZZZ') }, row, other, 'ZZZ', false)).toContain('валют');
    expect(aiLineIssue({ ...item, currency: field(null) }, row, other, 'EUR', false)).toContain('валют');
  });
});
