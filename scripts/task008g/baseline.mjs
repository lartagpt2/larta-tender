import assert from 'node:assert/strict';
import { readFile, readdir, access, mkdir, writeFile } from 'node:fs/promises';
import { resolve, relative, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cases, generate } from './corpus.mjs';
import { repo, workspace, checked, json } from '../task008-gate-d/io.mjs';
export async function exclusiveJson(path, value) {
  const target = await checked(path);
  await mkdir(await checked(dirname(target)), { recursive: true });
  await checked(target);
  await writeFile(target, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
}
export { cases };
const manifest = resolve(repo, 'docs/evaluations/TASK-008G-preregistration.json');
const hash = async (p) =>
  createHash('sha256')
    .update(await readFile(await checked(p)))
    .digest('hex');
async function files(root) {
  const out = [];
  for (const e of await readdir(await checked(root), { withFileTypes: true })) {
    const p = await checked(resolve(root, e.name));
    if (e.isDirectory()) out.push(...(await files(p)));
    else if (e.isFile()) out.push(p);
  }
  return out;
}
export async function preserveF() {
  const f = JSON.parse(
    await readFile(resolve(repo, 'docs/evaluations/TASK-008G-F-preservation.json'), 'utf8'),
  );
  for (const e of f.files) assert.equal(await hash(resolve(workspace, e.path)), e.sha256, e.path);
  return f.files.length;
}
export async function integrity() {
  await preserveF();
  const m = JSON.parse(await readFile(manifest, 'utf8'));
  for (const f of [...m.files, ...m.documents])
    assert.equal(await hash(resolve(workspace, f.path)), f.sha256, f.path + ' changed after freeze');
  assert.deepEqual(
    JSON.parse(await readFile(resolve(repo, 'tests/fixtures/task008g-gold.json'), 'utf8')),
    cases,
  );
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
if (process.argv.includes('--freeze')) {
  await access(manifest).then(
    () => {
      throw new Error('Already frozen');
    },
    (e) => {
      if (e.code !== 'ENOENT') throw e;
    },
  );
  await preserveF();
  const documents = await generate(resolve(workspace, 'temp/task008g/new-corpus'));
  await json(resolve(repo, 'tests/fixtures/task008g-gold.json'), cases);
  const roots = [
    'apps/api/src',
    'apps/web/src',
    'packages/shared/src',
    'apps/api/dist/document-ai',
    'scripts/task008g',
  ];
  const source = [];
  for (const root of roots) source.push(...(await files(resolve(repo, root))));
  source.push(
    ...[
      'tasks/TASK-008G.md',
      'tests/fixtures/task008g-gold.json',
      'apps/web/vite.config.ts',
      'package.json',
      'package-lock.json',
      'docs/evaluations/TASK-008G-F-preservation.json',
      'docs/evaluations/TASK-008G-regression.json',
      'scripts/task008-gate-d/scoring.mjs',
      'scripts/task008f/metrics.mjs',
    ].map((p) => resolve(repo, p)),
  );
  const entries = [];
  for (const p of source.sort())
    entries.push({ path: relative(workspace, p).replaceAll('\\', '/'), sha256: await hash(p) });
  await exclusiveJson(manifest, {
    at: new Date().toISOString(),
    baseCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
    schemaVersion: 'document-draft-v4',
    promptVersion: 'untrusted-compact-evidence-v3',
    model: 'qwen3-vl:8b-instruct',
    digest: '0533d74300e4f9bc367d675d4e64ffd073d50ff16a2b4096cc2e8a1cf8c96319',
    primaryPasses: 1,
    realDocumentsAllowed: false,
    scoring:
      'unchanged Gate D exact row names; paired price+currency excludes expected missing currency and reports those separately',
    documents: documents.map(({ id, path, sha256 }) => ({
      id,
      path: relative(workspace, path).replaceAll('\\', '/'),
      sha256,
    })),
    files: entries,
  });
  await integrity();
  console.log(JSON.stringify({ frozen: true, documents: documents.length, sourceFiles: entries.length }));
}
