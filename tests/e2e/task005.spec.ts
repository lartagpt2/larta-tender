import { test, expect } from '@playwright/test';
test('batch offer registry retains seven files, rejects ZIP, clarifies and downloads', async ({
  page,
  request,
}) => {
  const r = await request.post('/api/tenders', {
    data: { title: `Synthetic TASK005 browser ${Date.now()}` },
  });
  expect(r.status()).toBe(201);
  const id = (await r.json()).id;
  await page.goto(`/tenders/${id}`);
  const files = Array.from({ length: 7 }, (_, i) => ({
    name: `browser-${i}.pdf`,
    mimeType: 'application/pdf',
    buffer: Buffer.from(`%PDF-1.7 synthetic browser ${i}`),
  }));
  const upload = async (input: typeof files) => {
    await page.getByLabel('Файлы КП', { exact: true }).setInputFiles(input);
    await page.getByRole('button', { name: 'Загрузить КП', exact: true }).click();
    await expect(page.getByLabel('Результаты загрузки').getByRole('listitem')).toHaveCount(input.length);
  };
  await upload(files.slice(0, 3));
  await expect(page.getByRole('link', { name: /browser-\d.pdf/ })).toHaveCount(3);
  await upload(files.slice(3));
  await page.reload();
  await expect(page.getByRole('link', { name: /browser-\d.pdf/ })).toHaveCount(7);
  await upload(files);
  await expect(page.getByRole('link', { name: /browser-\d.pdf/ })).toHaveCount(7);
  await upload([{ name: 'unsafe.zip', mimeType: 'application/zip', buffer: Buffer.from('PK synthetic') }]);
  await expect(page.getByLabel('Результаты загрузки')).toContainText('Отклонено');
  await page.getByRole('button', { name: 'Уточнить', exact: true }).first().click();
  await page.getByLabel('Основание', { exact: true }).fill('Synthetic no supplier evidence');
  await page.getByRole('button', { name: 'Подтвердить связь' }).click();
  await expect(page.getByRole('button', { name: 'Подтвердить связь' })).toHaveCount(0);
  const link = page.getByRole('link', { name: 'browser-0.pdf', exact: true });
  const original = await request.get((await link.getAttribute('href'))!);
  expect(await original.body()).toEqual(files[0].buffer);
  await page.screenshot({ path: 'test-results/task005-registry.png', fullPage: true });
});
