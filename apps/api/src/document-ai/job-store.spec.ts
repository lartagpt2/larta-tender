import { mkdir, writeFile, symlink, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { JobStore } from './job-store';
const workspace = resolve(process.cwd(), '..');
describe('persistent scoped local job store', () => {
  it('recovers the lease of an exited worker, without stealing a live lease', async () => {
    const root = resolve(workspace, 'temp/task008-tests', randomUUID()),
      store = new JobStore<{ id: string; status: string }>(root, workspace),
      id = 'c'.repeat(64);
    await store.write({ id, status: 'running' });
    await writeFile(
      resolve(root, 'document-ai', id + '.json.lock'),
      JSON.stringify({ pid: 2147483647, at: 0 }),
      { flag: 'wx' },
    );
    const release = await store.claim(id);
    expect(release).not.toBeNull();
    await release!();
    expect((await store.read(id))?.status).toBe('running');
  });
  it('rejects a directory junction instead of writing through it', async () => {
    const root = resolve(workspace, 'temp/task008-tests', randomUUID()),
      target = resolve(workspace, 'temp/task008-tests', randomUUID()),
      link = resolve(root, 'document-ai');
    await mkdir(root, { recursive: true });
    await mkdir(target, { recursive: true });
    await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    try {
      const store = new JobStore<{ id: string }>(root, workspace);
      await expect(store.write({ id: 'd'.repeat(64) })).rejects.toThrow('ai_storage_link');
    } finally {
      await unlink(link);
    }
  });
  it('survives constructing a new worker and preserves lock exclusion', async () => {
    const root = resolve(workspace, 'temp/task008-tests', randomUUID()),
      store = new JobStore<{ id: string; status: string }>(root, workspace),
      id = 'a'.repeat(64);
    await store.write({ id, status: 'pending' });
    const release = await store.claim(id);
    expect(release).not.toBeNull();
    expect(await store.claim(id)).toBeNull();
    await release!();
    const restarted = new JobStore<{ id: string; status: string }>(root, workspace);
    expect(await restarted.read(id)).toEqual({ id, status: 'pending' });
    expect(await restarted.list()).toHaveLength(1);
  });
  it('rejects paths and oversized snapshots before write', async () => {
    const store = new JobStore<{ id: string; data: string }>(
      resolve(workspace, 'temp/task008-tests', randomUUID()),
      workspace,
    );
    await expect(store.read('../outside')).rejects.toThrow('invalid_ai_job_id');
    await expect(store.write({ id: 'b'.repeat(64), data: 'x'.repeat(4 * 1024 * 1024) })).rejects.toThrow(
      'ai_job_limit',
    );
    expect(() => new JobStore('C:/outside', 'C:/Users/oalimova/ai_project')).toThrow();
  });
});

it('orders pending work by immutable enqueue time rather than hash, preserving restart order', async () => {
  const root = resolve(workspace, 'temp/task008-tests', randomUUID()),
    store = new JobStore<{ id: string; status: string; createdAt: string; updatedAt?: string }>(
      root,
      workspace,
    );
  await store.write({
    id: 'f'.repeat(64),
    status: 'pending',
    createdAt: '2026-11-11T10:00:00.000Z',
    updatedAt: '2026-11-11T20:00:00.000Z',
  });
  await store.write({ id: 'a'.repeat(64), status: 'pending', createdAt: '2026-11-11T10:00:00.002Z' });
  await store.write({ id: 'b'.repeat(64), status: 'failed', createdAt: '2026-11-11T09:00:00.000Z' });
  await store.write({ id: 'c'.repeat(64), status: 'running', createdAt: '2026-11-11T10:00:00.001Z' });
  expect((await store.pending()).map((j) => j.id[0])).toEqual(['f', 'c', 'a']);
  const restarted = new JobStore<{ id: string }>(root, workspace);
  expect((await restarted.pending()).map((j) => j.id[0])).toEqual(['f', 'c', 'a']);
});
