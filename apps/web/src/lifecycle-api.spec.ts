import { describe, it, expect, vi, afterEach } from 'vitest';
import { confirmationValid, loadLifecyclePage, type LifecyclePreview } from './lifecycle-api';
const p = {
  id: '10000000-0000-4000-8000-000000000001',
  title: 'Синтетический тендер',
  allowed: { archive: true, classify_synthetic: true, trash: false },
} as unknown as LifecyclePreview;
afterEach(() => vi.unstubAllGlobals());
describe('lifecycle explicit confirmation', () => {
  it('requires exact original title and id, not whitespace or case approximations', () => {
    expect(confirmationValid(p, p.title, p.id, 'Обоснование теста', 'archive', '')).toBe(true);
    expect(confirmationValid(p, p.title + ' ', p.id, 'Обоснование теста', 'archive', '')).toBe(false);
    expect(confirmationValid(p, p.title, p.id.toUpperCase() + '0', 'Обоснование теста', 'archive', '')).toBe(
      false,
    );
  });
  it('requires a reason, explicit capability and synthetic provenance', () => {
    expect(confirmationValid(p, p.title, p.id, '          ', 'archive', '')).toBe(false);
    expect(confirmationValid(p, p.title, p.id, 'Обоснование теста', 'trash', '')).toBe(false);
    expect(confirmationValid(p, p.title, p.id, 'Обоснование теста', 'classify_synthetic', '')).toBe(false);
    expect(
      confirmationValid(p, p.title, p.id, 'Обоснование теста', 'classify_synthetic', 'Тестовый источник'),
    ).toBe(true);
  });
  it('sends state, page and literal search to server', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ items: [], total: 0 }) });
    vi.stubGlobal('fetch', fetch);
    await loadLifecyclePage('archived', 2, 'КП & test_%');
    const url = new URL(fetch.mock.calls[0][0], 'http://localhost');
    expect(url.searchParams.get('search')).toBe('КП & test_%');
    expect(url.searchParams.get('page')).toBe('2');
    expect(url.searchParams.get('state')).toBe('archived');
  });
});
