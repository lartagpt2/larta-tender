import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { createHash } from 'node:crypto';
import workers from '../../apps/api/dist/unified-intake/intake-worker.js';
import classifier from '../../apps/api/dist/unified-intake/classification.js';
import { mixedFiles } from './fixtures.mjs';
const file = mixedFiles().find((f) => f.name === 'six.pdf');
async function execute({ readFailure = false, known = {} } = {}) {
  const updates = [],
    job = {
      id: 'synthetic-unit-run',
      original_id: 'synthetic-unit-original',
      tender_id: 'synthetic-unit-tender',
      source_sha: createHash('sha256').update(file.content).digest('hex'),
      policy_version: 'synthetic-unit-policy',
      coverage: known,
      attempt_count: 1,
    };
  const queue = {
    policy: { current: async () => ({ version: job.policy_version, reason: () => null }) },
    checkpoints: async () => [],
    rejected: async () => {},
    update: async (ticket, stage, _timing, coverage, status = 'running', code) => {
      const row = {
        ...ticket,
        stage,
        status,
        error_code: code,
        coverage: { ...ticket.coverage, ...coverage },
      };
      updates.push(structuredClone(row));
      return row;
    },
  };
  let extracted = 0;
  const repository = {
    queue,
    workerExtract: async () => {
      extracted++;
      throw Error('unsupported input must not reach extraction');
    },
  };
  const pool = {
    query: async () => ({
      rows: [{ mime_type: file.mime, original_name: file.name, storage_key: 'synthetic-unit-key' }],
    }),
  };
  const store = {
    get: async () => {
      if (readFailure) throw new workers.ProcessingFailure(false, 'synthetic_read_fault');
      return file.content;
    },
  };
  const spy = mock.method(classifier, 'classify', async () => ({
    type: 'unknown',
    reason: 'ocr_required_no_text_layer',
    status: 'unsupported',
    coverage: {
      formatInspected: true,
      nativeTextAttempted: true,
      nativeTextAvailable: false,
      model: false,
      ocr: false,
    },
    evidence: [],
  }));
  try {
    await new workers.IntakeWorker(pool, repository, store, 'coverage-unit').execute(job);
  } finally {
    spy.mock.restore();
  }
  return { updates, last: updates.at(-1), extracted };
}
test('unsupported classification persists false OCR/model and verified original, without retry/extraction', async () => {
  const r = await execute();
  assert.equal(r.last.status, 'failed');
  assert.equal(r.last.error_code, 'ocr_required_no_text_layer');
  assert.equal(r.last.coverage.model, false);
  assert.equal(r.last.coverage.ocr, false);
  assert.equal(r.last.coverage.originalVerified, true);
  assert.equal(r.last.coverage.nativeTextAttempted, true);
  assert.equal(r.last.coverage.nativeTextAvailable, false);
  assert.equal(r.extracted, 0);
  assert.ok(r.updates.every((row) => row.status !== 'retry_wait'));
  assert.equal(r.last.attempt_count, 1);
});
test('failure before reading original reports unused OCR/model without claiming verification', async () => {
  const r = await execute({ readFailure: true });
  assert.equal(r.last.status, 'failed');
  assert.equal(r.last.coverage.model, false);
  assert.equal(r.last.coverage.ocr, false);
  assert.equal(r.last.coverage.originalVerified, undefined);
  assert.equal(r.extracted, 0);
});
test('retry coverage preserves previously recorded executions rather than overwriting them with false', async () => {
  const r = await execute({ known: { model: true, ocr: true } });
  assert.equal(r.last.coverage.model, true);
  assert.equal(r.last.coverage.ocr, true);
  assert.equal(r.last.coverage.originalVerified, true);
});
