import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
const root = resolve(__dirname, '../../../..');
it('previews 003 without connecting and rejects unsafe/unapproved application', () => {
  const run = (args: string[]) =>
    spawnSync(process.execPath, ['scripts/migrate-lifecycle.mjs', ...args], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, PGHOST: 'unreachable.invalid' },
    });
  const result = run([]);
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ mode: 'preview', connectsToDatabase: false });
  for (const args of [
    ['--apply'],
    ['--apply', '--database', 'postgres'],
    [
      '--apply',
      '--database',
      'larta_test_task003',
      '--reviewed-sha',
      'bad',
      '--approved-existing-database-upgrade',
    ],
  ])
    expect(run(args).status).not.toBe(0);
});
