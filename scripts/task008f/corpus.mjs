// TASK-008F held-out synthetic inputs. No inference results are used in authoring.
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
    'f01-letter',
    'Кедровый маршрут',
    '0000001201',
    'native',
    'letter',
    [
      row('Реле учебное КМ-701', '7', '438.5', '6 рабочих дней'),
      row('Клемма учебная КМ-702', '24', '17.25', '3 рабочих дня'),
      row('Корпус учебный КМ-703', '2', '2063', '11 рабочих дней'),
    ],
    '11 рабочих дней',
  ),
  quote(
    'f02-table',
    'Гранатовый сектор',
    '0000001202',
    'native',
    'table',
    [
      row('Преобразователь ГС-811', '3', '12750', '21 календарный день'),
      row('Скоба ГС-812', '16', '83.4', '7 календарных дней'),
      row('Штуцер ГС-813', '9', '211.8', '14 календарных дней'),
      row('Прокладка ГС-814', '32', '9.75', '5 календарных дней'),
    ],
    'Не позднее 18.02.2027',
  ),
  quote(
    'f03-measures',
    'Базальтовая нить',
    '0000001203',
    'native',
    'letter',
    [
      row('Шнур учебный БН-921', '12.75', '42.8', '9 рабочих дней', 'м'),
      row('Порошок учебный БН-922', '1.625', '960', '16 рабочих дней', 'кг'),
      row('Плёнка учебная БН-923', '105.5', '7.35', '4 рабочих дня', 'м'),
    ],
    '16 рабочих дней',
  ),
  quote(
    'f04-scan-letter',
    'Васильковый контур',
    '0000001204',
    'scan',
    'letter',
    [
      row('Пульт учебный ВК-431', '2', '8740', 'В наличии'),
      row('Модуль учебный ВК-432', '5', '1460.8', '13 рабочих дней'),
      row('Держатель учебный ВК-433', '11', '93', '8 рабочих дней'),
    ],
    '13 рабочих дней',
  ),
  quote(
    'f05-scan-table',
    'Янтарная сборка',
    '0000001205',
    'scan',
    'table',
    [
      row('Кольцо ЯС-541', '18', '31.2', '2 рабочих дня'),
      row('Винт ЯС-542', '150', '4.7', '3 рабочих дня'),
      row('Гайка ЯС-543', '125', '3.6', '5 рабочих дней'),
      row('Опора ЯС-544', '8', '420', '12 рабочих дней'),
      row('Кронштейн ЯС-545', '6', '975.25', '17 рабочих дней'),
    ],
    '17 рабочих дней',
  ),
  quote(
    'f06-two-pages',
    'Лазурный привод',
    '0000001206',
    'native',
    'letter',
    [
      row('Муфта учебная ЛП-651', '4', '1520', '10 календарных дней'),
      row('Шкив учебный ЛП-652', '3', '2780', '12 календарных дней'),
      row('Цепь учебная ЛП-653', '8.5', '340', '15 календарных дней', 'м'),
      row('Звёздочка учебная ЛП-654', '6', '890', '18 календарных дней'),
      row('Ступица учебная ЛП-655', '2', '5100', '22 календарных дня'),
      row('Шпонка учебная ЛП-656', '10', '65', '7 календарных дней'),
    ],
    '22 календарных дня',
    { pages: 2 },
  ),
  quote(
    'f07-party-roles',
    'Вересковый узел',
    '0000001207',
    'scan',
    'letter',
    [
      row('Трансформатор ВУ-761', '2', '15800', '24 рабочих дня'),
      row('Разъём ВУ-762', '14', '213.5', '6 рабочих дней'),
    ],
    '24 рабочих дня',
    { buyerFirst: true },
  ),
  quote(
    'f08-unquoted',
    'Рябиновый резерв',
    null,
    'native',
    'letter',
    [row('Изолятор РР-871', '13', '165', null), row('Контактор РР-872', '3', null, null)],
    null,
  ),
  quote(
    'f09-euro',
    'Серебряная ось',
    '0000001209',
    'scan',
    'letter',
    [
      row('Энкодер СО-981', '3', '286.4', '28 календарных дней', 'шт.', 'EUR'),
      row('Втулка СО-982', '12', '8.95', '10 календарных дней', 'шт.', 'EUR'),
    ],
    '28 календарных дней',
  ),
  quote(
    'f10-conditional',
    'Малахитовый шаг',
    '0000001210',
    'native',
    'letter',
    [
      row('Фланец МШ-191', '5', '730', 'После оплаты: 8 рабочих дней', 'шт.', 'QXZ'),
      row('Уплотнитель МШ-192', '2.25', '310', 'После оплаты: 6 рабочих дней', 'кг', 'QXZ'),
      row('Хомут МШ-193', '15', '18.6', 'После оплаты: 4 рабочих дня', 'шт.', 'QXZ'),
    ],
    'DAP, учебная площадка № 7; 8 рабочих дней после оплаты',
    {
      expectedWarnings: ['unknown_currency'],
    },
  ),
  quote(
    'f11-tilted',
    'Сиреневый пакет',
    '0000001211',
    'scan',
    'letter',
    [
      row('Провод СП-291', '27.5', '61.2', '12 календарных дней', 'м'),
      row('Гранулят СП-292', '3.125', '480', '19 календарных дней', 'кг'),
      row('Блок СП-293', '4', '3190', '23 календарных дня'),
    ],
    '23 календарных дня',
    { tiltDegrees: 0.8 },
  ),
  quote(
    'f12-dense-table',
    'Каштановый вектор',
    '0000001212',
    'scan',
    'table',
    [
      row('Клапан КВ-391', '9', '515', '4 рабочих дня'),
      row('Седло КВ-392', '9', '206', '9 рабочих дней'),
      row('Шток КВ-393', '18', '132.5', '11 рабочих дней'),
      row('Сальник КВ-394', '36', '27.8', '14 рабочих дней'),
      row('Пружина КВ-395', '24', '45.6', '16 рабочих дней'),
      row('Крышка КВ-396', '9', '382', '20 рабочих дней'),
    ],
    '20 рабочих дней',
  ),
];
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
            ? [`Итого: ${fmt(h.total)} ${h.currency}`]
            : ['Итоговая стоимость не указана.']),
          `Валюта предложения: ${h.currency}`,
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
      `Количество: ${fmt(r.quantity)} ${r.unit} | Цена: ${fmt(r.unitPrice)} ${r.currency} | Сумма: ${fmt(r.lineTotal)} ${r.currency}`,
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
          `<html lang="ru"><meta charset="utf-8"><style>@page{size:A4;margin:16mm}body{font:12px Arial,sans-serif}section{break-after:page}section:last-child{break-after:auto}p{margin:0 0 11px;white-space:pre-wrap}table{border-collapse:collapse;width:100%;margin:18px 0}td,th{border:1px solid #555;padding:8px;font-size:11px}</style>${html}</html>`,
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
