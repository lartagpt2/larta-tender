import { test, expect } from '@playwright/test';
test('create supplier without email, flag duplicates, and persist independent receipts', async ({
  page,
  request,
}) => {
  const r = await request.post('/api/tenders', { data: { title: `Synthetic TASK005B ${Date.now()}` } });
  expect(r.status()).toBe(201);
  const id = (await r.json()).id;
  expect((await (await request.get(`/api/tenders/${id}/suppliers`)).json()).length).toBe(0);
  await page.goto(`/tenders/${id}`);
  const files = [0, 1].map((i) => ({
    name: `supplier-${i}.pdf`,
    mimeType: 'application/pdf',
    buffer: Buffer.from(`%PDF-1.7 synthetic 005B ${i}`),
  }));
  await page.getByLabel('Файлы КП', { exact: true }).setInputFiles(files);
  await page.getByRole('button', { name: 'Загрузить КП', exact: true }).click();
  await expect(page.getByLabel('Результаты загрузки').getByRole('listitem')).toHaveCount(2);
  const row = (name: string) =>
    page.locator('.document-list > li').filter({ has: page.getByRole('link', { name, exact: true }) });
  await row(files[0].name).getByRole('button', { name: 'Уточнить', exact: true }).click();
  await page.getByRole('button', { name: 'Создать нового поставщика', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Создать и привязать', exact: true })).toBeDisabled();
  const supplier = 'Synthetic new browser supplier';
  await page.getByLabel('Наименование нового поставщика', { exact: true }).fill(supplier);
  await page.getByLabel('Основание', { exact: true }).fill('Synthetic explicit supplier choice');
  await page.getByRole('button', { name: 'Создать и привязать', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Создать и привязать', exact: true })).toHaveCount(0);
  await page.reload();
  await expect(row(files[0].name)).toContainText('Связь подтверждена');
  await expect(page.locator('.offer-group > summary').filter({ hasText: supplier })).toHaveCount(1);
  const suppliers = await (await request.get(`/api/tenders/${id}/suppliers`)).json();
  expect(suppliers).toHaveLength(1);
  expect(suppliers[0].email).toBeNull();
  await row(files[1].name).getByRole('button', { name: 'Уточнить', exact: true }).click();
  await page.getByRole('button', { name: 'Создать нового поставщика', exact: true }).click();
  await page.getByLabel('Наименование нового поставщика', { exact: true }).fill(supplier);
  await page.getByLabel('Основание', { exact: true }).fill('Synthetic separate legal entity');
  await expect(page.getByText(/Возможные дубликаты среди поставщиков тендера/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Создать и привязать', exact: true })).toBeDisabled();
  await page.getByRole('checkbox', { name: /Создать отдельного поставщика/ }).check();
  await page.getByRole('button', { name: 'Создать и привязать', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Создать и привязать', exact: true })).toHaveCount(0);
  expect((await (await request.get(`/api/tenders/${id}/suppliers`)).json()).length).toBe(2);
  // New selection is an independent intake, re-clicking the same selection retries the same operation.
  await page.getByLabel('Файлы КП', { exact: true }).setInputFiles([files[0]]);
  await page.getByRole('button', { name: 'Загрузить КП', exact: true }).click();
  await expect(
    page.getByLabel(`История поступлений ${files[0].name}`).getByText('Поступления: 2', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Загрузить КП', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Загрузить КП', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Новое поступление этих файлов', exact: true }).click();
  await expect(
    page.getByLabel(`История поступлений ${files[0].name}`).getByText('Поступления: 3', { exact: true }),
  ).toBeVisible();
  await page.reload();
  const history = page.getByLabel(`История поступлений ${files[0].name}`);
  await expect(history.getByText('Поступления: 3', { exact: true })).toBeVisible();
  await history.locator('summary').click();
  await expect(history.getByRole('listitem')).toHaveCount(3);
  await expect(history).toContainText('Этап не назначен');
  await expect(page.getByRole('link', { name: files[0].name, exact: true })).toHaveCount(1);
  const original = await request.get(
    `/api/tenders/${id}/offers/${(await (await request.get(`/api/tenders/${id}/offers`)).json()).find((d: { name: string }) => d.name === files[0].name).id}/original`,
  );
  expect(await original.body()).toEqual(files[0].buffer);
  await page.screenshot({ path: 'test-results/task005b-suppliers-history.png', fullPage: true });
});
