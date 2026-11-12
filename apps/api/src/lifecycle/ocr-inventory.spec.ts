import { mkdir, mkdtemp, writeFile, symlink, lstat } from 'node:fs/promises';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { ocrInventory } from './ocr-inventory';
const workspace = resolve(__dirname, '../../../../..');
let root: string;
async function checked(path: string) {
  const rel = relative(workspace, path);
  if (rel.startsWith('..') || isAbsolute(rel)) throw Error('outside_workspace');
  for (let p = path; ; p = dirname(p)) {
    try {
      if ((await lstat(p)).isSymbolicLink()) throw Error('test_path_link');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    if (dirname(p) === p) break;
  }
  return path;
}
beforeAll(async () => {
  await mkdir(await checked(resolve(workspace, 'temp')), { recursive: true });
  root = await mkdtemp(await checked(resolve(workspace, 'temp/task009a-ocr-')));
});
it('includes completed OCR, hashes reviews and detects active jobs; never modifies source', async () => {
  const path = resolve(root, 'document-ai');
  await mkdir(await checked(path));
  const job = { id: 'a'.repeat(64), tenderId: 'synthetic-a', status: 'pending' };
  await writeFile(await checked(resolve(path, job.id + '.json')), JSON.stringify(job));
  const first = await ocrInventory(workspace, [root, root], 'synthetic-a');
  expect(first.jobs).toHaveLength(1);
  expect(first.active).toBe(1);
  await writeFile(
    await checked(resolve(path, job.id + '.json')),
    JSON.stringify({ ...job, status: 'needs_review', reviews: [{ synthetic: true }] }),
  );
  const last = await ocrInventory(workspace, [root], 'synthetic-a');
  expect(last.active).toBe(0);
  expect(last.jobs[0].sha256).not.toBe(first.jobs[0].sha256);
  expect((await ocrInventory(workspace, [root], 'other')).jobs).toHaveLength(0);
});
it('refuses a path outside workspace', async () => {
  await expect(ocrInventory(workspace, [resolve(workspace, '..')], 'synthetic-a')).rejects.toThrow(
    'outside_workspace',
  );
});
it('fails closed on junctions rather than following them', async () => {
  const path = resolve(root, 'junction');
  await symlink(await checked(resolve(workspace, 'temp')), await checked(path), 'junction');
  await expect(ocrInventory(workspace, [path], 'synthetic-a')).rejects.toThrow('ocr_inventory_link');
});
