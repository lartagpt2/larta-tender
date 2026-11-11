// Creates only new synthetic fixtures in the approved test DB; never confirms quote values.
import { config } from 'dotenv';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { quotePdf, gold } from './task008-fixtures.mjs';
config({ path: resolve('.env'), quiet: true });
if (process.env.PGDATABASE !== 'larta_test_task003') throw new Error('Approved synthetic test DB required');
if (!process.argv.includes('--run'))
  console.log(
    'Preview: --run creates a new synthetic tender with native/scanned PDFs; --extract explicitly runs the permitted synthetic native-PDF job.',
  );
else {
  const origin = 'http://127.0.0.1:5173/api';
  const json = async (path, body, method = 'POST') => {
    const r = await fetch(origin + path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) throw new Error('demo_http_' + r.status);
    return r.json();
  };
  const tender = await json('/tenders', {
      title: 'Демо TASK-008: синтетические ТЗ и КП ' + new Date().toISOString(),
    }),
    base = `/tenders/${tender.id}`,
    lot = await json(base + '/verification/lot', { expectedRevision: tender.revision });
  const form = new FormData();
  form.append('files', new Blob([quotePdf()], { type: 'application/pdf' }), 'synthetic-quote-native.pdf');
  form.append('files', new Blob([quotePdf(true)], { type: 'application/pdf' }), 'synthetic-quote-scan.pdf');
  const upload = await fetch(origin + base + '/offers/batches', {
    method: 'POST',
    headers: { 'Idempotency-Key': crypto.randomUUID() },
    body: form,
  });
  if (!upload.ok) throw new Error('demo_upload_' + upload.status);
  await upload.json();
  const docs = await json(base + '/offers', undefined, 'GET'),
    doc = docs.find((d) => d.name === 'synthetic-quote-native.pdf');
  const supplier = await json(
    base + `/offers/${doc.id}/association`,
    {
      revision: doc.revision,
      newSupplier: { name: gold.supplierName, registrationNumber: gold.taxId },
      note: 'Явное создание синтетического поставщика для демонстрации; цены не подтверждены.',
    },
    'PATCH',
  );
  const context = await json(base + '/verification', undefined, 'GET'),
    receipt = context.documents.find((d) => d.id === doc.id).receipts[0];
  let job;
  if (process.argv.includes('--extract')) {
    job = await json(base + '/document-ai', {
      kind: 'offer',
      documentId: doc.id,
      receiptId: receipt.id,
      supplierId: supplier.supplierId,
      lotId: lot.id,
    });
    for (let n = 0; n < 120 && ['pending', 'running'].includes(job.status); n++) {
      await delay(1000);
      job = await json(base + '/document-ai/' + job.id, undefined, 'GET');
    }
  }
  const final = await json(base + '/verification', undefined, 'GET');
  if (final.offers.length) throw new Error('Demo must not confirm business prices');
  console.log(
    JSON.stringify(
      {
        tenderId: tender.id,
        url: `http://127.0.0.1:5173/review?tenderId=${tender.id}&documentId=${doc.id}&receiptId=${receipt.id}&supplierId=${supplier.supplierId}&lotId=${lot.id}`,
        syntheticFiles: docs.map((d) => ({ name: d.name, id: d.id })),
        job: job
          ? {
              id: job.id,
              status: job.status,
              error: job.error,
              rows: job.result?.draft.items.length,
              model: job.result?.model,
              durationMs: job.result?.durationMs,
            }
          : null,
        confirmedOffers: final.offers.length,
      },
      null,
      2,
    ),
  );
  if (job && job.status !== 'needs_review') process.exitCode = 1;
}
