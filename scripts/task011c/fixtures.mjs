import { pdf, xlsx, txt, multipart } from '../task011b/fixtures.mjs';
export { pdf, xlsx, txt, multipart };
export const inn = (prefix) =>
  prefix + (([2, 4, 10, 3, 5, 9, 4, 6, 8].reduce((s, w, i) => s + w * Number(prefix[i]), 0) % 11) % 10);
export const alpha = inn('900000001'),
  beta = inn('900000002');
export const seller = (name, id = alpha, extra = '') =>
  'Seller: ' + name + '; Country: RU; INN: ' + id + (extra ? '; ' + extra : '');
export const eml = (text) => ({
  name: 'six.eml',
  mime: 'message/rfc822',
  content: Buffer.from(
    'From: sender@example.invalid\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n' +
      text,
  ),
});
export const asPdf = (name, text) => ({ name, mime: 'application/pdf', content: pdf(text) });
export const asXlsx = (name, text) => ({
  name,
  mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  content: xlsx(text),
});
export function tenFiles() {
  return [
    asPdf(
      'one.pdf',
      'Commercial offer; ' +
        seller('Synthetic Alpha') +
        '; Buyer: Synthetic Buyer; Country: RU; INN: ' +
        inn('900000003'),
    ),
    txt('two.txt', 'Коммерческое предложение; Поставщик: Synthetic Alpha LLC; Страна: RU; ИНН: ' + alpha),
    asXlsx('three.xlsx', seller('Synthetic Alpha')),
    txt('four.txt', seller('Synthetic Beta', beta)),
    asPdf('five.pdf', seller('Synthetic Beta', beta)),
    eml(seller('Synthetic Beta', beta)),
    txt('seven.txt', 'Seller: Synthetic Gamma; Country: GB; Company Registration Number: 12345678'),
    asXlsx('eight.xlsx', 'Seller: Synthetic Gamma Ltd; Country: GB; Company Registration Number: 12345678'),
    txt('nine.txt', 'Buyer: Synthetic Buyer; Country: RU; INN: ' + inn('900000003')),
    asPdf('ten.pdf', 'Manufacturer: Synthetic Maker; Country: RU; INN: ' + inn('900000004')),
  ];
}
