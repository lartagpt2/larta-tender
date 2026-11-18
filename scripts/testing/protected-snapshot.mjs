import assert from 'node:assert/strict';
import { readFile, readdir, lstat } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { parse } from 'dotenv';
import pg from 'pg';
import { repo, workspace, checked, json } from '../task008-gate-d/io.mjs';
const sha = (value) => createHash('sha256').update(value).digest('hex');
export async function protectedSnapshot() {
  const env = parse(await readFile(resolve(repo, '.env')));
  assert.equal(env.PGDATABASE, 'larta_test_task003');
  assert.ok(['localhost', '127.0.0.1'].includes(env.PGHOST));
  const client = new pg.Client({
    host: '127.0.0.1',
    port: 5432,
    database: env.PGDATABASE,
    user: env.PGUSER,
    password: env.PGPASSWORD,
    connectionTimeoutMillis: 5000,
    statement_timeout: 30000,
    options: '-c default_transaction_read_only=on',
    ssl: false,
  });
  const tables = {},
    files = [];
  try {
    await client.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    assert.equal((await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only, 'on');
    const names = (
      await client.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema='tender_app' AND table_type='BASE TABLE' ORDER BY table_name",
      )
    ).rows;
    assert.equal(names.length, 35);
    for (const { table_name } of names) {
      assert.match(table_name, /^[a-z_]+$/);
      const rows = (
        await client.query('SELECT to_jsonb(t)::text value FROM tender_app.' + table_name + ' t')
      ).rows
        .map((r) => r.value)
        .sort();
      tables[table_name] = { count: rows.length, sha256: sha(JSON.stringify(rows)) };
    }
    const lifecycle = (
      await client.query(
        "SELECT COALESCE(l.state,'active') state,count(*)::int count FROM tender_app.tender t LEFT JOIN tender_app.tender_lifecycle l ON l.tender_id=t.id GROUP BY COALESCE(l.state,'active') ORDER BY state",
      )
    ).rows;
    await client.query('ROLLBACK');
    async function walk(path) {
      await checked(path);
      let stat;
      try {
        stat = await lstat(path);
      } catch (e) {
        if (e.code === 'ENOENT') return;
        throw e;
      }
      if (stat.isDirectory()) for (const n of (await readdir(path)).sort()) await walk(resolve(path, n));
      else {
        assert.ok(stat.isFile());
        files.push({
          path: relative(workspace, path).replaceAll('\\', '/'),
          bytes: stat.size,
          sha256: sha(await readFile(path)),
        });
      }
    }
    assert.ok(env.STORAGE_ROOT);
    // Include the configured source storage plus historical persistent storage/AI roots.
    const roots = [
      ...new Set([
        resolve(env.STORAGE_ROOT),
        ...[
          'storage-task004',
          'task008',
          'task008-e2e',
          'task008-gate-d',
          'task008-integration',
          'task008-tests',
          'task008e',
          'task008f',
          'task008g',
          'storage',
        ].map((p) => resolve(workspace, 'temp', p)),
      ]),
    ].sort();
    for (const root of roots) await walk(root);
    const processes = JSON.parse(
      execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          "$ErrorActionPreference='Stop'; $items=@(Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -in 3000,5173 } | ForEach-Object { $connection=$_; $proc=Get-CimInstance Win32_Process -Filter ('ProcessId='+$connection.OwningProcess); [pscustomobject]@{port=$connection.LocalPort;pid=$proc.ProcessId;created=$proc.CreationDate.ToUniversalTime().ToString('o');executable=$proc.ExecutablePath} } | Sort-Object port,pid -Unique); ConvertTo-Json -InputObject $items -Compress",
        ],
        { encoding: 'utf8', windowsHide: true },
      ),
    );
    return { database: env.PGDATABASE, tables, lifecycle, roots, files, processes };
  } finally {
    await client.end();
  }
}
if (process.argv[1]?.endsWith('protected-snapshot.mjs')) {
  const target = resolve(workspace, 'temp/task014', process.argv[2] || 'before.json');
  await json(target, await protectedSnapshot());
  console.log('Protected read-only snapshot saved: ' + target);
}
