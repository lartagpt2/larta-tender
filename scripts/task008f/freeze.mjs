import assert from 'node:assert/strict';
import { readFile, readdir, access, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve, dirname, relative } from 'node:path';
import { cases, generate } from './corpus.mjs';
import { repo, workspace, checked, json } from '../task008-gate-d/io.mjs';
export { cases } from './corpus.mjs';
export const manifestPath = resolve(repo, 'docs/evaluations/TASK-008F-preregistration.json');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function hashFile(path) {
  return sha(await readFile(await checked(path)));
}
async function filesUnder(root) {
  const files = [];
  for (const item of await readdir(await checked(root), { withFileTypes: true })) {
    const path = await checked(resolve(root, item.name));
    if (item.isDirectory()) files.push(...(await filesUnder(path)));
    else if (item.isFile()) files.push(path);
  }
  return files;
}
export async function integrity() {
  const m = JSON.parse(await readFile(await checked(manifestPath), 'utf8'));
  for (const f of m.files)
    assert.equal(await hashFile(resolve(workspace, f.path)), f.sha256, f.path + ' changed after freeze');
  const gold = JSON.parse(await readFile(resolve(repo, 'tests/fixtures/task008f-gold.json'), 'utf8'));
  assert.deepEqual(gold, cases, 'Authored gold unchanged');
  for (const f of m.documents)
    assert.equal(await hashFile(resolve(workspace, f.path)), f.sha256, f.id + ' PDF changed');
  return m;
}
export async function frozenFixtures() {
  const m = await integrity();
  return cases.map((c) => ({
    ...c,
    ...m.documents.find((d) => d.id === c.id),
    path: resolve(workspace, m.documents.find((d) => d.id === c.id).path),
  }));
}
export async function exclusiveJson(path, value) {
  const target = await checked(path);
  await mkdir(await checked(dirname(target)), { recursive: true });
  await checked(target);
  await writeFile(target, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
}
if (process.argv.includes('--freeze')) {
  await access(await checked(manifestPath)).then(
    () => {
      throw new Error('Already frozen');
    },
    (e) => {
      if (e.code !== 'ENOENT') throw e;
    },
  );
  const documents = await generate(resolve(workspace, 'temp/task008f/corpus'));
  await json(resolve(repo, 'tests/fixtures/task008f-gold.json'), cases);
  const tracked = execFileSync(
    'git',
    [
      'ls-files',
      'apps',
      'packages',
      'infra',
      'package.json',
      'package-lock.json',
      'scripts/document-ai-pages-worker.mjs',
      'scripts/task008-gate-d/corpus.mjs',
      'scripts/task008-gate-d/scoring.mjs',
      'scripts/task008-gate-d/io.mjs',
      'tests/fixtures/task008-gate-d-gold.json',
      'docs/evaluations/TASK-008-GATE-D-summary.json',
    ],
    { cwd: repo, encoding: 'utf8' },
  )
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((f) => resolve(repo, f));
  const sources = [
    ...new Set([
      ...tracked,
      ...(await filesUnder(resolve(repo, 'scripts/task008f'))),
      ...(await filesUnder(resolve(repo, 'apps/api/dist/document-ai'))),
      resolve(repo, 'tests/fixtures/task008f-gold.json'),
      resolve(repo, 'tasks/TASK-008F.md'),
    ]),
  ].sort();
  const files = [];
  for (const path of sources)
    files.push({ path: relative(workspace, path).replaceAll('\\', '/'), sha256: await hashFile(path) });
  const manifest = {
    version: 'task008f-preregistered-v1',
    frozenAt: new Date().toISOString(),
    baselineCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
    model: 'qwen3-vl:8b-instruct',
    digest: '0533d74300e4f9bc367d675d4e64ffd073d50ff16a2b4096cc2e8a1cf8c96319',
    promptVersion: 'untrusted-compact-evidence-v3',
    schemaVersion: 'document-draft-v3',
    runsPerDocument: 1,
    realDocumentsAllowed: false,
    productionChangesAllowed: false,
    documents: documents.map(({ id, path, sha256 }) => ({
      id,
      path: relative(workspace, path).replaceAll('\\', '/'),
      sha256,
    })),
    files,
  };
  await exclusiveJson(manifestPath, manifest);
  await integrity();
  console.log(
    JSON.stringify({
      frozen: true,
      documents: documents.length,
      files: files.length,
      manifest: manifestPath,
    }),
  );
}
