import { stagePrice, type CommercialPrice } from './stage-calculation';
const price = (amount: string | null, currency = 'RUB', vatMode = 'included'): CommercialPrice => ({
  amount,
  currency,
  vatMode,
});
describe('commercial stages independent of technical saves', () => {
  it('keeps 100000 → 95000 → 90000 → no reply with exact stage discounts', () => {
    const first = stagePrice(price('100000'), { status: 'received', price: price('95000') });
    expect(first.discount).toBe('5');
    const next = stagePrice(first.current, { status: 'received', price: price('90000') });
    expect(next.discount).toBe('5.2632');
    const missing = stagePrice(next.current, { status: 'no_reply' });
    expect(missing.current?.amount).toBe('90000');
    expect(missing.discount).toBe('0');
    expect(missing.status).toBe('no_reply');
  });
  it('does not invent a price when no baseline exists', () => {
    expect(stagePrice(null, { status: 'no_reply' })).toEqual({
      current: null,
      discount: null,
      status: 'no_reply',
    });
  });
  it('keeps a pending response distinct from explicitly no reply', () => {
    expect(stagePrice(price('100'), { status: 'pending' }).discount).toBeNull();
  });
  it('does not carry an offer after withdrawal', () => {
    const withdrawn = stagePrice(price('100'), { status: 'withdrawn' });
    expect(withdrawn.current).toBeNull();
    expect(stagePrice(withdrawn.current, { status: 'no_reply' }).current).toBeNull();
  });
  it.each([price('90', 'USD'), price('90', 'RUB', 'excluded')])(
    'never compares different monetary bases',
    (p) => {
      expect(stagePrice(price('100'), { status: 'received', price: p }).discount).toBeNull();
    },
  );
  it('handles zero and price increases', () => {
    expect(stagePrice(price('0'), { status: 'received', price: price('10') }).discount).toBeNull();
    expect(stagePrice(price('100'), { status: 'received', price: price('110') }).discount).toBe('-10');
    expect(stagePrice(price('0'), { status: 'no_reply' }).discount).toBe('0');
  });
});
