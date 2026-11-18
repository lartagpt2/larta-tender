import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { workspace } from '../task008-gate-d/io.mjs';
import { tenFiles, txt, asPdf, seller, alpha, beta, inn } from './fixtures.mjs';
export async function verifyFixtures() {
  const sha = (x) => createHash('sha256').update(x).digest('hex');
  const manifestBytes = await readFile(resolve(workspace, 'regression-only-C-manifest.json'));
  assert.equal(sha(manifestBytes), '6f690861d0f43974b978d67573e8d7ea2c4fc5e15799f01d916d1f6359ae99af');
  const manifest = JSON.parse(manifestBytes),
    generator = await readFile(resolve('scripts/task011c/integration.mjs'), 'utf8');
  assert.equal(sha(generator), '14b70c7724b8cd853693d8cf451624ed21ce6fcb0563ada9930864d31af52cb8');
  const tree = ts.createSourceFile(
      'integration.mjs',
      generator,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    ),
    generated = [];
  function visit(n) {
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      ['txt', 'asPdf'].includes(n.expression.text)
    ) {
      const file = vm.runInNewContext(
        n.getText(tree),
        { txt, asPdf, seller, alpha, beta, inn, leadingValue: inn('012345678'), Number },
        { timeout: 1000 },
      );
      generated.push({ file, line: tree.getLineAndCharacterOfPosition(n.getStart(tree)).line + 1 });
    }
    ts.forEachChild(n, visit);
  }
  visit(tree);
  const mainFiles = tenFiles();
  for (const f of manifest.fixtures) {
    const file = f.generator.endsWith('/fixtures.mjs')
      ? mainFiles.find((x) => x.name === f.name)
      : generated.find((x) => x.line === f.generatorLine && x.file.name === f.name)?.file;
    assert.ok(file);
    assert.equal(file.content.length, f.bytes);
    assert.equal(sha(file.content), f.sha256);
  }

  return {
    status: 'PASS',
    count: manifest.fixtures.length,
    manifestSha256: sha(manifestBytes),
    fixtures: manifest.fixtures.map((f) => ({
      name: f.name,
      bytes: f.bytes,
      sha256: f.sha256,
      generator: f.generator,
      generatorLine: f.generatorLine,
      status: 'PASS',
    })),
  };
}
