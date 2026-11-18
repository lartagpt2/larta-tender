import { emailTextPages } from './email-native';
import { Worker } from 'node:worker_threads';
import { resolve } from 'node:path';
import { IncomingOfferFile } from '../offer-files';
export const categories = ['specification', 'offer', 'quality_certificate', 'supporting', 'unknown'] as const;
export type Category = (typeof categories)[number];
export const rulesVersion = 'intake-native-rules-v1';
export const schemaVersion = 'intake-classification-v1';
export interface Classification {
  type: Category;
  reason: string;
  status: 'completed' | 'failed' | 'unsupported';
  coverage: {
    formatInspected: true;
    nativeTextAttempted: boolean;
    nativeTextAvailable: boolean;
    ocr: false;
    model: false;
  };
  evidence: { page: number; excerpt: string; sheet?: string; cellRange?: string }[];
}
export function nativePages(file: IncomingOfferFile): Promise<{ page: number; text: string }[]> {
  return new Promise((done, reject) => {
    const worker = new Worker(resolve(__dirname, '../../../../scripts/intake-native-worker.mjs'), {
      workerData: { bytes: new Uint8Array(file.content), mime: file.mime },
      env: { SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP },
      resourceLimits: { maxOldGenerationSizeMb: 256 },
      stdout: true,
      stderr: true,
    });
    worker.stdout?.resume();
    worker.stderr?.resume();
    let settled = false;
    const finish = (result?: { page: number; text: string }[], error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      if (error) reject(new Error(error));
      else done(result!);
    };
    const timer = setTimeout(() => finish(undefined, 'native_timeout'), 20000);
    worker.once('message', (r: { pages?: { page: number; text: string }[]; error?: string }) =>
      finish(r.pages, r.error),
    );
    worker.once('error', () => finish(undefined, 'native_parse_failed'));
    worker.once('exit', () => finish(undefined, 'native_parse_failed'));
  });
}
export async function classify(file: IncomingOfferFile): Promise<Classification> {
  const coverage: Classification['coverage'] = {
    formatInspected: true,
    nativeTextAttempted: true,
    nativeTextAvailable: false,
    ocr: false,
    model: false,
  };
  const unknown = (reason: string, status: Classification['status'] = 'completed'): Classification => ({
    type: 'unknown',
    reason,
    status,
    coverage,
    evidence: [],
  });
  let source: { page: number; text: string }[];
  try {
    source = file.mime === 'message/rfc822' ? emailTextPages(file) : await nativePages(file);
  } catch (error) {
    const code = (error as Error).message;
    const safe =
      /^(native_timeout|native_parse_failed|document_parse_failed|page_limit|text_limit|xlsx_limit|unsafe_xlsx|xlsx_sheet_limit|xlsx_cell_limit|xlsx_text_limit|xlsx_formula_or_external_unsupported|unsupported_format)$/;
    return unknown(
      safe.test(code) ? code : 'native_parse_failed',
      /unsupported/.test(code) ? 'unsupported' : 'failed',
    );
  }
  coverage.nativeTextAvailable = source.some((p) => p.text.trim().length > 0);
  if (!coverage.nativeTextAvailable)
    return unknown(file.mime === 'application/pdf' ? 'ocr_required_no_text_layer' : 'no_text', 'unsupported');
  const patterns: [Category, RegExp][] = [
    ['specification', /(?:техническ(?:ое|ого)\s+задани[ея]|technical\s+specification)/iu],
    ['offer', /(?:коммерческ(?:ое|ого)\s+предложени[ея]|commercial\s+(?:offer|proposal))/iu],
    [
      'quality_certificate',
      /(?:паспорт\s+качества|сертификат\s+(?:качества|соответствия)|quality\s+certificate)/iu,
    ],
    [
      'supporting',
      /(?:приложение\s+(?:к|№)|сопроводительн(?:ое|ого)\s+письм[оа]|supporting\s+(?:document|appendix))/iu,
    ],
  ];
  const found = patterns.flatMap(([type, pattern]) =>
    source.flatMap((p) => {
      const hit = pattern.exec(p.text);
      if (!hit) return [];
      const start = Math.max(0, hit.index - 40);
      return [
        {
          type,
          page: p.page,
          excerpt: p.text.slice(start, Math.min(p.text.length, hit.index + hit[0].length + 160)),
        },
      ];
    }),
  );
  const types = [...new Set(found.map((f) => f.type))];
  if (types.length !== 1) {
    const r = unknown(types.length ? 'ambiguous_content_markers' : 'insufficient_content_evidence');
    r.evidence = found.slice(0, 10).map((f) => ({ page: f.page, excerpt: f.excerpt }));
    return r;
  }
  return {
    type: types[0],
    reason: 'explicit_content_marker',
    status: 'completed',
    coverage,
    evidence: found
      .filter((f) => f.type === types[0])
      .slice(0, 10)
      .map((f) => ({
        page: f.page,
        excerpt: f.excerpt,
        ...(file.mime.includes('spreadsheet')
          ? { sheet: 'sheet' + f.page, cellRange: f.excerpt.match(/[A-Z]+\d+/)?.[0] }
          : {}),
      })),
  };
}
