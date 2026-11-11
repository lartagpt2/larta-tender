import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'node:path';
export default defineConfig(({ mode }) => {
  // Server-side only. Never expose DEV_API_TOKEN through VITE_ variables or client defines.
  const local = loadEnv(mode, resolve(__dirname, '../..'), '');
  return {
    plugins: [vue()],
    resolve: { alias: { '@tender/shared': resolve(__dirname, '../../packages/shared/src/index.ts') } },
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
      proxy: {
        '/api': {
          target: 'http://127.0.0.1:3000',
          configure(proxy) {
            proxy.on('proxyReq', (request) => {
              if (local.DEV_API_TOKEN) request.setHeader('authorization', `Bearer ${local.DEV_API_TOKEN}`);
            });
          },
        },
      },
    },
    test: { include: ['apps/web/src/**/*.spec.ts'], environment: 'jsdom' },
  };
});
