import { Worker } from 'node:worker_threads';
import { resolve } from 'node:path';
import { AIPage } from './contracts';
export async function documentPages(bytes: Buffer, mime: string): Promise<AIPage[]> {
  if (!bytes.length || bytes.length > 20 * 1024 * 1024) throw new Error('document_size_limit');
  return new Promise((done, reject) => {
    const worker = new Worker(resolve(__dirname, '../../../../scripts/document-ai-pages-worker.mjs'), {
      workerData: { bytes: new Uint8Array(bytes), mime },
      env: { SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP },
      resourceLimits: { maxOldGenerationSizeMb: 256 },
      stdout: true,
      stderr: true,
    });
    worker.stdout?.resume();
    worker.stderr?.resume();
    let settled = false;
    const finish = (pages?: AIPage[], error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      if (error) reject(new Error(error));
      else done(pages!);
    };
    const timer = setTimeout(() => finish(undefined, 'document_parse_timeout'), 20000);
    worker.on('message', (value: { pages?: AIPage[]; error?: string }) => finish(value.pages, value.error));
    worker.on('error', () => finish(undefined, 'document_parse_failed'));
    worker.on('exit', () => finish(undefined, 'document_parse_failed'));
  });
}
