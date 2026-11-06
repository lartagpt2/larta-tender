import { test, expect } from '@playwright/test';
const unique = (name: string) => `${name} ${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
test('title-only purchase persists, skips and reopens specification without losing the purchase', async ({
  page,
}) => {
  const title = unique('Только название');
  await page.goto('/tenders/new');
  await page.getByLabel('Название тендера').fill(title);
  await page.getByRole('button', { name: 'Создать тендер', exact: true }).click();
  await expect(page).toHaveURL(/\/documents\?tenderId=/);
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await expect(page.getByText('Сравнение по позициям недоступно:')).toBeVisible();
  await page.getByRole('button', { name: 'Пропустить и свернуть' }).click();
  await expect(page.getByRole('button', { name: 'Загрузить ТЗ позже' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Загрузить ТЗ позже' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Коммерческие предложения' })).toBeVisible();
  await page.getByRole('button', { name: 'Загрузить ТЗ позже' }).click();
  await expect(page.getByLabel('Файл ТЗ')).toBeVisible();
  await page.goto('/tenders');
  await expect(page.getByRole('link', { name: new RegExp(title) })).toBeVisible();
});
test('manual positions and comparison mode persist through reload in both themes', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const title = unique('Три позиции');
  await page.goto('/tenders/new');
  await page.getByLabel('Название тендера').fill(title);
  await page.getByRole('radio', { name: 'Вручную', exact: true }).check();
  await page.getByRole('button', { name: 'Добавить позицию' }).click();
  await page.getByRole('button', { name: 'Добавить позицию' }).click();
  for (const [i, name, quantity, unit] of [
    [1, 'Насос', '2', 'шт.'],
    [2, 'Шкаф', '1', 'компл.'],
    [3, 'Монтаж', '1,5', 'час'],
  ] as const) {
    await page.getByLabel(`Позиция ${i}`, { exact: true }).fill(name);
    await page.getByLabel(`Количество ${i}`, { exact: true }).fill(quantity);
    await page.getByLabel(`Единица ${i}`, { exact: true }).fill(unit);
  }
  await page.getByRole('button', { name: 'Создать тендер', exact: true }).click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Насос', exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: '1.500000', exact: true })).toBeVisible();
  await page.getByLabel('Способ сравнения').selectOption('items');
  await expect(page.getByLabel('Способ сравнения')).toBeEnabled();
  await page.reload();
  await expect(page.getByLabel('Способ сравнения')).toHaveValue('items');
  await expect(page.getByRole('cell', { name: 'Монтаж', exact: true })).toBeVisible();
  await page.getByLabel('Тема оформления').selectOption('current');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: 'test-results/task004-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'Изменить состав' }).click();
  await page.getByLabel('Количество 1', { exact: true }).fill('3');
  await page.getByRole('button', { name: 'Сохранить состав' }).click();
  await expect(page.getByRole('cell', { name: '3.000000', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('cell', { name: '3.000000', exact: true })).toBeVisible();
});
test('specification creation uploads a real original and never invents recognized positions', async ({
  page,
  request,
}) => {
  const title = unique('Через ТЗ');
  await page.goto('/tenders/new');
  await page.getByLabel('Название тендера').fill(title);
  await page.getByRole('radio', { name: 'Через ТЗ', exact: true }).check();
  await page.getByLabel('Файл ТЗ').setInputFiles({
    name: 'synthetic-tz.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('Синтетическое ТЗ. Насос 2 шт.'),
  });
  await page.getByRole('button', { name: 'Создать тендер', exact: true }).click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await expect(page.getByText('synthetic-tz.txt', { exact: true })).toBeVisible();
  await expect(page.getByText('Ожидает обработки', { exact: true })).toBeVisible();
  const id = new URL(page.url()).searchParams.get('tenderId')!;
  await page.reload();
  await expect(page.getByText('synthetic-tz.txt', { exact: true })).toBeVisible();
  const scope = await request.get(`/api/tenders/${id}/scope`);
  expect((await scope.json()).items).toEqual([]);
  const docs = await request.get(`/api/tenders/${id}/tz`);
  expect((await docs.json())[0].status).toBe('uploaded');
  await page.screenshot({ path: 'test-results/task004-specification.png', fullPage: true });
});
