import { crc32 } from 'node:zlib';
import { quotePdf } from '../task008-fixtures.mjs';
export function pdf(text) {
  const stream = 'BT /F1 12 Tf 30 700 Td (' + text.replace(/[()\\]/g, ' ') + ') Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 800 800] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Length ' + Buffer.byteLength(stream) + ' >>\nstream\n' + stream + '\nendstream',
  ];
  let textOut = '%PDF-1.7\n';
  const offsets = [0];
  for (const [i, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(textOut));
    textOut += i + 1 + ' 0 obj\n' + object + '\nendobj\n';
  }
  const xref = Buffer.byteLength(textOut);
  textOut +=
    'xref\n0 6\n0000000000 65535 f \n' +
    offsets
      .slice(1)
      .map((v) => String(v).padStart(10, '0') + ' 00000 n \n')
      .join('') +
    'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' +
    xref +
    '\n%%EOF';
  return Buffer.from(textOut);
}
export function xlsx(text, formula = false) {
  const escaped = text.replaceAll('&', '&amp;').replaceAll('<', '&lt;');
  const entries = {
    '[Content_Types].xml':
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>',
    'xl/workbook.xml':
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets><sheet name="Synthetic" sheetId="1"/></sheets></workbook>',
    'xl/worksheets/sheet1.xml':
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr">' +
      (formula ? '<f>1+1</f>' : '') +
      '<is><t>' +
      escaped +
      '</t></is></c></row></sheetData></worksheet>',
  };
  const locals = [],
    directory = [];
  let offset = 0;
  for (const [name, value] of Object.entries(entries)) {
    const n = Buffer.from(name),
      data = Buffer.from(value),
      crc = crc32(data),
      local = Buffer.alloc(30),
      central = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(n.length, 26);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, n, data);
    directory.push(central, n);
    offset += local.length + n.length + data.length;
  }
  const d = Buffer.concat(directory),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(3, 8);
  end.writeUInt16LE(3, 10);
  end.writeUInt32LE(d.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, d, end]);
}
export const txt = (name, text) => ({ name, mime: 'text/plain', content: Buffer.from(text) });
export function mixedFiles() {
  return [
    {
      name: 'one.pdf',
      mime: 'application/pdf',
      content: pdf('SYNTHETIC Technical specification. Quantity: 2 pcs.'),
    },
    txt('two.txt', 'СИНТЕТИЧЕСКИЙ ДОКУМЕНТ. Коммерческое предложение. Цена 100 RUB.'),
    {
      name: 'three.xlsx',
      mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      content: xlsx('Паспорт качества SYNTHETIC'),
    },
    txt('four.txt', 'Приложение №1. Синтетические характеристики.'),
    txt('five.txt', 'СИНТЕТИЧЕСКИЙ файл без назначения.'),
    { name: 'six.pdf', mime: 'application/pdf', content: quotePdf(true) },
    { name: 'seven.pdf', mime: 'application/pdf', content: Buffer.from('%PDF-1.7 broken synthetic') },
    {
      name: 'eight.pdf',
      mime: 'application/pdf',
      content: pdf('SYNTHETIC Supporting appendix. Dimensions.'),
    },
    {
      name: 'nine.xlsx',
      mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      content: xlsx('Commercial offer SYNTHETIC'),
    },
    txt('ten.txt', 'СИНТЕТИЧЕСКОЕ техническое задание на поставку.'),
  ];
}
export function multipart(files) {
  const boundary = 'intake-' + crypto.randomUUID(),
    chunks = [];
  for (const f of files)
    chunks.push(
      Buffer.from(
        '--' +
          boundary +
          '\r\nContent-Disposition: form-data; name="files"; filename="' +
          f.name +
          '"\r\nContent-Type: ' +
          f.mime +
          '\r\n\r\n',
      ),
      f.content,
      Buffer.from('\r\n'),
    );
  chunks.push(Buffer.from('--' + boundary + '--\r\n'));
  return {
    headers: { 'content-type': 'multipart/form-data; boundary=' + boundary },
    payload: Buffer.concat(chunks),
  };
}
