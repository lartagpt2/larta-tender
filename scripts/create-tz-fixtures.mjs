import { chromium } from '@playwright/test';
import { resolve } from 'node:path';
// Synthetic only: no customer file, contacts or external resources.
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const names = [
    'PU 32 T10/7660-V-Z-MG142',
    'PU 32 T10/7200-V-Z-MG142',
    'PU 32 T10/4140-V-Z-MG142',
    'PU 32 T10/2890-V-Z-MG142',
    'PU 32 T10/6720-V-Z-MG142',
    'T10/8350-V-PAZ/PVR',
    'T10/7660-V-PAZ/PVR',
  ];
  const quantities = [70, 40, 30, 30, 30, 40, 20];
  const item = (i) => `<p>${i + 1}. Ремень Зубчатый Приводной ${names[i]} – ${quantities[i]} шт.</p>`;
  await page.setContent(
    `<meta charset="utf-8"><style>@page{margin:25mm}body{font:14px Arial;line-height:1.6}section{break-after:page}section:last-child{break-after:auto}</style><section><h1>Синтетическое техническое задание</h1><p>Приобретение транспортных ремней конвейеров</p><h2>Таблица версий</h2><p>1. Версия 1, подготовлена для автоматических тестов</p><p>2. Редакция 2, не является закупаемой позицией</p></section><section><h2>Перечень позиций</h2>${[0, 1, 2, 3, 4].map(item).join('')}<h3>Технические требования к позициям 1–5</h3><p>Корд — стальной; ширина 32 мм.</p><p>На зубчатой стороне полиамидная (нейлоновая) ткань NFT, PAZ.</p><p>С обратной гладкой стороны — ПВХ Supergrip / Longitudinal ribs.</p></section><section>${[5, 6].map(item).join('')}<h3>Технические требования к позициям 6–7</h3><p>Корд — стальной; ширина 32 мм.</p><p>Покрытие PAZ / PAR — полиамидная ткань на зубчатой и наружной сторонах.</p><h2>Подписи</h2><p>1. Подпись согласующего — тестовый блок</p></section>`,
  );
  await page.pdf({ path: resolve('tests/fixtures/tz-seven-items.pdf'), format: 'A4', printBackground: true });
  await page.setContent(
    '<style>@page{margin:25mm}div{width:200px;height:200px;background:#ccc;border:3px solid #111}</style><div></div>',
  );
  await page.pdf({ path: resolve('tests/fixtures/tz-no-text.pdf'), format: 'A4' });
  console.log('Created synthetic three-page text PDF and text-free PDF.');
} finally {
  await browser.close();
}
