import { lstat, readdir, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
export interface OCRSnapshot {
  jobs: { id: string; status: string; sha256: string; path: string }[];
  active: number;
}
export async function ocrInventory(
  workspace: string,
  roots: string[],
  tenderId: string,
): Promise<OCRSnapshot> {
  const jobs: OCRSnapshot['jobs'] = [],
    seen = new Set<string>();
  let visited = 0;
  async function safe(path: string) {
    const rel = relative(workspace, path);
    if (rel.startsWith('..') || isAbsolute(rel)) throw Error('ocr_inventory_outside_workspace');
    for (let p = path; ; p = dirname(p)) {
      try {
        if ((await lstat(p)).isSymbolicLink()) throw Error('ocr_inventory_link');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
      if (dirname(p) === p) break;
    }
  }
  async function walk(path: string): Promise<void> {
    path = resolve(path);
    if (seen.has(path)) return;
    seen.add(path);
    await safe(path);
    let stat;
    try {
      stat = await lstat(path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw e;
    }
    if (++visited > 30000) throw Error('ocr_inventory_limit');
    if (stat.isDirectory()) {
      for (const item of await readdir(path, { withFileTypes: true })) {
        if (['node_modules', 'frozen-production', 'frozen-code'].includes(item.name)) continue;
        if (item.isSymbolicLink()) throw Error('ocr_inventory_link');
        await walk(resolve(path, item.name));
      }
    } else if (/[\\/]document-ai[\\/][a-f0-9]{64}\.json$/.test(path)) {
      if (stat.size > 4 * 1024 * 1024) throw Error('ocr_inventory_limit');
      const data = await readFile(path, 'utf8'),
        job = JSON.parse(data);
      if (job.tenderId === tenderId) {
        if (!['pending', 'running', 'needs_review', 'failed', 'unsupported'].includes(job.status))
          throw Error('ocr_inventory_status');
        jobs.push({
          id: job.id,
          status: job.status,
          sha256: createHash('sha256').update(data).digest('hex'),
          path: relative(workspace, path).replaceAll('\\', '/'),
        });
      }
    }
  }
  for (const root of roots) await walk(root);
  jobs.sort((a, b) => a.path.localeCompare(b.path));
  return { jobs, active: jobs.filter((j) => ['pending', 'running'].includes(j.status)).length };
}
