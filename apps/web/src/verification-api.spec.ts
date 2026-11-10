import { describe, it, expect } from 'vitest';
import { decimalInput, emptyFields, normalizedFields } from './verification-api';
describe('manual commercial decimal input', () => {
  it('preserves exact digits when converting Russian input to the NUMERIC protocol', () => {
    expect(decimalInput('99 999 999 999 999,999999')).toBe('99999999999999.999999');
    expect(decimalInput('0,000001')).toBe('0.000001');
  });
  it('distinguishes unknown amounts from explicit zero', () => {
    expect(decimalInput(' ')).toBeNull();
    expect(decimalInput(null)).toBeNull();
    expect(decimalInput('0,00')).toBe('0.00');
  });
  it('does not invent values for a different supplier', () => {
    const fields = emptyFields();
    expect(normalizedFields(fields)).toEqual({
      amount: null,
      currency: null,
      vatMode: 'unknown',
      paymentTerms: null,
      deliveryTerms: null,
      compliance: 'unknown',
    });
  });
});
