import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { checked, workspace } from '../task008-gate-d/io.mjs';
import { verifyIdentity } from '../testing/isolated-run.mjs';
import policies from '../../apps/api/dist/unified-intake/processing-policy.js';
const digest = (b) => createHash('sha256').update(b).digest('hex');
export async function acceptRegressionPolicy(pool, identity, next) {
  assert.equal(process.env.NODE_ENV, 'test');
  assert.equal(process.env.DOCUMENT_AI_ENABLED, 'false');
  assert.ok(identity?.runId, 'disposable_identity_required');
  await verifyIdentity(pool, identity);
  assert.equal(process.env.PGDATABASE, identity.database);
  assert.equal(next.runId, identity.runId);
  assert.equal(
    next.manifestPath,
    resolve(workspace, 'temp/integration-runs', identity.runId, 'regression-only-D-manifest.json'),
  );
  const bytes = await readFile(await checked(next.manifestPath));
  assert.equal(digest(bytes), next.manifestSha256);
  const m = JSON.parse(bytes);
  assert.equal(m.regressionOnly, true);
  assert.equal(m.activated, false);
  assert.equal(m.testSet, 'TASK-011D');
  assert.equal(m.runId, identity.runId);
  const original = await readFile(resolve('scripts/task011d/integration.mjs'));
  assert.equal(digest(original), '278adbe8354e7dc4e5cc4b4a5ffbf27c0352b33ef4cb2defb7f9e435e2525bd2');
  assert.ok(
    next.config.sha256.every((h) =>
      m.fixtures.some((f) => f.sha256 === h && f.policyGrant === true && f.category !== 'negative_policy'),
    ),
  );
  assert.ok(['synthetic', 'disabled'].includes(next.config.mode));
  assert.equal(next.config.enabled, true);
}
export async function regressionMemoryPolicy(pool, identity, state) {
  await acceptRegressionPolicy(pool, identity, state);
  return new policies.IntakePolicy(async () => {
    assert.equal(process.env.NODE_ENV, 'test');
    await verifyIdentity(pool, identity);
    return state.config;
  });
}
