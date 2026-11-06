import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:5173', browserName: 'chromium', trace: 'retain-on-failure' },
  webServer: [
    {
      command: 'npm run dev:api',
      url: 'http://127.0.0.1:3000/api/health',
      reuseExistingServer: process.env.PW_REUSE_SERVERS === 'true',
      timeout: 90000,
    },
    {
      command: 'npm run dev:web',
      url: 'http://127.0.0.1:5173',
      reuseExistingServer: process.env.PW_REUSE_SERVERS === 'true',
      timeout: 90000,
    },
  ],
});
