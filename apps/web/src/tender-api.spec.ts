import { describe, it, expect } from 'vitest';
import { itemSchema, titleSchema, checkSpecification } from './tender-api';
describe('purchase input', () => {
  it('normalizes decimal commas without floating point conversion', () => {
    expect(itemSchema.parse({ name: 'Насос', quantity: '2,000001', unit: 'шт.' }).quantity).toBe('2.000001');
  });
  it.each(['0', '-1', '1e3', '0.0000001', '1000000000000'])(
    'rejects invalid NUMERIC(18,6) quantity %s',
    (quantity) => {
      expect(itemSchema.safeParse({ name: 'Synthetic', quantity, unit: 'шт.' }).success).toBe(false);
    },
  );
  it('requires meaningful title and units', () => {
    expect(titleSchema.safeParse(' ').success).toBe(false);
    expect(itemSchema.safeParse({ name: 'x', quantity: '2', unit: ' ' }).success).toBe(false);
  });
  it('rejects empty or unsupported files', () => {
    expect(checkSpecification(new File([], 'empty.txt'))).toBeDefined();
    expect(checkSpecification(new File(['x'], 'unsafe.zip'))).toBeDefined();
  });
});
