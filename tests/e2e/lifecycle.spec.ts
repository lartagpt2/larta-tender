import { test, expect } from '@playwright/test';
const id = '10000000-0000-4000-8000-000000000001',
  title = 'Синтетический тест жизненного цикла';
test('server filters, exact confirmation, archive and restore without deleting related data', async ({
  page,
}) => {
  let state = 'active';
  const requests: Record<string, unknown>[] = [];
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url()),
      path = url.pathname;
    const send = (data: unknown, status = 200) => route.fulfill({ status, json: data });
    if (path === '/api/health') return send({ status: 'ok' });
    if (path === '/api/tenders/lifecycle/config') return send({ enabled: true });
    if (path === '/api/tenders/lifecycle/page')
      return send({
        items:
          url.searchParams.get('state') === state
            ? [{ id, title, revision: 1, state, classification: 'unclassified' }]
            : [],
        total: url.searchParams.get('state') === state ? 1 : 0,
        page: 1,
        pageSize: 25,
      });
    if (path === `/api/tenders/${id}/lifecycle`) {
      if (route.request().method() === 'POST') {
        const body = route.request().postDataJSON();
        requests.push(body);
        expect(body.confirmationId).toBe(id);
        expect(body.confirmationTitle).toBe(title);
        state = body.action === 'archive' ? 'archived' : 'active';
      }
      return send({
        id,
        title,
        state,
        classification: 'unclassified',
        previewHash: 'a'.repeat(64),
        counts: { document: 2, offer_version: 3, audit_event: 7 },
        sharedBlobs: 1,
        ocr: { jobs: [], active: 0 },
        allowed: {
          archive: state === 'active',
          restore: state === 'archived',
          trash: false,
          classify_synthetic: false,
        },
      });
    }
    return send({ message: 'Unexpected synthetic mock route' }, 404);
  });
  await page.goto('/tenders');
  await page.getByRole('button', { name: 'Архив / восстановление / корзина' }).click();
  await page.getByRole('button', { name: 'Проверить состояние и зависимости' }).click();
  await page.getByRole('combobox', { name: 'Действие', exact: true }).selectOption('archive');
  const submit = page.getByRole('button', { name: 'Подтвердить операцию' });
  await expect(submit).toBeDisabled();
  await page.getByLabel('Введите точное название').fill(title + ' ');
  await page.getByLabel('Введите ID тендера').fill(id);
  await page.getByLabel('Причина (от 10 символов)').fill('Синтетическая проверка архивирования');
  await expect(submit).toBeDisabled();
  expect(requests).toHaveLength(0);
  await page.getByLabel('Введите точное название').fill(title);
  await submit.click();
  await expect(page.getByRole('link', { name: new RegExp(title) })).toHaveCount(0);
  expect(requests).toHaveLength(1);
  expect(requests[0].action).toBe('archive');
  await page.getByRole('combobox', { name: 'Состояние', exact: true }).selectOption('archived');
  await page.getByRole('button', { name: 'Архив / восстановление / корзина' }).click();
  await expect(
    page.getByText('Архив или корзина: тендер доступен для чтения.', { exact: false }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Проверить состояние и зависимости' }).click();
  await page.getByRole('combobox', { name: 'Действие', exact: true }).selectOption('restore');
  await page.getByLabel('Введите точное название').fill(title);
  await page.getByLabel('Введите ID тендера').fill(id);
  await page.getByLabel('Причина (от 10 символов)').fill('Восстановление синтетического тендера');
  await submit.click();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1].action).toBe('restore');
  await page.getByRole('combobox', { name: 'Состояние', exact: true }).selectOption('active');
  await expect(page.getByRole('link', { name: new RegExp(title) })).toBeVisible();
});
test('server pagination and literal search are used instead of the former top-100 limit', async ({
  page,
}) => {
  const seen: string[] = [];
  await page.route('**/api/**', async (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === '/api/health') return route.fulfill({ json: { status: 'ok' } });
    if (u.pathname === '/api/tenders/lifecycle/config') return route.fulfill({ json: { enabled: true } });
    if (u.pathname === '/api/tenders/lifecycle/page') {
      seen.push(u.search);
      return route.fulfill({
        json: {
          items: [{ id, title: 'Синтетическая страница ' + u.searchParams.get('page'), revision: 1 }],
          total: 26,
          page: Number(u.searchParams.get('page')),
          pageSize: 25,
        },
      });
    }
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto('/tenders');
  await page.getByRole('button', { name: 'Далее', exact: true }).click();
  await expect(page.getByText('Страница 2', { exact: true })).toBeVisible();
  await page.getByRole('searchbox').fill('Тест_%');
  await expect
    .poll(() =>
      seen.some(
        (s) =>
          new URLSearchParams(s).get('search') === 'Тест_%' && new URLSearchParams(s).get('page') === '1',
      ),
    )
    .toBe(true);
});
