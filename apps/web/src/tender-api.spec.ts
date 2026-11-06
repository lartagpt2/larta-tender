import { afterEach, describe, it, expect, vi } from 'vitest';
import { api, itemSchema, titleSchema, checkSpecification } from './tender-api';
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

describe('API connection failures', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('shows a useful connection error without retrying a potentially committed write', async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetch);
    await expect(
      api('/tenders', { method: 'POST', body: JSON.stringify({ title: 'Synthetic' }) }),
    ).rejects.toThrow('Нет соединения с сервером');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('keeps HTTP conflicts separate from network failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 409 }));
    await expect(api('/tenders')).rejects.toThrow('Данные изменились');
  });
});
