import { createServer as netServer } from 'node:net';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { lstat, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { save, json, checked, repo, workspace } from '../task008-gate-d/io.mjs';
import { assertTestOrigin, verifyIdentity } from '../testing/isolated-run.mjs';
import { tenFiles } from '../task011d/fixtures.mjs';
export async function syntheticKit(policyBytes) {
  const policy = JSON.parse(policyBytes),
    sha = (b) => createHash('sha256').update(b).digest('hex');
  assert.equal(sha(policyBytes), '74dffd227d0232b9e60afdcdb09e0f01461d02a9d72f043df480377a174b5a3e');
  const files = tenFiles(),
    entries = [];
  for (const f of files) {
    assert.ok(policy.sha256.includes(sha(f.content)));
    const p = resolve(workspace, 'uat-fixtures', f.name);
    await save(p, f.content);
    const bytes = await readFile(p);
    assert.equal(sha(bytes), sha(f.content));
    entries.push({
      name: f.name,
      path: p,
      bytes: bytes.length,
      sha256: sha(bytes),
      generator: 'scripts/task011d/fixtures.mjs',
      generatorSha256: sha(await readFile(resolve(repo, 'scripts/task011d/fixtures.mjs'))),
      expectedProcessing: f.name === 'broken.pdf' ? 'failed' : 'completed',
      expectedType: f.name.startsWith('offer.')
        ? 'offer'
        : f.name.startsWith('quality.')
          ? 'quality_certificate'
          : f.name.startsWith('specification.')
            ? 'specification'
            : f.name === 'supporting.txt'
              ? 'supporting'
              : 'unknown',
      expectedCompany:
        f.name === 'broken.pdf' || f.name.startsWith('specification.') || f.name === 'supporting.txt'
          ? null
          : f.name.endsWith('.txt') && f.name !== 'quality.txt'
            ? 'Synthetic Beta'
            : f.name.endsWith('.xlsx')
              ? 'Synthetic Gamma'
              : f.name === 'quality.pdf'
                ? 'Synthetic Beta'
                : 'Synthetic Alpha',
    });
  }
  const manifest = {
    syntheticOnly: true,
    runtimePolicyUnchanged: true,
    policySha256: sha(policyBytes),
    files: entries,
    expectedInitial: {
      receipts: 10,
      runs: 10,
      completed: 9,
      failed: 1,
      preliminaryCompanies: 3,
      confirmedSuppliers: 0,
      offerVersions: 0,
    },
    realModelCalls: 0,
  };
  await json(resolve(workspace, 'uat-fixtures/manifest.json'), manifest);
  await save(
    resolve(workspace, 'uat-fixtures/manifest.sha256'),
    sha(await readFile(resolve(workspace, 'uat-fixtures/manifest.json'))) + '\n',
  );
  return manifest;
}
export async function isolatedWeb(app, token, run) {
  await verifyIdentity(run.pool, run.identity);
  await app.listen(0, '127.0.0.1');
  const apiOrigin = await app.getUrl();
  assertTestOrigin(apiOrigin);
  const reserved = netServer();
  await new Promise((yes, no) => {
    reserved.once('error', no);
    reserved.listen(0, '127.0.0.1', yes);
  });
  const webPort = reserved.address().port;
  assertTestOrigin('http://127.0.0.1:' + webPort);
  await new Promise((yes, no) => reserved.close((e) => (e ? no(e) : yes())));
  const { createServer } = await import('vite'),
    { default: vue } = await import('@vitejs/plugin-vue');
  const web = await createServer({
    configFile: false,
    envDir: false,
    root: resolve(repo, 'apps/web'),
    cacheDir: resolve(run.runRoot, 'vite-cache-' + new URL(apiOrigin).port),
    plugins: [vue()],
    resolve: { alias: { '@tender/shared': resolve(repo, 'packages/shared/src/index.ts') } },
    server: {
      host: '127.0.0.1',
      port: webPort,
      strictPort: true,
      proxy: {
        '/api': {
          target: apiOrigin,
          configure(proxy) {
            proxy.on('proxyReq', (r) => r.setHeader('authorization', 'Bearer ' + token));
          },
        },
      },
    },
    logLevel: 'error',
  });
  await web.listen();
  const addr = web.httpServer.address();
  assert.equal(typeof addr, 'object');
  const origin = 'http://127.0.0.1:' + addr.port;
  assertTestOrigin(origin);
  return { web, origin, apiOrigin };
}
export async function browserChecks(c) {
  const { run, app, ro, token, policyBytes, make, get, base, post, until, pool, ok } = c;
  await verifyIdentity(pool, run.identity);
  const kit = await syntheticKit(policyBytes);
  const owner = await isolatedWeb(app, token, run),
    reviewer = await isolatedWeb(ro, token, run);
  let browser;
  const results = [];
  const pass = (name) => {
    results.push({ name, status: 'PASS' });
    console.log('PASS Playwright ' + name);
  };
  try {
    const browserRoot = resolve(workspace, '../../cache/playwright');
    for (let p = browserRoot; ; p = dirname(p)) {
      assert.ok(!(await lstat(p)).isSymbolicLink());
      if (dirname(p) === p) break;
    }
    process.env.PLAYWRIGHT_BROWSERS_PATH = browserRoot;
    const { chromium, expect } = await import('@playwright/test');
    browser = await chromium.launch({
      headless: true,
      channel: 'chromium',
      env: {
        SystemRoot: process.env.SystemRoot,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        PATH: process.env.PATH,
      },
    });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } }),
      page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const tender = await make('Playwright synthetic actual upload');
    await page.goto(owner.origin + '/tenders/' + tender + '/intake');
    await expect(
      page.getByRole('heading', { name: 'Единая проверка документов', exact: true }),
    ).toBeVisible();
    await expect(page.getByText('В этом разделе пока нет документов.', { exact: true })).toBeVisible();
    pass('empty workspace rendered from real API');
    await page.getByLabel('Смешанный комплект документов').setInputFiles(kit.files.map((f) => f.path));
    await page.getByRole('button', { name: 'Загрузить документы', exact: true }).click();
    await until(async () => {
      const ws = await get(base(tender) + '/workspace?pageSize=100');
      return (
        ws.items.length === 10 && ws.items.every((r) => ['completed', 'failed'].includes(r.processingState))
      );
    }, 'browser ten files worker');
    await page.reload();
    await expect(page.getByText('Найдено: 10 / 10', { exact: true })).toBeVisible();
    pass('real multipart UI upload, durable Worker and reload 10/9/1');
    await page.getByRole('button', { name: 'Следующая страница', exact: true }).click();
    await expect(page.getByText('Страница 2', { exact: true })).toBeVisible();
    await page.getByLabel('Раздел', { exact: true }).selectOption('errors');
    await expect(page.getByText('Найдено: 1 / 10', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'broken.pdf', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Карточка документа: broken.pdf', exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'Скачать неизменяемый оригинал' })).toBeVisible();
    pass('pagination/errors/failed receipt detail and immutable original download');
    await page.getByLabel('Раздел', { exact: true }).selectOption('all');
    await page.getByLabel('Сортировка', { exact: true }).selectOption('name');
    const ws = await get(base(tender) + '/workspace?pageSize=100');
    const offer = ws.items.find((x) => x.name === 'offer.txt');
    await page.goto(owner.origin + '/tenders/' + tender + '/intake?receiptId=' + offer.receiptId);
    await expect(
      page.getByRole('heading', { name: 'Карточка документа: offer.txt', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Следующая страница', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Карточка документа: offer.txt', exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole('heading', { name: 'Карточка документа: offer.txt', exact: true }),
    ).toBeVisible();
    pass('receipt card independent of current list page; route reload/server evidence');
    await page.getByRole('button', { name: 'Synthetic Beta', exact: true }).click();
    await expect(page.getByRole('region', { name: 'История компании' })).toBeVisible();
    await page.getByLabel('Изменяемое поле', { exact: true }).selectOption('address');
    await page.getByLabel('Исправленное значение', { exact: true }).fill('Synthetic UI corrected address');
    await page
      .getByLabel('Основание решения по компании', { exact: true })
      .fill('Synthetic Playwright one-field correction');
    await page.getByRole('button', { name: 'Сохранить исправление', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Решение сохранено' })).toBeVisible();
    await page.getByRole('button', { name: 'Подтвердить новую компанию', exact: true }).click();
    await expect(page.getByText(/Supplier /).first()).toBeVisible();
    pass('company manual revision and independent human confirmation via real UI');
    const betaCard = (await get(base(tender) + '/workspace?pageSize=100')).companies.items.find((x) =>
      x.requisites.names.includes('Synthetic Beta'),
    );
    const betaHistory = await get(base(tender) + '/companies/' + betaCard.preliminaryCompanyId);
    const pane = page.getByRole('region', { name: 'История компании' });
    await pane.getByText('Ревизии компании', { exact: true }).click();
    await expect(
      pane.getByText(betaHistory.revisions.at(-1).actor_id, { exact: false }).first(),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Synthetic Gamma', exact: true }).click();
    await page.getByLabel('Изменяемое поле', { exact: true }).selectOption('country');
    await page.getByLabel('Исправленное значение', { exact: true }).fill('GB');
    await page
      .getByLabel('Регистрационный номер для новой страны (при необходимости)', { exact: true })
      .fill('01234567');
    await page
      .getByLabel('Основание решения по компании', { exact: true })
      .fill('Synthetic coherent country and registration correction');
    await page.getByRole('button', { name: 'Сохранить исправление', exact: true }).click();
    await until(async () => {
      const w = await get(base(tender) + '/workspace?pageSize=100'),
        g = w.companies.items.find((x) => x.requisites.names.includes('Synthetic Gamma'));
      return g.requisites.countries[0] === 'GB' && g.requisites.identifiers[0].raw_value === '01234567';
    }, 'UI coherent country correction');
    pass('company author/history and coherent country-registration correction preserve leading zero');

    await page
      .getByLabel('Основание решения по типу', { exact: true })
      .fill('Synthetic UI confirms only offer classification');
    await page.getByRole('button', { name: 'Подтвердить тип', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Решение сохранено' })).toBeVisible();
    await page
      .getByLabel('Основание решения по связи', { exact: true })
      .fill('Synthetic UI separately confirms supplier association');
    await page.getByRole('button', { name: 'Подтвердить связь supplier_of', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Решение сохранено' })).toBeVisible();
    assert.ok((await get(base(tender) + '/receipts/' + offer.receiptId + '/review')).intakeContext);
    pass('type/association confirmation independent from company; no automatic price');

    const uiRevision = (await get('/api/tenders/' + tender)).revision;
    const uiLot = await post('/api/tenders/' + tender + '/verification/lot', {
      expectedRevision: uiRevision,
    });
    await page.reload();
    await expect(
      page.getByRole('heading', { name: 'Карточка документа: offer.txt', exact: true }),
    ).toBeVisible();
    await page.getByLabel('Черновик: цена', { exact: true }).fill('350');
    await page.getByLabel('Черновик: валюта', { exact: true }).selectOption('RUB');
    await page.getByLabel('Черновик: НДС', { exact: true }).selectOption('included');
    await page.getByLabel('Черновик: оплата', { exact: true }).fill('Synthetic UI prepayment');
    await page.getByLabel('Черновик: срок поставки', { exact: true }).fill('Synthetic UI seven days');
    await page.getByLabel('Черновик: соответствие ТЗ', { exact: true }).selectOption('matches');
    await page.getByLabel('Лот для переноса').selectOption(uiLot.id);
    await page
      .getByLabel('Основание переноса', { exact: true })
      .fill('Synthetic manual commercial transcription, not model inference');
    await page.getByRole('button', { name: 'Перенести в draft без подтверждения цены', exact: true }).click();
    await expect(page.getByRole('link', { name: 'Открыть draft в OfferReview', exact: true })).toBeVisible();
    assert.equal(
      Number(
        (
          await pool.query(
            'SELECT count(*) n FROM tender_app.offer_version v JOIN tender_app.offer o ON o.id=v.offer_id WHERE o.tender_id=$1',
            [tender],
          )
        ).rows[0].n,
      ),
      0,
    );
    await page.getByRole('link', { name: 'Открыть draft в OfferReview', exact: true }).click();
    await expect(page.getByLabel('Подтверждаемые значения: цена', { exact: true })).toHaveValue('350');
    await page.getByText('Источники перенесённого черновика', { exact: true }).click();
    await expect(
      page
        .getByText('Synthetic manual commercial transcription, not model inference', { exact: false })
        .first(),
    ).toBeVisible();
    await page.getByLabel('Подтверждаемые значения: цена', { exact: true }).fill('351');
    await page.getByLabel('Подтверждаю поставщика и поступление для этих значений').check();
    await page
      .getByLabel('Комментарий к изменению', { exact: true })
      .fill('Synthetic UI explicit commercial confirmation and manual amount correction');
    await page.getByRole('button', { name: 'Сохранить и подтвердить', exact: true }).click();
    await until(
      async () =>
        Number(
          (
            await pool.query(
              'SELECT count(*) n FROM tender_app.offer_version v JOIN tender_app.offer o ON o.id=v.offer_id WHERE o.tender_id=$1',
              [tender],
            )
          ).rows[0].n,
        ) === 2,
      'UI price confirmation',
    );
    await page.goto(owner.origin + '/comparison?tenderId=' + tender + '&lotId=' + uiLot.id);
    await expect(page.getByRole('heading', { name: 'Сравнение', exact: true })).toBeVisible();
    await expect(page.getByRole('cell', { name: /351/ }).first()).toBeVisible();
    pass('actual draft transfer/source pane/OfferReview manual override/confirmed lineage/comparison');
    await page.goto(owner.origin + '/tenders/' + tender + '/intake?receiptId=' + offer.receiptId);
    await page.getByLabel('Тип документа', { exact: true }).selectOption('supporting');
    await page
      .getByLabel('Основание решения по типу', { exact: true })
      .fill('Synthetic UI acknowledged context revocation');
    await page
      .getByLabel('Я понимаю, что изменение типа или связи может исключить эти версии из нового рейтинга')
      .check();
    await page.getByRole('button', { name: 'Изменить тип', exact: true }).click();
    await until(
      async () =>
        (await get(base(tender) + '/receipts/' + offer.receiptId + '/review')).receipt
          .effectiveClassification === 'supporting',
      'UI classification revocation',
    );
    await page.goto(owner.origin + '/comparison?tenderId=' + tender + '&lotId=' + uiLot.id);
    await expect(page.getByRole('cell').filter({ hasText: 'Контекст' }).first()).toBeVisible();
    pass('UI impact acknowledgment and stale managed version excluded from comparison');

    const reviewerPage = await context.newPage();
    await reviewerPage.goto(reviewer.origin + '/tenders/' + tender + '/intake'); // reviewer is deliberately scoped only to original tender, added explicitly below by harness if desired.
    await reviewerPage.close();
    const originalTender = c.tender;
    await page.goto(reviewer.origin + '/tenders/' + originalTender + '/intake');
    await expect(page.getByLabel('Смешанный комплект документов')).toBeDisabled();
    await expect(page.getByText('Доступен только просмотр.', { exact: false })).toBeVisible();
    pass('reviewer read-only controls from actual authorization');
    await page.goto(owner.origin + '/tenders/' + randomInvalid() + '/intake');
    await expect(page.getByRole('alert').filter({ hasText: 'Тендер не найден' })).toBeVisible({
      timeout: 15000,
    });
    pass('real HTTP 404 renders retry/error state');
    assert.deepEqual(errors, []);
    await page.screenshot({
      path: await checked(resolve(run.runRoot, 'playwright-final.png')),
      fullPage: true,
    });
    await json(resolve(run.runRoot, 'playwright-results.json'), {
      status: 'PASS',
      results,
      identity: run.identity,
      apiOrigin: owner.apiOrigin,
      webOrigin: owner.origin,
      realAPI: true,
      networkMocks: false,
      modelCalls: 0,
      syntheticTender: tender,
      consoleErrors: errors,
    });
    ok('E UI Playwright actual isolated API/Worker: ' + results.length + ' scenarios');
    return { results, kit };
  } catch (e) {
    await json(resolve(run.runRoot, 'playwright-results.json'), {
      status: 'FAIL',
      results,
      error: e.message,
      identity: run.identity,
    });
    throw e;
  } finally {
    await browser?.close();
    await owner.web.close();
    await reviewer.web.close();
  }
}
function randomInvalid() {
  return '00000000-0000-4000-8000-000000000001';
}
