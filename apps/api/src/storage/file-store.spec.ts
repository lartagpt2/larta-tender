import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { FileStore } from './file-store';
const workspace = resolve(__dirname, '../../../../..');
let fixture: string;
beforeEach(() => {
  fixture = mkdtempSync(join(workspace, 'temp', 'storage-test-'));
});
afterEach(() => {
  if (!fixture.startsWith(join(workspace, 'temp') + sep)) throw new Error('Unsafe cleanup');
  rmSync(fixture, { recursive: true, force: true });
});
test('persists, reads and deduplicates identical bytes', async () => {
  const store = new FileStore(join(fixture, 'blobs'), workspace);
  const content = Buffer.from('Synthetic commercial offer');
  const first = await store.put(content);
  expect(await store.put(content)).toEqual(first);
  expect(await store.get(first.key)).toEqual(content);
});
test('rejects traversal and absolute client-controlled paths', async () => {
  const store = new FileStore(join(fixture, 'blobs'), workspace);
  for (const key of ['../secret', 'C:/Windows/win.ini', 'aa/../../secret', 'aa/' + 'b'.repeat(64)]) {
    await expect(store.get(key)).rejects.toThrow('Invalid storage key');
  }
  expect(() => new FileStore(resolve(workspace, '..', 'outside'), workspace)).toThrow('outside');
});
test('rejects junctions before writing', async () => {
  const target = join(fixture, 'real');
  mkdirSync(target);
  const link = join(fixture, 'link');
  symlinkSync(target, link, 'junction');
  await expect(new FileStore(link, workspace).put(Buffer.from('data'))).rejects.toThrow('junctions');
});
test('detects corruption instead of trusting an existing digest', async () => {
  const root = join(fixture, 'blobs');
  const store = new FileStore(root, workspace);
  const blob = await store.put(Buffer.from('original'));
  writeFileSync(join(root, ...blob.key.split('/')), 'corrupt');
  await expect(store.get(blob.key)).rejects.toThrow('integrity');
  await expect(store.put(Buffer.from('original'))).rejects.toThrow('integrity');
});
test('rejects empty and oversized inputs', async () => {
  const store = new FileStore(join(fixture, 'blobs'), workspace);
  await expect(store.put(Buffer.alloc(0))).rejects.toThrow('20 MiB');
  await expect(store.put(Buffer.alloc(20 * 1024 * 1024 + 1))).rejects.toThrow('20 MiB');
});
