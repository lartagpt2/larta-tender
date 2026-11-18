import main from './playwright.config';
import { defineConfig } from '@playwright/test';
export default defineConfig({ ...main, testDir: './tests/isolation-e2e' });
