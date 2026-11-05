import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
export interface StoredBlob {
  sha256: string;
  bytes: number;
  key: string;
}

/** Temporary local storage; no database connection and no automatic production root. */
export class FileStore {
  private readonly root: string;
  private readonly workspace: string;
  constructor(root: string, workspace: string) {
    if (!isAbsolute(root) || !isAbsolute(workspace))
      throw new Error('Absolute storage and workspace paths required');
    this.root = resolve(root);
    this.workspace = resolve(workspace);
    this.assertInside(this.root, this.workspace);
  }
  private assertInside(path: string, base: string) {
    const rel = relative(base, path);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
      throw new Error('Path outside permitted root');
  }
  private async checkComponents(target: string): Promise<void> {
    const paths: string[] = [];
    for (let cursor = target; ; cursor = dirname(cursor)) {
      paths.push(cursor);
      if (dirname(cursor) === cursor) break;
    }
    for (const path of paths.reverse()) {
      try {
        if ((await lstat(path)).isSymbolicLink()) throw new Error('Links and junctions are forbidden');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
  private target(key: string): string {
    if (!/^[a-f0-9]{2}\/[a-f0-9]{64}$/.test(key) || key.slice(0, 2) !== key.slice(3, 5))
      throw new Error('Invalid storage key');
    const target = resolve(this.root, ...key.split('/'));
    this.assertInside(target, this.root);
    return target;
  }
  async put(content: Uint8Array): Promise<StoredBlob> {
    if (!content.byteLength || content.byteLength > 20 * 1024 * 1024)
      throw new Error('File must be between 1 byte and 20 MiB');
    const buffer = Buffer.from(content);
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    const key = `${sha256.slice(0, 2)}/${sha256}`;
    const target = this.target(key);
    await this.checkComponents(target);
    await mkdir(dirname(target), { recursive: true });
    await this.checkComponents(target);
    let handle;
    try {
      handle = await open(target, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      await this.get(key); // Never overwrite an existing file; verify its integrity.
      return { sha256, bytes: buffer.byteLength, key };
    }
    try {
      await handle.writeFile(buffer);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return { sha256, bytes: buffer.byteLength, key };
  }
  async get(key: string): Promise<Buffer> {
    const target = this.target(key);
    await this.checkComponents(target);
    const content = await readFile(target);
    const digest = createHash('sha256').update(content).digest('hex');
    if (digest !== key.slice(3)) throw new Error('Storage integrity check failed');
    return content;
  }
}
