import { test, expect, type APIRequestContext } from '@playwright/test';
async function seed(request: APIRequestContext) {
  const created = await request.post('/api/tenders', {
    data: { title: `Synthetic TASK007 browser ${Date.now()}` },
  });
  expect(created.status()).toBe(201);
  const id = (await created.json()).id,
    base = `/api/tenders/${id}`;
  const lot = await request.post(base + '/verification/lot', { data: { expectedRevision: 1 } });
  expect(lot.status()).toBe(201);
  const lotId = (await lot.json()).id;
  const upload = async (stageId?: string) => {
    const r = await request.post(base + '/offers/batches', {
      headers: {
        'Idempotency-Key': crypto.randomUUID(),
        ...(stageId ? { 'X-Tender-Stage-Id': stageId } : {}),
      },
      multipart: {
        files: {
          name: 'synthetic-quote.txt',
          mimeType: 'text/plain',
          buffer: Buffer.from('Synthetic quote for TASK007 browser.'),
        },
      },
    });
    expect(r.status()).toBe(201);
  };
  await upload();
  const docs = await (await request.get(base + '/offers')).json(),
    doc = docs[0];
  const suppliers: string[] = [];
  for (const name of ['Browser stages A', 'Browser stages B']) {
    const current = await (await request.get(base + '/offers')).json();
    const r = await request.patch(base + `/offers/${doc.id}/association`, {
      data: { revision: current[0].revision, newSupplier: { name }, note: 'Synthetic explicit supplier' },
    });
    expect(r.status()).toBe(200);
    suppliers.push((await r.json()).supplierId);
  }
  const fields = {
    amount: '100000',
    currency: 'RUB',
    vatMode: 'included',
    paymentTerms: 'After delivery',
    deliveryTerms: '7 days',
    compliance: 'matches',
  };
  let version = 0,
    offerId = '';
  async function verify(amount: string, stageId?: string) {
    if (stageId) await upload(stageId);
    const context = await (await request.get(base + '/verification')).json();
    const input = {
      supplierId: suppliers[0],
      lotId,
      documentId: doc.id,
      receiptId: context.documents[0].receipts.at(-1).id,
      expectedVersion: version,
      contextConfirmed: true,
      intent: 'confirm',
      fields: { ...fields, amount },
      original: fields,
      sourceType: 'document',
      sourceNote: 'Synthetic own stage response',
      items: [],
      costs: [],
      costsEnabled: false,
      newQuestions: [],
      resolveQuestionIds: [],
    };
    const r = await request.post(base + '/verification', { data: input });
    expect(r.status()).toBe(201);
    const result = await r.json();
    version = result.version;
    offerId = result.offerId;
    return result;
  }
  await verify('100000');
  return { id, base, docId: doc.id, suppliers, verify, offer: () => offerId };
}
test('commercial stage rows, explicit no reply, sourced editable drafts and no fake address', async ({
  page,
  request,
}) => {
  const fixture = await seed(request),
    { id, base, suppliers } = fixture;
  await page.goto(`/stages?tenderId=${id}`);
  await page.getByLabel('Название этапа', { exact: true }).fill('Переторжка 1');
  await page.getByRole('button', { name: 'Создать этап', exact: true }).click();
  await expect(page.getByLabel('Выбранный этап')).toContainText('Переторжка 1');
  let context = await (await request.get(base + '/stages')).json();
  const first = context.stages[0].id;
  const firstVersion = await fixture.verify('95000', first);
  await page.reload();
  await page.getByLabel('Поставщик этапа').selectOption(suppliers[0]);
  await page.getByLabel('Выбранный этап').selectOption(first);
  await page.getByLabel('Предложение поставщика').selectOption(fixture.offer());
  await page.getByLabel('Подтверждённая версия этапа').selectOption(firstVersion.versionId);
  await page.getByLabel('Основание ответа').fill('Synthetic response registered by buyer');
  await page.getByRole('button', { name: 'Зафиксировать ответ', exact: true }).click();
  await expect(page.getByText('Ответ на этот этап уже зафиксирован.', { exact: true })).toBeVisible();
  for (const [name, amount] of [
    ['Переторжка 2', '90000'],
    ['Нет ответа', ''],
  ] as const) {
    await page.getByLabel('Название этапа', { exact: true }).fill(name);
    await page.getByRole('button', { name: 'Создать этап', exact: true }).click();
    await expect(page.getByLabel('Выбранный этап')).toContainText(name);
    context = await (await request.get(base + '/stages')).json();
    const stageId = context.stages.at(-1).id;
    const version = amount ? await fixture.verify(amount, stageId) : undefined;
    await page.reload();
    await page.getByLabel('Поставщик этапа').selectOption(suppliers[0]);
    await page.getByLabel('Выбранный этап').selectOption(stageId);
    await page.getByLabel('Предложение поставщика').selectOption(fixture.offer());
    if (version) await page.getByLabel('Подтверждённая версия этапа').selectOption(version.versionId);
    else await page.getByLabel('Результат этапа').selectOption('no_reply');
    await page.getByLabel('Основание ответа').fill('Synthetic final stage outcome');
    await page.getByRole('button', { name: 'Зафиксировать ответ', exact: true }).click();
    await expect(page.getByText('Ответ на этот этап уже зафиксирован.', { exact: true })).toBeVisible();
  }
  await page.getByLabel('Email контакта').fill('buyer-confirmed@example.invalid');
  await page.getByLabel('Документ контакта').selectOption(fixture.docId);
  await page.getByLabel('Основание подтверждения контакта').fill('Synthetic checked original contact');
  await page.getByRole('button', { name: 'Подтвердить контакт', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: /buyer-confirmed@example.invalid/ })).toBeVisible();
  await page.getByRole('button', { name: 'Заполнить шаблон', exact: true }).click();
  await expect(page.getByLabel('Тема письма')).not.toHaveValue('');
  await page.getByLabel('Текст письма').fill('Synthetic editable request text');
  await page.getByRole('button', { name: 'Сохранить черновик письма', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'История черновиков', exact: true }).locator('..'),
  ).toContainText('Synthetic editable request text');
  await page.getByRole('button', { name: 'Редактировать эту редакцию', exact: true }).first().click();
  await expect(page.getByLabel('Текст письма')).toHaveValue('Synthetic editable request text');
  await page.getByLabel('Текст письма').fill('Synthetic second revision');
  await page.getByRole('button', { name: 'Сохранить черновик письма', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'История черновиков', exact: true }).locator('..'),
  ).toContainText('Synthetic second revision');
  await page.getByLabel('Поставщик этапа').selectOption(suppliers[1]);
  await expect(
    page.getByText('Нет подтверждённого email. Черновик сохранится без адресата.', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Заполнить шаблон', exact: true }).click();
  await page.getByRole('button', { name: 'Сохранить черновик письма', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'История черновиков', exact: true }).locator('..'),
  ).toContainText('Нет адресата');
  expect(await page.getByRole('button', { name: 'Отправить', exact: true }).count()).toBe(0);
  await page.goto(`/comparison?tenderId=${id}`);
  const row = (label: string) =>
    page.getByRole('row').filter({ has: page.getByRole('rowheader', { name: label, exact: true }) });
  await expect(row('Цена актуальная')).toContainText('90000 RUB');
  await expect(row('Цена исходная (документ)')).toContainText('100000.000000 RUB');
  await expect(row('Этап 1: Переторжка 1 · скидка, %')).toContainText('5');
  await expect(row('Этап 2: Переторжка 2 · скидка, %')).toContainText('5.2632');
  await expect(row('Этап 3: Нет ответа · скидка, %')).toContainText('0');
  await expect(row('Этап 3: Нет ответа · общее снижение, %')).toContainText('10');
  await expect(row('Этап 3: Нет ответа · ответ')).toContainText('Нет ответа');
  await page.screenshot({ path: 'test-results/task007-comparison.png', fullPage: true });
});
test('accreditation upload and history remain supplier-specific', async ({ page, request }) => {
  const { id, suppliers } = await seed(request);
  await page.goto(`/accreditation?tenderId=${id}`);
  await page.getByLabel('Поставщик этапа').selectOption(suppliers[0]);
  for (const [date, status, source] of [
    ['2026-01-01', 'pending', 'Synthetic initial resource'],
    ['2026-02-01', 'passed', 'Synthetic updated resource'],
  ]) {
    await page
      .getByLabel('Файл отчёта', { exact: true })
      .setInputFiles({
        name: 'synthetic-accreditation.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('Synthetic accreditation evidence'),
      });
    await page.getByLabel('Дата отчёта', { exact: true }).fill(date);
    await page.getByLabel('Статус отчёта', { exact: true }).selectOption(status);
    await page.getByLabel('Источник отчёта', { exact: true }).fill(source);
    await page.getByRole('button', { name: 'Добавить отчёт в историю', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'История аккредитаций', exact: true }).locator('..'),
    ).toContainText(source);
  }
  const history = page.getByRole('heading', { name: 'История аккредитаций', exact: true }).locator('..');
  await expect(history).toContainText('Аккредитован');
  await expect(history).toContainText('Нет проверки');
  expect(await history.getByRole('link', { name: 'synthetic-accreditation.txt', exact: true }).count()).toBe(
    2,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/task007-accreditation-mobile.png', fullPage: true });
  await page.goto(`/comparison?tenderId=${id}`);
  const row = page
    .getByRole('row')
    .filter({ has: page.getByRole('rowheader', { name: 'Аккредитация', exact: true }) });
  await expect(row).toContainText('Аккредитован');
});
