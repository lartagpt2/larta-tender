import { test, expect, artifact } from '../isolated-fixture';
import { createHash } from 'node:crypto';
test('TASK011B: genuine mixed upload, classification correction/history and original download', async ({
  page,
  request,
}) => {
  const { mixedFiles } = await import('../../scripts/task011b/fixtures.mjs');
  const files = mixedFiles();
  const created = await request.post('/api/tenders', { data: { title: 'SYNTHETIC browser unified intake' } });
  expect(created.status()).toBe(201);
  const id = (await created.json()).id;
  await page.goto('/tenders/' + id);
  const panel = page.getByRole('region', { name: 'Единая загрузка документов' });
  await expect(panel.getByRole('heading', { name: 'Загрузить документы', exact: true })).toBeVisible();
  await panel
    .getByLabel('Смешанный комплект', { exact: true })
    .setInputFiles(files.map((f) => ({ name: f.name, mimeType: f.mime, buffer: f.content })));
  await panel.getByRole('button', { name: 'Загрузить пакет', exact: true }).click();
  await expect(panel.getByLabel('Результаты приёма').locator('li')).toHaveCount(10, { timeout: 60000 });
  const entries = panel.locator('article.intake-document');
  await expect(entries).toHaveCount(10);
  await expect(panel.getByRole('article', { name: 'Документ one.pdf', exact: true })).toContainText(
    /Категория:\s*ТЗ/,
  );
  await expect(panel.getByRole('article', { name: 'Документ six.pdf', exact: true })).toContainText(
    'OCR не запускался',
  );
  const unknown = panel.getByRole('article', { name: 'Документ five.txt', exact: true });
  await unknown.getByRole('button', { name: 'Изменить тип', exact: true }).click();
  await panel.getByLabel('Новая категория', { exact: true }).selectOption('supporting');
  await panel
    .getByLabel('Основание изменения типа', { exact: true })
    .fill('Synthetic browser human decision');
  await panel.getByRole('button', { name: 'Сохранить тип', exact: true }).click();
  await expect(unknown).toContainText(/Категория:\s*Приложение/);
  await expect(unknown).toContainText(/Первоначально:\s*Не определён/);
  await page.reload();
  const restored = page.getByRole('article', { name: 'Документ five.txt', exact: true });
  await expect(restored).toContainText(/Категория:\s*Приложение/);
  await restored.getByRole('button', { name: 'История и источники', exact: true }).click();
  await expect(restored).toContainText('Synthetic browser human decision');
  const actual = (await (await request.get('/api/tenders/' + id + '/intake/documents')).json()).find(
    (r) => r.name === 'five.txt',
  );
  const original = await request.get(
    '/api/tenders/' + id + '/intake/originals/' + actual.originalId + '/download',
  );
  expect(original.status()).toBe(200);
  expect(
    createHash('sha256')
      .update(await original.body())
      .digest('hex'),
  ).toBe(createHash('sha256').update(files[4].content).digest('hex'));
  const business = await request.get('/api/tenders/' + id + '/offers');
  expect(await business.json()).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('heading', { name: 'Загрузить документы', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  await page.screenshot({ path: await artifact('task011b-mobile.png'), fullPage: true });
  const preview = await (await request.get('/api/tenders/' + id + '/lifecycle')).json();
  const archived = await request.post('/api/tenders/' + id + '/lifecycle', {
    data: {
      action: 'archive',
      confirmationId: id,
      confirmationTitle: preview.title,
      previewHash: preview.previewHash,
      reason: 'Synthetic browser archive control',
    },
  });
  expect(archived.status()).toBe(201);
  await page.reload();
  const archivedPanel = page.getByRole('region', { name: 'Единая загрузка документов' });
  await expect(archivedPanel.getByLabel('Смешанный комплект', { exact: true })).toBeDisabled();
  const archivedDoc = archivedPanel.getByRole('article', { name: 'Документ five.txt', exact: true });
  await expect(archivedDoc.getByRole('button', { name: 'Изменить тип', exact: true })).toBeDisabled();
  await archivedDoc.getByRole('button', { name: 'История и источники', exact: true }).click();
  await expect(archivedDoc).toContainText('Synthetic browser human decision');
});
