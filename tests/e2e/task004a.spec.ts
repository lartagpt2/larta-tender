import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
test('PDF draft: seven items, source, corrections, explicit confirmation and idempotent repeat', async ({
  page,
  request,
}) => {
  const title = `Synthetic PDF draft ${Date.now()}`;
  await page.goto('/tenders/new');
  await page.getByLabel('Название тендера').fill(title);
  await page.getByRole('radio', { name: 'Через ТЗ', exact: true }).check();
  await page.getByLabel('Файл ТЗ').setInputFiles(resolve('tests/fixtures/tz-seven-items.pdf'));
  await page.getByRole('button', { name: 'Создать тендер', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Черновик ТЗ готов', exact: true })).toBeVisible({
    timeout: 25000,
  });
  await expect(page.getByLabel(/^Черновик позиция /)).toHaveCount(7);
  await expect(page.getByLabel('Количество из ТЗ 1', { exact: true })).toHaveValue('70');
  await expect(page.getByLabel('Технические условия g1')).toHaveValue(/Supergrip \/ Longitudinal ribs/);
  await expect(page.getByLabel('Технические условия g2')).toHaveValue(/PAZ \/ PAR/);
  const id = new URL(page.url()).searchParams.get('tenderId')!;
  let state = await (await request.get(`/api/tenders/${id}/scope`)).json();
  expect(state.items).toHaveLength(0);
  expect(state.scopeStatus).toBe('draft');
  await page.getByRole('button', { name: 'Показать фрагмент PDF · стр. 2', exact: true }).first().click();
  await expect(page.getByTitle('Оригинальный PDF, страница 2')).toBeVisible();
  await page.getByRole('button', { name: 'Закрыть источник' }).click();
  await page.getByRole('button', { name: 'Исправить', exact: true }).click();
  await page.getByLabel('Количество из ТЗ 1', { exact: true }).fill('71');
  await page.getByRole('button', { name: 'Подтвердить состав', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Состав из ТЗ подтверждён', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('cell', { name: '71.000000', exact: true })).toBeVisible();
  state = await (await request.get(`/api/tenders/${id}/scope`)).json();
  expect(state.items).toHaveLength(7);
  expect(state.items[0].technicalRequirements).toContain('NFT, PAZ');
  expect(state.items[5].technicalRequirements).toContain('PAZ / PAR');
  const ids = state.items.map((item: { id: string }) => item.id);
  await page.getByLabel('Способ сравнения').selectOption('items');
  await expect(page.getByLabel('Способ сравнения')).toBeEnabled();
  await page.getByLabel('Файл ТЗ').setInputFiles(resolve('tests/fixtures/tz-seven-items.pdf'));
  await page.getByRole('button', { name: 'Загрузить ТЗ', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Загрузить ТЗ', exact: true })).toBeDisabled();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Состав из ТЗ подтверждён', exact: true })).toBeVisible();
  state = await (await request.get(`/api/tenders/${id}/scope`)).json();
  expect(state.items.map((item: { id: string }) => item.id)).toEqual(ids);
  expect(state.items[0].quantity).toBe('71.000000');
  await page.screenshot({ path: 'test-results/task004a-confirmed.png', fullPage: true });
});
test('text-free PDF needs OCR and does not create a fictitious draft', async ({ page, request }) => {
  await page.goto('/tenders/new');
  await page.getByLabel('Название тендера').fill(`Synthetic scan ${Date.now()}`);
  await page.getByRole('radio', { name: 'Через ТЗ', exact: true }).check();
  await page.getByLabel('Файл ТЗ').setInputFiles(resolve('tests/fixtures/tz-no-text.pdf'));
  await page.getByRole('button', { name: 'Создать тендер', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Требуется OCR или ручной ввод', exact: true })).toBeVisible(
    { timeout: 25000 },
  );
  await expect(page.getByRole('button', { name: 'Подтвердить состав', exact: true })).toHaveCount(0);
  const id = new URL(page.url()).searchParams.get('tenderId')!;
  expect((await (await request.get(`/api/tenders/${id}/scope`)).json()).items).toHaveLength(0);
});
