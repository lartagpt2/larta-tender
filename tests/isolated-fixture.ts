import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { test as base, expect } from '@playwright/test';
export { expect };
export type { APIRequestContext } from '@playwright/test';
export const test = base.extend<{ isolation: void }>({
  isolation: [
    async ({ request, baseURL }, use, testInfo) => {
      const { json } = await import('../scripts/task008-gate-d/io.mjs');
      const startedAt = new Date().toISOString();
      expect(baseURL).toBe(process.env.ISOLATED_WEB_ORIGIN);
      expect(process.env.ISOLATED_RUN_ID).toBeTruthy();
      const response = await request.get('/api/test-identity');
      expect(response.status()).toBe(200);
      const identity = await response.json();
      expect(identity.runId).toBe(process.env.ISOLATED_RUN_ID);
      expect(identity.database).toBe(process.env.ISOLATED_DATABASE);
      try {
        await use();
      } finally {
        await json(resolve(process.env.ISOLATED_RUN_ROOT!, 'test-case-' + randomUUID() + '.json'), {
          testCase: testInfo.titlePath.join(' > '),
          startedAt,
          endedAt: new Date().toISOString(),
          status: testInfo.status,
          expectedStatus: testInfo.expectedStatus,
        });
      }
    },
    { auto: true },
  ],
});

export async function artifact(name: string): Promise<string> {
  const { checked } = await import('../scripts/task008-gate-d/io.mjs');
  if (!/^[a-z0-9-]+\.png$/.test(name)) throw new Error('Invalid artifact name');
  expect(process.env.ISOLATED_RUN_ROOT).toBeTruthy();
  return checked(resolve(process.env.ISOLATED_RUN_ROOT!, 'screenshots', name));
}
