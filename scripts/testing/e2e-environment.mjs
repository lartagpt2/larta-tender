import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import vue from '@vitejs/plugin-vue';
import application from '../../apps/api/dist/application.js';
import ai from '../../apps/api/dist/document-ai/ai-repository.js';
import { isolatedRun, assertTestOrigin, verifyIdentity } from './isolated-run.mjs';
import { startMockAI } from './mock-ai.mjs';
import { quotePdf } from '../task008-fixtures.mjs';
import { repo, workspace, checked } from '../task008-gate-d/io.mjs';

export async function startEnvironment(withAI = false, runId) {
  const run = await isolatedRun(withAI ? 'playwright-ai' : 'playwright', runId);
  let app,
    web,
    mock,
    closed = false;
  const actor = randomUUID(),
    token = randomBytes(32).toString('hex');
  const apiOrigin = 'http://127.0.0.1:43101',
    webOrigin = 'http://127.0.0.1:43102';
  assertTestOrigin(apiOrigin);
  assertTestOrigin(webOrigin);
  async function close(status = 'RETAINED') {
    if (closed) return;
    closed = true;
    const errors = [];
    for (const stop of [
      () => web?.close(),
      () => app?.close(),
      () => mock?.close(),
      () => run.close(status),
    ]) {
      try {
        await stop();
      } catch (e) {
        errors.push(e);
      }
    }
    if (errors.length) throw new AggregateError(errors, 'Test environment shutdown failed');
  }
  try {
    await run.annotate({
      testCase: 'playwright',
      actorId: actor,
      ports: { api: 43101, frontend: 43102 },
      hostPid: process.pid,
    });
    let aiRepository;
    if (withAI) {
      mock = await startMockAI();
      await run.annotate({
        ports: { api: 43101, frontend: 43102, mockAI: Number(new URL(mock.baseUrl).port) },
      });
      aiRepository = new ai.PgAIRepository(run.pool, {
        enabled: true,
        storageRoot: run.storageRoot,
        jobRoot: resolve(run.storageRoot, 'ai-jobs'),
        workspace,
        provider: mock.provider,
        baseUrl: mock.baseUrl,
        model: 'qwen3-vl:8b-instruct',
        digest: mock.digest,
        syntheticHashes: [
          quotePdf(),
          quotePdf(true),
          quotePdf(false, 0.9),
          await readFile(resolve(repo, 'tests/fixtures/tz-seven-items.pdf')),
        ].map((b) => createHash('sha256').update(b).digest('hex')),
      });
    }
    process.env.DATA_ACCESS_ENABLED = 'true';
    process.env.UNIFIED_INTAKE_ENABLED = 'true';
    process.env.DEV_API_TOKEN = token;
    process.env.DEV_ACTOR_ID = actor;
    // DataContext builds its own pools from the pinned process environment.
    app = await application.createApplication({
      logger: false,
      environment: 'test',
      data: { aiRepository, lifecycleEnabled: true },
    });
    const fastify = app.getHttpAdapter().getInstance();
    fastify.addHook('onRequest', async () => {
      assert.equal(process.env.STORAGE_ROOT, run.storageRoot);
      await checked(run.storageRoot);
      await verifyIdentity(run.pool, run.identity);
    });
    fastify.get('/api/test-identity', async () => run.identity);
    await app.listen(43101, '127.0.0.1');
    await run.pool.query(
      "INSERT INTO tender_app.app_user(id,external_subject,display_name) VALUES($1,$2,'Synthetic Playwright user')",
      [actor, 'synthetic-' + run.runId],
    );
    const cacheDir = await checked(resolve(run.runRoot, 'vite-cache'));
    web = await createServer({
      configFile: false,
      envFile: false,
      root: resolve(repo, 'apps/web'),
      envDir: run.runRoot,
      cacheDir,
      plugins: [vue()],
      resolve: { alias: { '@tender/shared': resolve(repo, 'packages/shared/src/index.ts') } },
      server: {
        host: '127.0.0.1',
        port: 43102,
        strictPort: true,
        proxy: {
          '/api': {
            target: apiOrigin,
            configure(proxy) {
              proxy.on('proxyReq', (request) => request.setHeader('authorization', 'Bearer ' + token));
            },
          },
        },
      },
    });
    await web.listen();
    const response = await fetch(webOrigin + '/api/test-identity');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), run.identity);
    return { run, apiOrigin, webOrigin, close };
  } catch (error) {
    await close('STARTUP_FAILED_RETAINED');
    throw error;
  }
}
export default async function setup(config) {
  const { fork } = await import('node:child_process');
  const host = fork(
    resolve(repo, 'scripts/testing/e2e-host.mjs'),
    [config.metadata.documentAI ? 'ai' : 'main', config.metadata.runId],
    { cwd: repo, stdio: ['ignore', 'inherit', 'inherit', 'ipc'], windowsHide: true },
  );
  const ready = await new Promise((done, reject) => {
    const timer = setTimeout(() => {
      host.kill();
      reject(new Error('Isolated host startup timeout'));
    }, 90000);
    host.once('error', reject);
    host.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error('Isolated host exited: ' + code));
    });
    host.once('message', (value) => {
      clearTimeout(timer);
      done(value);
    });
  });
  process.env.ISOLATED_RUN_ID = ready.identity.runId;
  process.env.ISOLATED_DATABASE = ready.identity.database;
  process.env.ISOLATED_WEB_ORIGIN = ready.webOrigin;
  process.env.ISOLATED_RUN_ROOT = ready.runRoot;
  for (const project of config.projects) {
    project.use.baseURL = ready.webOrigin;
    project.outputDir = resolve(ready.runRoot, 'playwright-output');
  }
  return async () => {
    await new Promise((done, reject) => {
      const timer = setTimeout(() => {
        host.kill();
        reject(new Error('Isolated host shutdown timeout; SQL ledger retained'));
      }, 30000);
      host.once('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) done();
        else reject(new Error('Host shutdown failed'));
      });
      host.send({ action: 'close' });
    });
  };
}
