import { lstatSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
export function artifactPath(runId: string): string {
  if (!/^[a-f0-9-]{36}$/.test(runId)) throw new Error('Invalid run ID');
  const target = resolve(__dirname, '../../temp/integration-runs', runId, 'playwright-output');
  for (let p = target; ; p = dirname(p)) {
    try {
      if (lstatSync(p).isSymbolicLink()) throw new Error('Workspace link');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    if (dirname(p) === p) break;
  }
  return target;
}
