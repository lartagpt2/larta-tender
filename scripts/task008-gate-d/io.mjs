import { lstat, mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const workspace = resolve(repo, '..');
export async function checked(path) {
  const target = resolve(path),
    rel = relative(workspace, target);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Outside workspace');
  for (let p = target; ; p = dirname(p)) {
    try {
      if ((await lstat(p)).isSymbolicLink()) throw new Error('Workspace link');
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    if (dirname(p) === p) break;
  }
  return target;
}
export async function save(path, content) {
  const target = await checked(path);
  await mkdir(dirname(target), { recursive: true });
  await checked(target);
  await writeFile(target, content);
}
export const json = (path, value) => save(path, JSON.stringify(value, null, 2) + '\n');
