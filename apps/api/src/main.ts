import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
async function bootstrap() {
  if (!process.env.INTAKE_RUNTIME_CONFIG)
    throw Error('Explicit isolated intake runtime config required; no .env fallback');
  const child = spawn(
    process.execPath,
    [resolve(__dirname, '../../../scripts/intake-api.mjs'), process.env.INTAKE_RUNTIME_CONFIG],
    { cwd: resolve(__dirname, '../../..'), env: process.env, stdio: 'inherit', windowsHide: true },
  );
  child.on('exit', (code) => {
    process.exitCode = code ?? 1;
  });
}
void bootstrap();
