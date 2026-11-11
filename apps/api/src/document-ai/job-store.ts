import { lstat, mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
export class JobStore<T extends { id: string }> {
  private readonly root: string;
  constructor(
    storageRoot: string,
    private readonly workspace: string,
  ) {
    if (!isAbsolute(storageRoot) || !isAbsolute(workspace)) throw new Error('absolute_ai_storage_required');
    this.root = resolve(storageRoot, 'document-ai');
    const rel = relative(workspace, this.root);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('ai_storage_outside_workspace');
  }
  private async check(path: string) {
    if (path !== this.root && !path.startsWith(this.root + sep)) throw new Error('ai_storage_path');
    for (let current = path; ; current = dirname(current)) {
      try {
        if ((await lstat(current)).isSymbolicLink()) throw new Error('ai_storage_link');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (dirname(current) === current) break;
    }
  }
  private path(id: string) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('invalid_ai_job_id');
    return resolve(this.root, id + '.json');
  }
  async read(id: string): Promise<T | null> {
    const path = this.path(id);
    await this.check(path);
    try {
      const file = await open(path, 'r');
      try {
        if ((await file.stat()).size > 4 * 1024 * 1024) throw new Error('ai_job_limit');
        const value = JSON.parse(await file.readFile('utf8')) as T;
        if (value.id !== id) throw new Error('ai_job_integrity');
        return value;
      } finally {
        await file.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  async write(value: T) {
    const encoded = JSON.stringify(value);
    if (Buffer.byteLength(encoded) > 4 * 1024 * 1024) throw new Error('ai_job_limit');
    const target = this.path(value.id);
    await this.check(target);
    await mkdir(this.root, { recursive: true });
    await this.check(target);
    const tmp = resolve(this.root, value.id + '.' + randomUUID() + '.tmp');
    await this.check(tmp);
    const file = await open(tmp, 'wx', 0o600);
    try {
      await file.writeFile(encoded);
      await file.sync();
    } finally {
      await file.close();
    }
    await this.check(target);
    await rename(tmp, target);
  }
  async *scan(): AsyncGenerator<T> {
    await this.check(this.root);
    let names: string[];
    try {
      names = (await readdir(this.root)).filter((n) => /^[a-f0-9]{64}\.json$/.test(n));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (names.length > 5000) throw new Error('ai_job_inventory_limit');
    for (const name of names) {
      const value = await this.read(name.slice(0, 64));
      if (value) yield value;
    }
  }
  async pending(): Promise<{ id: string; createdAt: string }[]> {
    const jobs: { id: string; createdAt: string }[] = [];
    for await (const value of this.scan()) {
      const job = value as T & { status?: string; createdAt?: string };
      if (!['pending', 'running'].includes(job.status ?? '')) continue;
      if (!job.createdAt || !Number.isFinite(Date.parse(job.createdAt)))
        throw new Error('ai_queue_timestamp_invalid');
      jobs.push({ id: job.id, createdAt: job.createdAt });
    }
    return jobs.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }
  async list(): Promise<T[]> {
    const values: T[] = [];
    for await (const value of this.scan()) values.push(value);
    return values;
  }
  async claim(id: string): Promise<(() => Promise<void>) | null> {
    const path = this.path(id) + '.lock';
    await this.check(path);
    await mkdir(this.root, { recursive: true });
    await this.check(path);
    try {
      const file = await open(path, 'wx', 0o600);
      await file.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }));
      await file.close();
      return async () => {
        await this.check(path);
        await unlink(path);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const prior = JSON.parse(await readFile(path, 'utf8')) as { pid: number; at: number };
      // Only reclaim a lock when its process has exited. Live workers never lose their lease.
      try {
        process.kill(prior.pid, 0);
        return null;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ESRCH') return null;
      }
      await this.check(path);
      await unlink(path);
      return this.claim(id);
    }
  }
}
