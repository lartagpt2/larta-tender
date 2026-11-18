import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import TenderList from './TenderList.vue';
import { ARCHIVE_REASON } from './archive-api';
const id = '10000000-0000-4000-8000-000000000001',
  title = 'Синтетический тендер UX';
let state = 'active',
  held = false,
  busy = false,
  canWrite = true,
  hash = 'a'.repeat(64);
let failure = 0,
  network = false,
  calls: Record<string, unknown>[] = [];
let wrapper: VueWrapper | undefined, client: QueryClient;
beforeAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value() {
      this.setAttribute('open', '');
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value() {
      this.removeAttribute('open');
    },
  });
});
afterEach(() => {
  wrapper?.unmount();
  client?.clear();
  vi.unstubAllGlobals();
});
async function setup() {
  state = 'active';
  held = busy = network = false;
  canWrite = true;
  hash = 'a'.repeat(64);
  failure = 0;
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input, 'http://synthetic.invalid');
      const send = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data });
      if (url.pathname.endsWith('/lifecycle/config')) return send({ enabled: true });
      if (url.pathname.endsWith('/lifecycle/page')) {
        const matches = url.searchParams.get('state') === state;
        return send({
          items: matches ? [{ id, title, revision: 1, state }] : [],
          total: matches ? 1 : 0,
          page: 1,
          pageSize: 25,
        });
      }
      if (url.pathname === `/api/tenders/${id}/lifecycle`) {
        if (init?.method === 'POST') {
          calls.push(JSON.parse(init.body as string));
          if (network) throw new TypeError('synthetic connection loss');
          if (failure) return send({}, failure);
          state = 'archived';
        }
        return send(
          {
            id,
            title,
            state,
            revision: 1,
            previewHash: hash,
            canWrite,
            held,
            busy,
            allowed: { archive: canWrite && !held && !busy && state === 'active' },
          },
          init?.method === 'POST' ? 201 : 200,
        );
      }
      throw new Error('Unapproved mock URL: ' + url.pathname);
    }),
  );
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  wrapper = mount(TenderList, {
    attachTo: document.body,
    global: {
      plugins: [[VueQueryPlugin, { queryClient: client }]],
      stubs: { RouterLink: { template: '<a><slot /></a>' } },
    },
  });
  await flushPromises();
  await flushPromises();
  return wrapper;
}
function button(text: string) {
  return wrapper!.findAll('button').find((b) => b.text() === text)!;
}
async function open() {
  await button('В архив').trigger('click');
  await flushPromises();
}
async function confirm() {
  await button('Да, в архив').trigger('click');
  await flushPromises();
  await flushPromises();
}
describe('registry archive confirmation, synthetic mocked API only', () => {
  it('shows exact title and two buttons without identity/reason/action inputs', async () => {
    await setup();
    await open();
    expect(wrapper!.find('dialog').attributes()).toHaveProperty('open');
    expect(wrapper!.find('dialog').text()).toContain(title);
    expect(wrapper!.find('dialog').findAll('input,select,textarea')).toHaveLength(0);
    expect(document.activeElement).toBe(button('Отмена').element);
    expect(button('Отмена')).toBeTruthy();
    expect(button('Да, в архив')).toBeTruthy();
    expect(calls).toHaveLength(0);
  });
  it('cancel performs no POST', async () => {
    await setup();
    await open();
    await button('Отмена').trigger('click');
    expect(calls).toHaveLength(0);
    expect(wrapper!.find('dialog').attributes('open')).toBeUndefined();
  });
  it('Escape closes without mutation', async () => {
    await setup();
    await open();
    await wrapper!.find('dialog').trigger('cancel');
    expect(wrapper!.find('dialog').attributes('open')).toBeUndefined();
    expect(calls).toHaveLength(0);
  });
  it('posts server identity, fresh hash and automatic reason; refreshes both lists and counts', async () => {
    await setup();
    await open();
    await confirm();
    expect(calls).toEqual([
      {
        action: 'archive',
        confirmationId: id,
        confirmationTitle: title,
        previewHash: hash,
        reason: ARCHIVE_REASON,
      },
    ]);
    expect(wrapper!.text()).toContain('перемещён в архив');
    expect(wrapper!.text()).toContain('Активные: 0 · Архив: 1');
    expect(wrapper!.findAll('strong')).toHaveLength(0);
    await wrapper!.find('select').setValue('archived');
    await flushPromises();
    await flushPromises();
    expect(wrapper!.text()).toContain(title);
    expect(wrapper!.findAll('button').some((b) => b.text() === 'В архив')).toBe(false);
  });
  it.each([
    [false, false, false, 'нет прав'],
    [true, true, false, 'тендер защищён'],
    [true, false, true, 'сейчас обрабатывается'],
  ])('blocks rights=%s hold=%s busy=%s', async (write, hold, active, message) => {
    await setup();
    canWrite = write as boolean;
    held = hold as boolean;
    busy = active as boolean;
    await client.invalidateQueries({ queryKey: ['tender-lifecycle'] });
    await flushPromises();
    expect(button('В архив').attributes('disabled')).toBeDefined();
    expect(wrapper!.text()).toContain(message);
    expect(calls).toHaveLength(0);
  });
  it('checks fresh hold when opening after eligibility was cached', async () => {
    await setup();
    held = true;
    await open();
    expect(calls).toHaveLength(0);
    expect(wrapper!.text()).toContain('тендер защищён');
  });
  it('changed hash during dialog needs another confirmation and never retries automatically', async () => {
    await setup();
    await open();
    hash = 'b'.repeat(64);
    await confirm();
    expect(calls).toHaveLength(0);
    expect(wrapper!.text()).toContain('Состояние тендера изменилось');
    await confirm();
    expect(calls).toHaveLength(1);
    expect(calls[0].previewHash).toBe(hash);
  });
  it('409 refreshes preview but does not repeat POST', async () => {
    await setup();
    await open();
    failure = 409;
    await confirm();
    expect(calls).toHaveLength(1);
    expect(wrapper!.find('dialog').text()).toContain('Состояние тендера изменилось');
    expect(button('Отмена').attributes('disabled')).toBeUndefined();
  });
  it.each([403, 404, 500])('HTTP %s resets loading and keeps cancel usable', async (code) => {
    await setup();
    await open();
    failure = code;
    await confirm();
    expect(calls).toHaveLength(1);
    expect(button('Отмена').attributes('disabled')).toBeUndefined();
    expect(button('Да, в архив').attributes('disabled')).toBeDefined();
    expect(wrapper!.find('dialog').find('[role="alert"]').exists()).toBe(true);
    await button('Отмена').trigger('click');
    expect(wrapper!.find('dialog').attributes('open')).toBeUndefined();
  });
  it('network uncertainty blocks a new POST until an explicit state check', async () => {
    await setup();
    await open();
    network = true;
    await confirm();
    expect(calls).toHaveLength(1);
    expect(wrapper!.text()).toContain('Проверьте состояние тендера перед повтором');
    expect(button('Да, в архив').attributes('disabled')).toBeDefined();
    network = false;
    await button('Проверить состояние').trigger('click');
    await flushPromises();
    expect(calls).toHaveLength(1);
    expect(button('Да, в архив').attributes('disabled')).toBeUndefined();
  });
  it('double click produces only one POST', async () => {
    await setup();
    await open();
    const target = button('Да, в архив');
    await Promise.all([target.trigger('click'), target.trigger('click')]);
    await flushPromises();
    await flushPromises();
    expect(calls).toHaveLength(1);
  });
});
