import { randomUUID } from 'node:crypto';
import { runtime } from './task011d/runtime.mjs';
import workerModule from '../apps/api/dist/unified-intake/intake-worker.js';
const file = process.argv[2];
if (!file) throw Error('Explicit runtime config required; no env fallback');
const { config, pool, repo, store } = await runtime(file);
if (config.testPoint && process.env.NODE_ENV !== 'test') throw Error('Test hook forbidden');
let faultCount = 0;
const workerId = 'intake-worker-' + randomUUID();
const hook =
  config.testPoint || config.testFault || config.testDelayAfterRead
    ? async (point, job) => {
        if (config.testDelayAfterRead && point === 'after_read')
          await new Promise((done) => setTimeout(done, config.testDelayAfterRead));
        if (config.testPoint === point && (!config.testRun || job.id === config.testRun)) {
          process.send?.({ point, runId: job.id, revision: job.state_revision, workerId });
          await new Promise(() => {});
        }
        if (
          config.testFault &&
          point === 'after_read' &&
          faultCount++ < (config.testFault === 'once' ? 1 : 99)
        )
          throw new workerModule.ProcessingFailure(config.testFault !== 'permanent', 'synthetic_read_fault');
      }
    : undefined;
if (hook && process.env.NODE_ENV !== 'test') throw Error('Test-only fault configuration');
const worker = new workerModule.IntakeWorker(pool, repo, store, workerId, config.timing ?? {}, hook);
process.on('SIGTERM', () => worker.stop());
process.on('SIGINT', () => worker.stop());
process.send?.({ ready: true, workerId });
try {
  await worker.start();
} finally {
  await pool.end();
}
