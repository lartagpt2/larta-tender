// Deliberate opt-in, generated synthetic documents only. No arbitrary file argument.
import { performance } from 'node:perf_hooks';
import { quotePdf, gold } from './task008-fixtures.mjs';
import pages from '../apps/api/dist/document-ai/pages.js';
import adapter from '../apps/api/dist/document-ai/ollama.js';
const allowedDigest = '0533d74300e4f9bc367d675d4e64ffd073d50ff16a2b4096cc2e8a1cf8c96319';
if (!process.argv.includes('--run-synthetic'))
  console.log(
    'Preview only. --run-synthetic sends only a generated two-page test PDF to the approved local model, after cloud-disabled preflight.',
  );
else {
  const started = performance.now(),
    scan = process.argv.includes('--scan');
  const prepared = await pages.documentPages(quotePdf(scan), 'application/pdf');
  const local = new adapter.OllamaDocumentAI({
    baseUrl: 'http://10.216.10.116:11434',
    model: 'qwen3-vl:8b-instruct',
    digest: allowedDigest,
    timeoutMs: 120000,
  });
  try {
    const result = await local.extract(prepared),
      d = result.draft;
    const matches = {
      supplier: d.supplierName.value === gold.supplierName,
      buyer: d.buyerName.value === gold.buyerName,
      taxId: d.taxId.value === gold.taxId,
      total: d.total.value === gold.total,
      currency: d.currency.value === gold.currency,
      email: d.email.value === gold.email,
      rows: d.items.length === 7,
    };
    const lineMatches = gold.items.map((expected, i) => {
      const row = d.items[i];
      return (
        !!row &&
        row.description.value === expected.name &&
        row.quantity.value === expected.quantity &&
        row.unit.value === expected.unit &&
        row.currency.value === gold.currency &&
        row.unitPrice.value === expected.unitPrice &&
        row.lineTotal.value === expected.lineTotal &&
        row.delivery.value === expected.delivery
      );
    });
    console.log(
      JSON.stringify(
        {
          test: 'TASK008 live adapter synthetic two-page ' + (scan ? 'scan' : 'native PDF'),
          pages: prepared.length,
          vision: prepared.some((p) => p.image),
          model: result.model,
          digest: result.digest,
          wallMs: Math.round(performance.now() - started),
          inferenceMs: result.durationMs,
          headerMatches: matches,
          headerCorrect: Object.values(matches).filter(Boolean).length,
          numericExamples: { total: d.total, firstItem: d.items[0] },
          headerTotal: 7,
          lineExactMatches: lineMatches,
          linesCorrect: lineMatches.filter(Boolean).length,
          lineTotal: 7,
          warnings: result.warnings,
          allResultsRemain: 'needs_review',
        },
        null,
        2,
      ),
    );
  } catch (error) {
    console.log(
      JSON.stringify({
        test: 'TASK008 live synthetic adapter',
        error: error.message,
        wallMs: Math.round(performance.now() - started),
      }),
    );
    process.exitCode = 1;
  }
}
