import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startEnvironment } from './e2e-environment.mjs';
const env = await startEnvironment(process.argv[2] === 'ai', process.argv[3]);
let closing = false;
async function close(aborted = false) {
  if (closing) return;
  closing = true;
  try {
    const tests = [];
    for (const file of await readdir(env.run.runRoot))
      if (file.startsWith('test-case-') && file.endsWith('.json'))
        tests.push(JSON.parse(await readFile(resolve(env.run.runRoot, file), 'utf8')));
    await env.run.annotate({ tests, hostPid: process.pid });
    await env.close(
      !aborted && tests.length && tests.every((t) => t.status === t.expectedStatus)
        ? 'PASSED_RETAINED'
        : 'FAILED_RETAINED',
    );
    process.exitCode = 0;
  } catch {
    process.exitCode = 1;
  }
  process.disconnect?.();
}
process.on('message', (msg) => {
  if (msg.action === 'close') void close();
});
process.once('disconnect', () => void close(true));
process.once('SIGINT', () => void close(true));
process.once('SIGTERM', () => void close(true));
process.send({ identity: env.run.identity, runRoot: env.run.runRoot, webOrigin: env.webOrigin });
