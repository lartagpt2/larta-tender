import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
test('manual review, phone source, questions, supplier isolation, comparison and CSV', async ({
  page,
  request,
}) => {
  const created = await request.post('/api/tenders', {
    data: {
      title: `Synthetic TASK006 browser ${Date.now()}`,
      creationMode: 'manual',
      items: [{ name: 'Synthetic pump', quantity: '1', unit: 'шт' }],
    },
  });
  expect(created.status()).toBe(201);
  const id = (await created.json()).id;
  const { readFile } = await import('node:fs/promises'),
    bytes = await readFile(resolve('tests/fixtures/tz-seven-items.pdf'));
  for (let i = 0; i < 2; i++) {
    const upload = await request.post(`/api/tenders/${id}/offers/batches`, {
      headers: { 'Idempotency-Key': crypto.randomUUID() },
      multipart: { files: { name: 'same-original.pdf', mimeType: 'application/pdf', buffer: bytes } },
    });
    expect(upload.status()).toBe(201);
  }
  const supplierIds: string[] = [];
  for (const name of ['Browser supplier A', 'Browser supplier B']) {
    const docs = await (await request.get(`/api/tenders/${id}/offers`)).json();
    const r = await request.patch(`/api/tenders/${id}/offers/${docs[0].id}/association`, {
      data: { revision: docs[0].revision, newSupplier: { name }, note: 'Synthetic explicit supplier' },
    });
    expect(r.status()).toBe(200);
    supplierIds.push((await r.json()).supplierId);
  }
  const context = await (await request.get(`/api/tenders/${id}/verification`)).json(),
    document = context.documents[0];
  await page.goto(`/review?tenderId=${id}`);
  await page.getByLabel('Поставщик КП', { exact: true }).selectOption(supplierIds[0]);
  await page.getByLabel('Оригинал КП', { exact: true }).selectOption(document.id);
  await page.getByLabel('Поступление КП', { exact: true }).selectOption(document.receipts[0].id);
  await page.getByRole('button', { name: 'Показать оригинал PDF', exact: true }).click();
  await expect(page.getByTitle('Оригинал проверяемого КП')).toBeVisible();
  await page.getByLabel('Исходные значения: цена', { exact: true }).fill('100000');
  await page.getByLabel('Исходные значения: валюта', { exact: true }).selectOption('RUB');
  await page.getByLabel('Исходные значения: НДС', { exact: true }).selectOption('included');
  await page.getByLabel('Подтверждаемые значения: валюта', { exact: true }).selectOption('RUB');
  await page.getByLabel('Подтверждаемые значения: НДС', { exact: true }).selectOption('included');
  await page.getByLabel('Подтверждаемые значения: оплата', { exact: true }).fill('После поставки');
  await page.getByLabel('Подтверждаемые значения: соответствие ТЗ', { exact: true }).selectOption('matches');
  await page.getByLabel('Цена за единицу 1', { exact: true }).fill('100000');
  await page.getByLabel('Дополнительный вопрос', { exact: true }).fill('Проверить гарантию');
  await page.getByLabel('Комментарий к изменению', { exact: true }).fill('Synthetic manual transcription');
  await page
    .getByRole('checkbox', { name: 'Подтверждаю поставщика и поступление для этих значений', exact: true })
    .check();
  await page.getByRole('button', { name: 'Сохранить черновик', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Есть вопросы / Требует проверки' })).toBeVisible();
  await page.getByLabel('Подтверждаемые значения: срок поставки', { exact: true }).fill('7 дней');
  await page.getByLabel('Источник изменения', { exact: true }).selectOption('phone');
  await page.getByLabel('Комментарий к изменению', { exact: true }).fill('Synthetic phone call: 7 days');
  await page
    .getByRole('checkbox', { name: 'Подтверждаю поставщика и поступление для этих значений', exact: true })
    .check();
  await page.getByRole('button', { name: 'Сохранить и подтвердить', exact: true }).click();
  await expect(page.getByLabel('Открытые вопросы КП')).toContainText('Проверить гарантию');
  await expect(page.getByLabel('Открытые вопросы КП')).not.toContainText('Не указан срок поставки');
  await page.reload();
  await page.getByLabel('Поставщик КП', { exact: true }).selectOption(supplierIds[0]);
  await expect(page.getByLabel('Подтверждаемые значения: срок поставки', { exact: true })).toHaveValue(
    '7 дней',
  );
  await expect(page.getByLabel('Исходные значения: цена', { exact: true })).toBeDisabled();
  await page.getByRole('checkbox', { name: 'Разрешить замечание: Проверить гарантию', exact: true }).check();
  await page.getByRole('checkbox', { name: 'Учитывать дополнительные расходы', exact: true }).check();
  await page.getByRole('button', { name: 'Добавить расход', exact: true }).click();
  await page.getByLabel('Вид расхода 1', { exact: true }).fill('Доставка');
  await page.getByLabel('Сумма расхода 1', { exact: true }).fill('10000');
  await page.getByLabel('Учёт расхода 1', { exact: true }).selectOption('included');
  await page
    .getByLabel('Комментарий к изменению', { exact: true })
    .fill('Synthetic included delivery; warranty resolved');
  await page
    .getByRole('checkbox', { name: 'Подтверждаю поставщика и поступление для этих значений', exact: true })
    .check();
  await page.getByRole('button', { name: 'Сохранить и подтвердить', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Проверено' })).toBeVisible();
  await page.getByLabel('Поставщик КП', { exact: true }).selectOption(supplierIds[1]);
  await expect(page.getByLabel('Цена за единицу 1', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Подтверждаемые значения: срок поставки', { exact: true })).toHaveValue('');
  await expect(
    page.getByRole('checkbox', { name: 'Учитывать дополнительные расходы', exact: true }),
  ).not.toBeChecked();
  await page.getByLabel('Оригинал КП', { exact: true }).selectOption(document.id);
  await page.getByLabel('Поступление КП', { exact: true }).selectOption(document.receipts[1].id);
  await page.getByLabel('Исходные значения: цена', { exact: true }).fill('95000');
  await page.getByLabel('Исходные значения: валюта', { exact: true }).selectOption('RUB');
  await page.getByLabel('Исходные значения: НДС', { exact: true }).selectOption('included');
  await page.getByLabel('Подтверждаемые значения: валюта', { exact: true }).selectOption('RUB');
  await page.getByLabel('Подтверждаемые значения: НДС', { exact: true }).selectOption('included');
  await page.getByLabel('Подтверждаемые значения: оплата', { exact: true }).fill('Предоплата');
  await page.getByLabel('Подтверждаемые значения: срок поставки', { exact: true }).fill('10 дней');
  await page.getByLabel('Подтверждаемые значения: соответствие ТЗ', { exact: true }).selectOption('matches');
  await page.getByLabel('Цена за единицу 1', { exact: true }).fill('90000');
  await page
    .getByLabel('Комментарий к изменению', { exact: true })
    .fill('Synthetic separate supplier B evidence');
  await page
    .getByRole('checkbox', { name: 'Подтверждаю поставщика и поступление для этих значений', exact: true })
    .check();
  await page.getByRole('button', { name: 'Сохранить и подтвердить', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Проверено' })).toBeVisible();
  await page.screenshot({ path: 'test-results/task006-review.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/task006-review-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole('link', { name: 'К сравнению', exact: true }).click();
  await expect(page.getByRole('columnheader', { name: 'Browser supplier A', exact: true })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Browser supplier B', exact: true })).toBeVisible();
  const row = (name: string) =>
    page.getByRole('row').filter({ has: page.getByRole('rowheader', { name, exact: true }) });
  await expect(row('Цена исходная (документ)')).toContainText('100000.000000 RUB');
  await expect(row('Цена исходная (документ)')).toContainText('95000.000000 RUB');
  await expect(row('Сопоставимая стоимость')).toContainText('100000 RUB');
  await expect(row('Сопоставимая стоимость')).toContainText('90000 RUB');
  await expect(row('Срок поставки')).toContainText('7 дней');
  await expect(row('Аккредитация')).toContainText('Нет проверки');
  await page.getByLabel('Режим сравнения', { exact: true }).selectOption('items');
  await expect(page.getByLabel('Позиция сравнения', { exact: true })).toBeVisible();
  await expect(row('Цена исходная (документ)')).toContainText('100000.000000 RUB');
  const href = (await page.getByRole('link', { name: 'Скачать CSV', exact: true }).getAttribute('href'))!;
  const exported = await request.get(href);
  expect(exported.status()).toBe(200);
  expect(await exported.text()).toContain('Browser supplier B');
  expect(await exported.text()).toContain('Synthetic phone call: 7 days');
  await page.screenshot({ path: 'test-results/task006-comparison.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('heading', { name: 'Сравнение', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('title-only tender can explicitly create a lot without invented positions', async ({
  page,
  request,
}) => {
  const r = await request.post('/api/tenders', {
    data: { title: `Synthetic TASK006 title-only ${Date.now()}` },
  });
  expect(r.status()).toBe(201);
  const id = (await r.json()).id;
  await page.goto(`/review?tenderId=${id}`);
  await page.getByRole('button', { name: 'Создать лот без позиций', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Создать лот без позиций', exact: true })).toHaveCount(0);
  const context = await (await request.get(`/api/tenders/${id}/verification`)).json();
  expect(context.lots).toHaveLength(1);
  expect(context.lotItems[context.lots[0].id]).toHaveLength(0);
  await page.reload();
  await expect(page.getByLabel('Лот КП', { exact: true })).toHaveValue(context.lots[0].id);
});
