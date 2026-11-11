import { readFile, readdir } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { repo, workspace, checked } from '../task008-gate-d/io.mjs';
import { exclusiveJson } from '../task008f/freeze.mjs';
const manifest = resolve(repo, 'docs/evaluations/TASK-008G-F-preservation.json');
async function files(root) {
  const out = [];
  for (const e of await readdir(await checked(root), { withFileTypes: true })) {
    const p = await checked(resolve(root, e.name));
    if (e.isDirectory()) out.push(...(await files(p)));
    else if (e.isFile()) out.push(p);
  }
  return out;
}
const hash = async (p) =>
  createHash('sha256')
    .update(await readFile(await checked(p)))
    .digest('hex');
if (process.argv.includes('--capture')) {
  const selected = execFileSync('git', ['ls-files'], { cwd: repo, encoding: 'utf8' })
    .trim()
    .split(/\r?\n/)
    .filter((p) => /TASK-008F|scripts\/task008f\/|tests\/fixtures\/task008f-gold/.test(p))
    .map((p) => resolve(repo, p));
  const paths = [
    ...selected,
    ...(await files(resolve(workspace, 'temp/task008f/corpus'))),
    ...(await files(resolve(workspace, 'temp/task008f/2026-11-11T10-08-49.320Z-23d34993'))),
  ];
  const entries = [];
  for (const p of paths)
    entries.push({ path: relative(workspace, p).replaceAll('\\', '/'), sha256: await hash(p) });
  await exclusiveJson(manifest, {
    at: new Date().toISOString(),
    baseCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
    files: entries,
  });
}
const saved = JSON.parse(await readFile(await checked(manifest), 'utf8'));
for (const f of saved.files)
  assert.equal(await hash(resolve(workspace, f.path)), f.sha256, f.path + ' changed');
console.log(
  JSON.stringify({ task008FPreserved: true, files: saved.files.length, baseCommit: saved.baseCommit }),
);
