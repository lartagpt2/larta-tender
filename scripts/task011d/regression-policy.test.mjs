import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { regressionMemoryPolicy } from './regression-policy.mjs';
import { workspace } from '../task008-gate-d/io.mjs';
import policies from '../../apps/api/dist/unified-intake/processing-policy.js';
test('regression policy refuses absent UUID identity before SQL or fixture access', async () => {
  await assert.rejects(regressionMemoryPolicy(undefined, null, {}), /disposable_identity_required/);
});
test('standard runtime policy loader rejects inactive regression manifest format', async () => {
  const policy = policies.IntakePolicy.file(resolve(workspace, 'regression-only-C-manifest.json'), workspace);
  await assert.rejects(policy.current(), /invalid_or_unapproved_processing_policy/);
});
