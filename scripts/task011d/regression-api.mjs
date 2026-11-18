import scopeModule from '../../apps/api/dist/data/scope-repository.js';
import offerModule from '../../apps/api/dist/data/offer-repository.js';
import verificationModule from '../../apps/api/dist/comparison/verification-repository.js';
import stageModule from '../../apps/api/dist/stages/stage-repository.js';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { runtime } from './regression-runtime.mjs';
import appModule from '../../apps/api/dist/application.js';
import tenderModule from '../../apps/api/dist/data/repository.js';
import lifecycleModule from '../../apps/api/dist/lifecycle/lifecycle-repository.js';
const file = process.argv[2];
if (!file) throw Error('Explicit runtime config required');
const { config, pool, repo } = await runtime(file);
if (!process.env.DEV_API_TOKEN || !config.actorId) throw Error('Explicit actor and process token required');
if ((config.testPauseResponse || config.apiOnly) && process.env.NODE_ENV !== 'test')
  throw Error('test_configuration_forbidden');
if (config.testPauseResponse) {
  const original = repo.batch.bind(repo);
  repo.batch = async (...args) => {
    const result = await original(...args);
    process.send?.({ point: 'after_enqueue_commit', batchId: result.batchId });
    await new Promise(() => {});
  };
}
const app = await appModule.createApplication({
  logger: false,
  environment: 'test',
  enableOpenApi: true,
  data: {
    enabled: true,
    token: process.env.DEV_API_TOKEN,
    actorId: config.actorId,
    repository: new tenderModule.PgTenderRepository(pool),
    scopeRepository: new scopeModule.PgScopeRepository(pool),
    offerRepository: new offerModule.PgOfferRepository(pool),
    verificationRepository: new verificationModule.PgVerificationRepository(pool),
    stageRepository: new stageModule.PgStageRepository(pool),
    intakeRepository: repo,
    lifecycleEnabled: true,
    lifecycleRepository: new lifecycleModule.PgLifecycleRepository(pool, async () => ({
      jobs: [],
      active: 0,
    })),
  },
});
const port = config.port ?? 0;
if ([3000, 5173, 11434].includes(port) || (port !== 0 && (port < 1024 || port > 65535)))
  throw Error('protected_api_port');
await app.listen(port, '127.0.0.1');
let worker;
if (!config.apiOnly)
  worker = spawn(process.execPath, [resolve('scripts/task011d/regression-worker.mjs'), file], {
    cwd: process.cwd(),
    env: process.env,
    windowsHide: true,
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
process.send?.({ ready: true, origin: await app.getUrl(), workerPid: worker?.pid });
async function stop() {
  worker?.kill('SIGTERM');
  await app.close();
  await pool.end();
}
process.on('SIGTERM', () => {
  void stop().then(() => process.exit(0));
});
