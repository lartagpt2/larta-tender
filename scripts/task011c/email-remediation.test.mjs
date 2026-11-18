import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { tenFiles } from './fixtures.mjs';
import classifier from '../../apps/api/dist/unified-intake/classification.js';
import emails from '../../apps/api/dist/unified-intake/email-native.js';
import orgs from '../../apps/api/dist/unified-intake/organizations.js';
const fixture = tenFiles()[5],
  before = Buffer.from(fixture.content),
  hash = createHash('sha256').update(before).digest('hex');
const manifest = JSON.parse(await readFile('../regression-only-C-manifest.json', 'utf8'));
const expected = manifest.fixtures.find((f) => f.name === fixture.name);
test('approved EML bytes, UTF-8 charset and 8bit body are decoded without changing original', () => {
  assert.equal(hash, expected.sha256);
  assert.equal(fixture.content.length, expected.bytes);
  assert.match(fixture.content.toString('utf8'), /charset=utf-8/);
  assert.match(fixture.content.toString('utf8'), /Content-Transfer-Encoding: 8bit/);
  const pages = emails.emailTextPages(fixture);
  assert.equal(pages.length, 1);
  assert.match(pages[0].text, /Seller: Synthetic Beta/);
  assert.doesNotMatch(pages[0].text, /From:/);
  assert.deepEqual(fixture.content, before);
});
test('EML classification and organization extraction share approved bounded body', async () => {
  const result = await classifier.classify(fixture);
  assert.equal(result.status, 'completed');
  assert.equal(result.type, 'unknown');
  assert.equal(result.coverage.nativeTextAvailable, true);
  assert.equal(result.coverage.model, false);
  assert.deepEqual(await orgs.organizationText(fixture), emails.emailTextPages(fixture));
  assert.equal(createHash('sha256').update(fixture.content).digest('hex'), hash);
});
