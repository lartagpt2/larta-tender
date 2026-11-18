// Artifact verification only: no DB connection, file mutation or cleanup operation.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { repo, checked } from '../task008-gate-d/io.mjs';
const root = resolve(repo, 'docs/inventory/TASK-009A');
const bytes = await readFile(await checked(resolve(root, 'inventory.json'))),
  csv = await readFile(await checked(resolve(root, 'candidates.csv'))),
  seal = JSON.parse(await readFile(resolve(root, 'integrity.json'), 'utf8'));
const sha = (b) => createHash('sha256').update(b).digest('hex'),
  d = JSON.parse(bytes);
assert.equal(sha(bytes), seal.inventorySha256);
assert.equal(sha(csv), seal.candidatesSha256);
assert.equal(seal.cleanupPerformed, false);
assert.equal(d.transactionReadOnly, 'on');
assert.equal(d.candidates.length + d.suspected.length + d.protected.length, d.totals.tenders);
assert.equal(d.candidates.length, d.totals.candidates);
assert.equal(new Set(d.candidates.map((c) => c.id)).size, d.candidates.length);
assert.ok(d.candidates.every((c) => c.cleanupAuthorized === false && c.requiresOwnerAttestation));
assert.ok(d.blobReferences.every((b) => b.physicalDeletionAllowed === false));
assert.equal(
  d.foreignKeys.reduce((n, f) => n + (f.orphans ?? 0), 0),
  d.totals.orphanForeignKeys,
);
assert.equal(d.foreignKeys.length, 81);
assert.equal(d.fileSystemScan.issues.length, 0);
assert.ok(
  d.candidates
    .find((c) => c.id === 'f768e259-c0fe-4819-a62b-28d5630025c6')
    .holds.includes('currently-shared-portal-tender'),
);
assert.ok(
  d.candidates
    .find((c) => c.id === 'e1f80509-6590-4b94-bc8b-4772aaaf54a5')
    .holds.includes('research-evidence-retention'),
);
assert.equal(csv.toString('utf8').trim().split(/\r?\n/).length, d.candidates.length + 1);
console.log(
  JSON.stringify({
    verified: true,
    candidates: d.candidates.length,
    foreignKeys: d.foreignKeys.length,
    readOnly: true,
    cleanupPerformed: false,
    blobRemovalAllowed: false,
    inventorySha256: seal.inventorySha256,
  }),
);
