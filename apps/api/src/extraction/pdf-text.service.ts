import { Worker } from 'node:worker_threads';
import { resolve } from 'node:path';
import { ServiceUnavailableException } from '@nestjs/common';
export interface TextPage {
  page: number;
  text: string;
}
export interface PdfText {
  pages: TextPage[];
  hasText: boolean;
  diagnostics: string[];
}
export class PdfTextExtractionService {
  private static active = 0;
  constructor(private readonly timeoutMs = 15000) {}
  async extractText(content: Buffer): Promise<PdfText> {
    if (
      !content.length ||
      content.length > 20 * 1024 * 1024 ||
      content.subarray(0, 5).toString('ascii') !== '%PDF-'
    )
      return { pages: [], hasText: false, diagnostics: ['invalid_pdf'] };
    if (PdfTextExtractionService.active >= 2) throw new ServiceUnavailableException();
    PdfTextExtractionService.active++;
    return new Promise((resolveResult) => {
      let worker: Worker;
      try {
        worker = new Worker(resolve(__dirname, '../../../../scripts/pdf-text-worker.mjs'), {
          env: { SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP },
          workerData: { bytes: new Uint8Array(content) },
          resourceLimits: { maxOldGenerationSizeMb: 256 },
          stdout: true,
          stderr: true,
        });
      } catch {
        PdfTextExtractionService.active--;
        resolveResult({ pages: [], hasText: false, diagnostics: ['worker_failed'] });
        return;
      }
      worker.stdout?.resume();
      worker.stderr?.resume();
      let settled = false;
      const finish = async (result: PdfText) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        await worker.terminate();
        PdfTextExtractionService.active--;
        resolveResult(result);
      };
      const timer = setTimeout(
        () => void finish({ pages: [], hasText: false, diagnostics: ['timeout'] }),
        this.timeoutMs,
      );
      worker.once('message', (result: PdfText) => void finish(result));
      worker.once('error', () => void finish({ pages: [], hasText: false, diagnostics: ['worker_failed'] }));
      worker.once('exit', () => void finish({ pages: [], hasText: false, diagnostics: ['worker_failed'] }));
    });
  }
}
