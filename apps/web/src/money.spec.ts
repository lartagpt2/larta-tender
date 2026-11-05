import { describe, expect, it } from 'vitest';
import { moneyToMinorUnits, offerTotal } from '../../../packages/shared/src';
describe('deterministic offer totals', () => {
  it('avoids floating point rounding', () => {
    expect(offerTotal('0.1', '0.2')).toBe('0.30');
  });
  it('accepts Russian decimal notation', () => {
    expect(moneyToMinorUnits('1 234,56')).toBe(123456n);
  });
  it('keeps missing or invalid prices unknown', () => {
    expect(offerTotal(null, '2')).toBeNull();
    expect(offerTotal('12.345', '0')).toBeNull();
  });
});
