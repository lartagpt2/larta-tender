import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { checked, workspace } from '../task008-gate-d/io.mjs';
import { verifyIdentity } from '../testing/isolated-run.mjs';
import policies from '../../apps/api/dist/unified-intake/processing-policy.js';
export async function regressionPolicy(pool, identity, mock = false) {
  assert.equal(process.env.NODE_ENV, 'test');
  assert.ok(identity && pool, 'disposable_identity_required');
  await verifyIdentity(pool, identity);
  assert.equal(process.env.PGDATABASE, identity.database);
  assert.equal(process.env.DOCUMENT_AI_ENABLED, 'false');
  const path = await checked(resolve(workspace, 'regression-only-C-manifest.json')),
    bytes = await readFile(path);
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    '6f690861d0f43974b978d67573e8d7ea2c4fc5e15799f01d916d1f6359ae99af',
  );
  const m = JSON.parse(bytes);
  assert.equal(m.testSet, 'TASK-011C');
  assert.equal(m.regressionOnly, true);
  assert.equal(m.activated, false);
  assert.equal(m.fixtureCount, 36);
  const hashes = m.fixtures
    .filter((f) => f.processingAllowed && (f.category === 'test_mock') === mock)
    .map((f) => f.sha256);
  return new policies.IntakePolicy(async () => {
    await verifyIdentity(pool, identity);
    assert.equal(process.env.PGDATABASE, identity.database);
    return { mode: 'synthetic', enabled: true, sha256: hashes };
  });
}
