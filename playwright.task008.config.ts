import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/ai-e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60000,
  use: { baseURL: 'http://127.0.0.1:5173', browserName: 'chromium', trace: 'retain-on-failure' },
  webServer: [
    {
      command: 'node scripts/task008-e2e-server.mjs',
      url: 'http://127.0.0.1:3000/api/health',
      reuseExistingServer: false,
      timeout: 60000,
    },
    { command: 'npm run dev:web', url: 'http://127.0.0.1:5173', reuseExistingServer: false, timeout: 60000 },
  ],
});
