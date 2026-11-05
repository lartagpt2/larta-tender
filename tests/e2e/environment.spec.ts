import { test, expect } from '@playwright/test';
test('web connects to the local API without a database', async ({ page, request }) => {
  const response = await request.get('http://127.0.0.1:3000/health');
  expect(response.ok()).toBeTruthy();
  expect(await response.json()).toEqual({ status: 'ok', persistence: 'not-configured' });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Тендерная платформа' })).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('API: ok');
  await page.getByRole('button', { name: 'Проверить соединение' }).click();
  await expect(page.getByRole('status')).toHaveText('API: ok');
});
