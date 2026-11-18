import { randomUUID } from 'node:crypto';
import { artifactPath } from './tests/artifact-path';
import { defineConfig } from '@playwright/test';
const runId = process.env.ISOLATED_RUN_ID || randomUUID();
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60000,
  globalSetup: './scripts/testing/e2e-environment.mjs',
  reporter: [['list'], ['./scripts/testing/e2e-reporter.mjs']],
  metadata: { runId, documentAI: false },
  outputDir: artifactPath(runId),
  use: { baseURL: 'http://127.0.0.1:43102', browserName: 'chromium', trace: 'retain-on-failure' },
});
