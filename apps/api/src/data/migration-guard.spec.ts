import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
const root = resolve(__dirname, '../../../..');
const run = (...args: string[]) =>
  spawnSync(process.execPath, ['scripts/migrate-empty-test.mjs', ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 10000,
  });
it('previews a migration without connecting even with an unreachable database host', () => {
  const result = spawnSync(process.execPath, ['scripts/migrate-empty-test.mjs'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 10000,
    env: { ...process.env, PGHOST: 'unreachable.invalid' },
  });
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ mode: 'preview', connectsToDatabase: false });
});
it.each([
  ['--apply'],
  ['--apply', '--database', 'postgres', '--reviewed-sha', 'invalid'],
  ['--apply', '--database', 'larta_test_synthetic', '--reviewed-sha', 'invalid'],
])('refuses unreviewed or unsafe apply arguments: %j', (...args) => {
  const result = run(...args);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('Requires --database larta_test_');
});
