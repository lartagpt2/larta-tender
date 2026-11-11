import { describe, it, expect, vi, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';
import DocumentAIPanel from './DocumentAIPanel.vue';
import { api } from './tender-api';
vi.mock('./tender-api', () => ({ api: vi.fn() }));
const f = (value: string | null) => ({
  rawValue: value,
  value,
  page: 1,
  evidenceSnippet: value,
  confidence: null,
});
const item = {
  description: f('Энкодер CO-981'),
  sku: f(null),
  quantity: f('3'),
  unit: f('шт.'),
  unitPrice: f('286.4'),
  currency: {
    ...f(null),
    value: 'EUR',
    currencySource: {
      kind: 'native_header',
      scope: 'document',
      code: 'EUR',
      page: 2,
      line: 4,
      excerpt: 'Валюта документа: EUR',
      rowPage: 1,
      rowLine: 7,
      sourceDocumentId: 'document-a',
    },
  },
};
const job = {
  id: 'job-a',
  documentId: 'document-a',
  receiptId: 'receipt-a',
  supplierId: null,
  lotId: 'lot-a',
  name: 'Synthetic',
  status: 'needs_review',
  revision: 1,
  error: null,
  warnings: [],
  reviews: [],
  events: [],
  result: { draft: { items: [item] }, model: 'synthetic-test', digest: null, durationMs: 1 },
};
const required = [{ id: 'tz-a', name: 'Энкодер СО-981', quantity: '3', unit: 'шт.' }];
const clients: QueryClient[] = [];
afterEach(() => {
  for (const c of clients) c.clear();
  clients.length = 0;
  vi.clearAllMocks();
});
async function panel() {
  vi.mocked(api).mockImplementation(async (path) =>
    path.endsWith('/document-ai') ? { enabled: true, syntheticOnly: true, jobs: [job] } : job,
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  clients.push(client);
  const wrapper = mount(DocumentAIPanel, {
    props: {
      tenderId: 'tender-a',
      documentId: 'document-a',
      receiptId: 'receipt-a',
      lotId: 'lot-a',
      kind: 'offer',
      requiredItems: required,
    },
    global: { plugins: [[VueQueryPlugin, { queryClient: client }]] },
  });
  await flushPromises();
  await vi.waitFor(() => expect(wrapper.text()).toContain('Возможное совпадение с ТЗ'));
  return wrapper;
}
describe('buyer confirms article suggestions, source remains unchanged', () => {
  it('shows header provenance and raw Unicode, does not auto-select, requires explicit checkbox', async () => {
    const w = await panel(),
      original = structuredClone(job),
      select = w.get('select[aria-label="Позиция ТЗ для строки ИИ 1"]');
    expect((select.element as HTMLSelectElement).value).toBe('');
    expect(w.text()).toContain('U+0043');
    expect(w.text()).toContain('U+004F');
    expect(w.get('.currency-source').text()).toContain('document-a');
    expect(w.get('.currency-source').text()).toContain('Валюта документа: EUR');
    await w
      .findAll('button')
      .find((b) => b.text().startsWith('Выбрать кандидата ТЗ:'))!
      .trigger('click');
    const transfer = w.findAll('button').find((b) => b.text() === 'Ввести цену в пустую строку')!;
    expect((select.element as HTMLSelectElement).value).toBe('tz-a');
    expect(transfer.attributes('disabled')).toBeDefined();
    expect(w.emitted('use-line')).toBeUndefined();
    await w.get('input[type="checkbox"]').setValue(true);
    await transfer.trigger('click');
    expect(w.emitted('use-line')?.[0]).toEqual([item, 'tz-a', 'job-a', true]);
    expect(job).toEqual(original);
    w.unmount();
  });
  it('clears a previous confirmation when TZ changes', async () => {
    const w = await panel();
    await w
      .findAll('button')
      .find((b) => b.text().startsWith('Выбрать кандидата ТЗ:'))!
      .trigger('click');
    await w.get('input[type="checkbox"]').setValue(true);
    await w.setProps({ requiredItems: [{ ...required[0], quantity: '4' }] });
    expect(
      (w.get('select[aria-label="Позиция ТЗ для строки ИИ 1"]').element as HTMLSelectElement).value,
    ).toBe('');
    await w
      .findAll('button')
      .find((b) => b.text().startsWith('Выбрать кандидата ТЗ:'))!
      .trigger('click');
    expect((w.get('input[type="checkbox"]').element as HTMLInputElement).checked).toBe(false);
    expect(w.emitted('use-line')).toBeUndefined();
    w.unmount();
  });
});
