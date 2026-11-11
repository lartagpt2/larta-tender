import { crc32 } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { documentPages } from './pages';
function sheetZip(formula = false, unsafe = false): Buffer {
  const data: Record<string, string> = {
    '[Content_Types].xml': '<Types/>',
    'xl/workbook.xml': '<workbook/>',
    [unsafe ? '../outside.xml' : 'xl/worksheets/sheet1.xml']:
      `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Synthetic equipment</t></is></c><c r="B1">${formula ? '<f>1+1</f>' : ''}<v>2</v></c></row></sheetData></worksheet>`,
  };
  const local: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(data)) {
    const bytes = Buffer.from(text),
      n = Buffer.from(name),
      crc = crc32(bytes),
      l = Buffer.alloc(30),
      c = Buffer.alloc(46);
    l.writeUInt32LE(0x04034b50);
    l.writeUInt16LE(20, 4);
    l.writeUInt32LE(crc, 14);
    l.writeUInt32LE(bytes.length, 18);
    l.writeUInt32LE(bytes.length, 22);
    l.writeUInt16LE(n.length, 26);
    c.writeUInt32LE(0x02014b50);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(bytes.length, 20);
    c.writeUInt32LE(bytes.length, 24);
    c.writeUInt16LE(n.length, 28);
    c.writeUInt32LE(offset, 42);
    local.push(l, n, bytes);
    central.push(c, n);
    offset += l.length + n.length + bytes.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(3, 8);
  end.writeUInt16LE(3, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
describe('bounded local document preparation', () => {
  it('reads bounded XLSX cells as literal text with cell references', async () => {
    const rows = await documentPages(
      sheetZip(),
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(rows[0].text).toContain('A1: Synthetic equipment');
    expect(rows[0].text).toContain('B1: 2');
  });
  it('does not evaluate spreadsheet formulas or follow archive paths', async () => {
    await expect(
      documentPages(sheetZip(true), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
    ).rejects.toThrow('xlsx_formula_or_external_unsupported');
    await expect(
      documentPages(
        sheetZip(false, true),
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ),
    ).rejects.toThrow('unsafe_xlsx');
  });
  it('extracts native PDF text without turning text into an image', async () => {
    const result = await documentPages(
      await readFile(resolve('tests/fixtures/tz-seven-items.pdf')),
      'application/pdf',
    );
    expect(result.some((p) => p.text.length > 0)).toBe(true);
    expect(result.every((p) => !p.image)).toBe(true);
  });
  it('renders a text-free PDF as a real PNG for vision', async () => {
    const result = await documentPages(
      await readFile(resolve('tests/fixtures/tz-no-text.pdf')),
      'application/pdf',
    );
    expect(result[0].image).toBeTruthy();
    expect(Buffer.from(result[0].image!, 'base64').subarray(1, 4).toString()).toBe('PNG');
    expect(result[0].text).toBe('');
  });
  it('rejects broken/unsupported originals without remote calls', async () => {
    await expect(documentPages(Buffer.from('%PDF-broken'), 'application/pdf')).rejects.toThrow(
      'document_parse_failed',
    );
    await expect(documentPages(Buffer.from('zip'), 'application/zip')).rejects.toThrow('unsupported_format');
  });
});
