import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test, expect } from '@playwright/test';
import { quotePdf, gold } from '../../scripts/task008-fixtures.mjs';
test('AI drafts persist separately; buyer explicitly confirms; stage prices and manual fields remain intact', async ({
  page,
  request,
}) => {
  const r = await request.post('/api/tenders', {
    data: { title: `Synthetic TASK008 browser ${Date.now()}` },
  });
  expect(r.status()).toBe(201);
  const id = (await r.json()).id,
    base = `/api/tenders/${id}`;
  const lot = await request.post(base + '/verification/lot', { data: { expectedRevision: 1 } });
  expect(lot.status()).toBe(201);
  const up = await request.post(base + '/offers/batches', {
    headers: { 'Idempotency-Key': crypto.randomUUID() },
    multipart: { files: { name: 'synthetic.pdf', mimeType: 'application/pdf', buffer: quotePdf() } },
  });
  expect(up.status()).toBe(201);
  let docs = await (await request.get(base + '/offers')).json();
  const doc = docs[0];
  const associate = await request.patch(base + `/offers/${doc.id}/association`, {
    data: {
      revision: doc.revision,
      newSupplier: { name: gold.supplierName, registrationNumber: gold.taxId },
      note: 'Synthetic explicit supplier',
    },
  });
  expect(associate.status()).toBe(200);
  const supplier = (await associate.json()).supplierId;
  const verification = await (await request.get(base + '/verification')).json(),
    receipt = verification.documents[0].receipts[0].id;
  await page.goto(`/review?tenderId=${id}`);
  await page.getByLabel('Документ для локального ИИ', { exact: true }).selectOption(doc.id);
  await page.getByLabel('Поступление для локального ИИ', { exact: true }).selectOption(receipt);
  await page.getByRole('button', { name: 'Распознать КП локально', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Черновик готов — не подтверждён' })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Кандидат поставщика', exact: true }).locator('..'),
  ).toContainText(gold.supplierName);
  await expect(
    page.getByRole('row').filter({ has: page.getByRole('rowheader', { name: 'Покупатель', exact: true }) }),
  ).toContainText(gold.buyerName);
  await page.getByRole('button', { name: 'Выбрать кандидата для проверки', exact: true }).click();
  await expect(page.getByLabel('Поставщик КП', { exact: true })).toHaveValue(supplier);
  await page.getByRole('button', { name: 'Распознать КП локально', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Черновик готов — не подтверждён' })).toBeVisible();
  const use = (label: string) =>
    page
      .getByRole('row')
      .filter({ has: page.getByRole('rowheader', { name: label, exact: true }) })
      .getByRole('button', { name: 'Ввести в пустое поле', exact: true });
  for (const label of ['Итог', 'Валюта', 'НДС', 'Оплата', 'Поставка']) await use(label).click();
  await expect(page.getByLabel('Подтверждаемые значения: цена', { exact: true })).toHaveValue('1400');
  await page.getByLabel('Подтверждаемые значения: соответствие ТЗ', { exact: true }).selectOption('matches');
  await page.getByLabel('Исходные значения: цена', { exact: true }).fill('1400');
  await page.getByLabel('Исходные значения: валюта', { exact: true }).selectOption('RUB');
  await page.getByLabel('Исходные значения: НДС', { exact: true }).selectOption('included');
  await page
    .getByRole('checkbox', { name: 'Подтверждаю поставщика и поступление для этих значений', exact: true })
    .check();
  await page.getByRole('button', { name: 'Сохранить черновик', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'ИИ-черновик сохранён. Сравнение не изменено.' }),
  ).toBeVisible();
  expect((await (await request.get(base + '/verification')).json()).offers).toHaveLength(0);
  await page.reload();
  await page.getByLabel('Поставщик КП', { exact: true }).selectOption(supplier);
  await page.getByLabel('Документ для локального ИИ', { exact: true }).selectOption(doc.id);
  await page.getByLabel('Поступление для локального ИИ', { exact: true }).selectOption(receipt);
  await expect(
    page.getByRole('button', { name: 'Восстановить сохранённый ИИ-черновик в форму', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Восстановить сохранённый ИИ-черновик в форму', exact: true })
    .click();
  await expect(page.getByLabel('Подтверждаемые значения: цена', { exact: true })).toHaveValue('1400');
  await page
    .getByRole('checkbox', { name: 'Подтверждаю поставщика и поступление для этих значений', exact: true })
    .check();
  await page.getByRole('button', { name: 'Сохранить и подтвердить', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Проверено' })).toBeVisible();
  const comparison = await (await request.get(base + '/comparison')).json();
  expect(comparison.rows.find((r: { key: string }) => r.key === 'current').values[0]).toBe('1400 RUB');
  await use('Итог').click();
  await expect(page.getByRole('status').filter({ hasText: 'Поле уже заполнено.' })).toBeVisible();
  await expect(page.getByLabel('Подтверждаемые значения: цена', { exact: true })).toHaveValue('1400');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/task008-review-mobile.png', fullPage: true });
  docs = await (await request.get(base + '/offers')).json();
  expect(docs[0].receipts).toHaveLength(1);
});

test('native TZ extraction adds only a draft and requires a separate manual composition save', async ({
  page,
  request,
}) => {
  const created = await request.post('/api/tenders', {
    data: { title: `Synthetic TASK008 TZ ${Date.now()}` },
  });
  expect(created.status()).toBe(201);
  const id = (await created.json()).id,
    base = `/api/tenders/${id}`;
  const upload = await request.post(base + '/tz', {
    headers: { 'Idempotency-Key': crypto.randomUUID() },
    multipart: {
      file: {
        name: 'synthetic-tz.pdf',
        mimeType: 'application/pdf',
        buffer: await readFile(resolve('tests/fixtures/tz-seven-items.pdf')),
      },
    },
  });
  expect(upload.status()).toBe(201);
  await page.goto(`/tenders/${id}`);
  const panel = page.getByRole('region', { name: 'Локальное распознавание документа', exact: true });
  await panel.getByRole('button', { name: 'Распознать ТЗ локально', exact: true }).click();
  await expect(
    panel.getByRole('status').filter({ hasText: 'Черновик готов — не подтверждён' }),
  ).toBeVisible();
  await expect(panel).toContainText('native-pdfjs-6.5.438');
  expect((await (await request.get(base + '/scope')).json()).items).toHaveLength(0);
  await panel.getByRole('button', { name: 'Добавить позиции в редактор для проверки', exact: true }).click();
  expect((await (await request.get(base + '/scope')).json()).items).toHaveLength(0);
  // Re-applying suggestions must keep unsaved buyer edits and avoid duplicate rows.
  await page.getByLabel('Количество 1', { exact: true }).fill('999');
  await panel.getByRole('button', { name: 'Добавить позиции в редактор для проверки', exact: true }).click();
  await expect(page.getByLabel('Количество 1', { exact: true })).toHaveValue('999');
  await expect(page.getByLabel('Позиция 8', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Сохранить состав', exact: true }).click();
  await expect.poll(async () => (await (await request.get(base + '/scope')).json()).items.length).toBe(7);
  await page.reload();
  expect((await (await request.get(base + '/scope')).json()).items).toHaveLength(7);
});
