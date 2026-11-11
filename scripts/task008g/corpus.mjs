// TASK-008G NEW held-out synthetic inputs; frozen before new inference.
import { chromium } from '@playwright/test';
import { createCanvas } from '@napi-rs/canvas';
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { access } from 'node:fs/promises';
import Decimal from 'decimal.js';
import { save, checked } from '../task008-gate-d/io.mjs';
const row = (description, quantity, price, delivery, unit = 'шт.', currency = 'RUB') => ({
  description,
  quantity,
  unit,
  unitPrice: price,
  lineTotal: price === null ? null : new Decimal(quantity).times(price).toFixed(),
  currency,
  delivery,
});
const quote = (id, name, taxId, kind, layout, items, delivery, extra = {}) => ({
  id,
  title: name,
  kind,
  layout,
  pages: 1,
  headers: {
    supplierName: `ООО «СИНТЕТИКА ${name}»`,
    taxId,
    buyerName: 'ООО «СИНТЕТИКА Заказчик Север-Учебный»',
    total: items.every((r) => r.lineTotal !== null)
      ? items.reduce((n, r) => n.plus(r.lineTotal), new Decimal(0)).toFixed()
      : null,
    currency: items[0].currency,
    delivery,
    payment: 'Оплата через 14 календарных дней после приёмки',
    vat: 'Без НДС',
    deliveryCost: null,
  },
  items,
  ...extra,
});
export const cases = [
  quote(
    'g01-eur-header',
    'Нефритовый мост',
    '0000002301',
    'native',
    'letter',
    [
      row('Термостат НМ-1101', '4', '1780.25', '18 календарных дней', 'шт.', 'EUR'),
      row('Регулятор НМ-1102', '6', '79.6', '9 календарных дней', 'шт.', 'EUR'),
      row('Экран НМ-1103', '2', '145.75', '12 календарных дней', 'шт.', 'EUR'),
    ],
    '18 календарных дней',
    { hideRowCurrency: true },
  ),
  quote(
    'g02-usd-table',
    'Оливковый источник',
    '0000002302',
    'native',
    'table',
    [
      row('Патрубок ОИ-1201', '7', '68.4', '13 рабочих дней', 'шт.', 'USD'),
      row('Шайба ОИ-1202', '45', '1.28', '5 рабочих дней', 'шт.', 'USD'),
      row('Переходник ОИ-1203', '9', '14.95', '8 рабочих дней', 'шт.', 'USD'),
    ],
    '13 рабочих дней',
    { hideRowCurrency: true, hideDocumentCurrency: true, tableCurrency: 'USD' },
  ),
  quote(
    'g03-multipage',
    'Бирюзовый стержень',
    '0000002303',
    'native',
    'letter',
    [
      row('Секция БС-1301', '3', '4930', '16 рабочих дней'),
      row('Рукоятка БС-1302', '8', '352.5', '6 рабочих дней'),
      row('Кожух БС-1303', '2', '6810', '25 рабочих дней'),
    ],
    '25 рабочих дней',
    { pages: 2, hideRowCurrency: true },
  ),
  quote(
    'g04-conflicting',
    'Песочный диапазон',
    '0000002304',
    'native',
    'letter',
    [
      row('Пластина ПД-1401', '12', '318', '7 рабочих дней'),
      row('Пробка ПД-1402', '30', '27.4', '4 рабочих дня'),
      row('Сетка ПД-1403', '5', '995', '14 рабочих дней'),
    ],
    '14 рабочих дней',
    {
      hideRowCurrency: true,
      globalCurrencies: ['RUB', 'EUR'],
      expectedWarnings: ['currency_header_missing_or_ambiguous'],
    },
  ),
  quote(
    'g05-scan-eur',
    'Изумрудный виток',
    '0000002305',
    'scan',
    'letter',
    [
      row('Пневмоцилиндр ИВ-1501', '2', '438.75', '32 календарных дня', 'шт.', 'EUR'),
      row('Клапанный блок ИВ-1502', '3', '129.8', '21 календарный день', 'шт.', 'EUR'),
      row('Переходная муфта ИВ-1503', '10', '6.65', '11 календарных дней', 'шт.', 'EUR'),
    ],
    '32 календарных дня',
  ),
  quote(
    'g06-scan-articles',
    'Лиловый профиль',
    '0000002306',
    'scan',
    'table',
    [
      row('Корпус РС-1601', '5', '2460', '8 рабочих дней'),
      row('Панель НТ-1602', '3', '1875.6', '12 рабочих дней'),
      row('Вставка АК-1603', '14', '93.75', '6 рабочих дней'),
    ],
    '12 рабочих дней',
  ),
  quote(
    'g07-scan-fractions',
    'Топазовый слой',
    '0000002307',
    'scan',
    'letter',
    [
      row('Трос ТС-1701', '2.375', '153.6', '17 календарных дней', 'м', 'CNY'),
      row('Паста ТС-1702', '0.875', '720', '9 календарных дней', 'кг', 'CNY'),
      row('Шпилька ТС-1703', '7', '11.45', '6 календарных дней', 'шт.', 'CNY'),
    ],
    '17 календарных дней',
    { tiltDegrees: 0.6 },
  ),
  quote(
    'g08-no-currency',
    'Медовый импульс',
    '0000002308',
    'native',
    'letter',
    [
      row('Диафрагма МИ-1801', '6', '834', '10 рабочих дней'),
      row('Колпак МИ-1802', '4', '287.5', '15 рабочих дней'),
      row('Палец МИ-1803', '16', null, '5 рабочих дней'),
    ],
    '15 рабочих дней',
    { hideRowCurrency: true, hideDocumentCurrency: true },
  ),
];
// Expected absences are authored BEFORE inference. Printed conflicting headings remain in the PDF.
for (const id of ['g04-conflicting', 'g08-no-currency']) {
  const c = cases.find((c) => c.id === id);
  c.headers.currency = null;
  c.items.forEach((r) => {
    r.currency = null;
  });
}
const fmt = (s) =>
  s === null ? 'не указано' : new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 6 }).format(Number(s));
const esc = (s) => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
function sections(c, p) {
  const h = c.headers,
    per = Math.ceil(c.items.length / c.pages),
    rows = c.items.slice(p * per, (p + 1) * per);
  const buyer = [`Заказчик: ${h.buyerName}`, 'ИНН заказчика: 9999997123'];
  const seller = [`Поставщик: ${h.supplierName}`, ...(h.taxId ? [`ИНН поставщика: ${h.taxId}`] : [])];
  const top = [
    'СИНТЕТИЧЕСКИЙ ОБРАЗЕЦ — НЕ ДЛЯ ЗАКУПКИ',
    `Коммерческое предложение ${c.id}; лист ${p + 1}/${c.pages}`,
    ...(c.buyerFirst ? [...buyer, ...seller] : [...seller, ...buyer]),
  ];
  const bottom =
    p === c.pages - 1
      ? [
          ...(h.total !== null
            ? [`Итого: ${fmt(h.total)} ${c.hideRowCurrency || !h.currency ? '' : h.currency}`]
            : ['Итоговая стоимость не указана.']),
          ...(c.hideDocumentCurrency
            ? []
            : (c.globalCurrencies ?? [h.currency])
                .filter(Boolean)
                .map((code) => `Валюта предложения: ${code}`)),
          `НДС: ${h.vat}`,
          ...(h.delivery ? [`Срок поставки: ${h.delivery}`] : []),
          `Оплата: ${h.payment}`,
        ]
      : ['Продолжение перечня на следующем листе.'];
  return { top, rows, bottom };
}
export function lines(c, p) {
  const { top, rows, bottom } = sections(c, p);
  return [
    ...top,
    ...rows.flatMap((r) => [
      r.description,
      `Количество: ${fmt(r.quantity)} ${r.unit} | Цена: ${fmt(r.unitPrice)} ${c.hideRowCurrency || !r.currency ? '' : r.currency} | Сумма: ${fmt(r.lineTotal)} ${c.hideRowCurrency || !r.currency ? '' : r.currency}`,
      ...(r.delivery ? [`Срок позиции: ${r.delivery}`] : []),
    ]),
    ...bottom,
  ];
}
function pdf(objects) {
  const chunks = [Buffer.from('%PDF-1.7\n')],
    offsets = [0];
  let size = chunks[0].length;
  objects.forEach((object, i) => {
    offsets.push(size);
    const b = Buffer.concat([
      Buffer.from(`${i + 1} 0 obj\n`),
      Buffer.isBuffer(object) ? object : Buffer.from(object),
      Buffer.from('\nendobj\n'),
    ]);
    chunks.push(b);
    size += b.length;
  });
  chunks.push(
    Buffer.from(
      `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
        .slice(1)
        .map((n) => String(n).padStart(10, '0') + ' 00000 n \n')
        .join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${size}\n%%EOF`,
    ),
  );
  return Buffer.concat(chunks);
}
function stream(bytes, extra = '') {
  return Buffer.concat([
    Buffer.from(`<< /Length ${bytes.length} ${extra} >>\nstream\n`),
    bytes,
    Buffer.from('\nendstream'),
  ]);
}
function scan(c) {
  const w = 1800,
    h = 1400,
    objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      `<< /Type /Pages /Kids [${Array.from({ length: c.pages }, (_, i) => `${3 + i * 3} 0 R`).join(' ')}] /Count ${c.pages} >>`,
    ];
  for (let p = 0; p < c.pages; p++) {
    const canvas = createCanvas(w, h),
      ctx = canvas.getContext('2d');
    ctx.fillStyle = '#faf9f6';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#1c1c1c';
    ctx.translate(w / 2, h / 2);
    ctx.rotate(((c.tiltDegrees ?? 0) * Math.PI) / 180);
    ctx.translate(-w / 2, -h / 2);
    ctx.font = '25px sans-serif';
    if (c.layout === 'table') {
      const { top, rows, bottom } = sections(c, p);
      top.forEach((s, i) => ctx.fillText(s, 45, 45 + i * 43));
      const xs = [45, 610, 760, 870, 1120, 1370];
      ['Наименование', 'Кол-во', 'Ед.', 'Цена, RUB', 'Сумма, RUB', 'Срок'].forEach((s, i) =>
        ctx.fillText(s, xs[i], 350),
      );
      rows.forEach((r, i) => {
        const y = 415 + i * 78;
        [r.description, fmt(r.quantity), r.unit, fmt(r.unitPrice), fmt(r.lineTotal), r.delivery].forEach(
          (s, k) => ctx.fillText(s ?? '—', xs[k], y),
        );
        ctx.strokeStyle = '#888';
        ctx.beginPath();
        ctx.moveTo(45, y + 24);
        ctx.lineTo(1760, y + 24);
        ctx.stroke();
      });
      bottom.forEach((s, i) => ctx.fillText(s, 45, 960 + i * 48));
    } else lines(c, p).forEach((s, i) => ctx.fillText(s, 45, 45 + i * 48));
    const rgba = ctx.getImageData(0, 0, w, h).data,
      rgb = Buffer.alloc(w * h * 3);
    for (let k = 0; k < w * h; k++) {
      rgb[k * 3] = rgba[k * 4];
      rgb[k * 3 + 1] = rgba[k * 4 + 1];
      rgb[k * 3 + 2] = rgba[k * 4 + 2];
    }
    const n = 3 + p * 3;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 900 700] /Resources << /XObject << /Im0 ${n + 1} 0 R >> >> /Contents ${n + 2} 0 R >>`,
      stream(
        deflateSync(rgb),
        `/Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode`,
      ),
      stream(Buffer.from('q 900 0 0 700 0 0 cm /Im0 Do Q')),
    );
    canvas.width = 0;
    canvas.height = 0;
  }
  return pdf(objects);
}
export async function generate(out) {
  // An existing generated set must never be silently regenerated or overwritten.
  for (const c of cases) {
    const target = await checked(resolve(out, c.id + '.pdf'));
    await access(target).then(
      () => {
        throw new Error('Corpus already exists');
      },
      (e) => {
        if (e.code !== 'ENOENT') throw e;
      },
    );
  }
  const browser = await chromium.launch({ headless: true }),
    generated = [];
  try {
    for (const c of cases) {
      let bytes;
      if (c.kind === 'scan') bytes = scan(c);
      else {
        const page = await browser.newPage();
        await page.route('**/*', (r) => r.abort());
        const html = Array.from({ length: c.pages }, (_, p) => {
          const { top, rows, bottom } = sections(c, p);
          const body =
            c.layout === 'table'
              ? top.map((t) => `<p>${esc(t)}</p>`).join('') +
                '<table><thead><tr><th>Наименование</th><th>Кол-во</th><th>Ед.</th><th>Цена</th><th>Сумма</th><th>Срок</th></tr></thead><tbody>' +
                rows
                  .map(
                    (r) =>
                      '<tr>' +
                      [r.description, fmt(r.quantity), r.unit, fmt(r.unitPrice), fmt(r.lineTotal), r.delivery]
                        .map((t) => `<td>${esc(t ?? '—')}</td>`)
                        .join('') +
                      '</tr>',
                  )
                  .join('') +
                '</tbody></table>' +
                bottom.map((t) => `<p>${esc(t)}</p>`).join('')
              : lines(c, p)
                  .map((t) => `<p>${esc(t)}</p>`)
                  .join('');
          return `<section>${body}</section>`;
        }).join('');
        await page.setContent(
          `<html lang="ru"><meta charset="utf-8"><style>@page{size:A4;margin:16mm}body{font:12px Arial,sans-serif}section{break-after:page}section:last-child{break-after:auto}p{margin:0 0 11px;white-space:pre-wrap}table{border-collapse:collapse;width:100%;margin:18px 0}td,th{border:1px solid #555;padding:8px;font-size:11px}</style>${c.tableCurrency ? html.replace('<th>Цена</th>', '<th>Цена, ' + c.tableCurrency + '</th>').replace('<th>Сумма</th>', '<th>Сумма, ' + c.tableCurrency + '</th>') : html}</html>`,
        );
        bytes = await page.pdf({ preferCSSPageSize: true, printBackground: true });
        await page.close();
      }
      const path = resolve(out, c.id + '.pdf');
      await save(path, bytes);
      generated.push({ ...c, path, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
    return generated;
  } finally {
    await browser.close();
  }
}
