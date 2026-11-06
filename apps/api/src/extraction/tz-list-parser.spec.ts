import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PdfTextExtractionService } from './pdf-text.service';
import { parseTzList } from './tz-list-parser';
jest.setTimeout(25000);
it('extracts seven exact items from synthetic PDF, with page evidence and separate technical groups', async () => {
  const text = await new PdfTextExtractionService().extractText(
    await readFile(resolve(__dirname, '../../../../tests/fixtures/tz-seven-items.pdf')),
  );
  expect(text.diagnostics).toEqual([]);
  expect(text.pages).toHaveLength(3);
  expect(text.hasText).toBe(true);
  const result = parseTzList(text.pages);
  expect(result.items).toHaveLength(7);
  expect(result.items.map((i) => i.quantity)).toEqual(['70', '40', '30', '30', '30', '40', '20']);
  expect(result.items.map((i) => i.page)).toEqual([2, 2, 2, 2, 2, 3, 3]);
  expect(result.items.map((i) => i.name)).toEqual(
    [
      'PU 32 T10/7660-V-Z-MG142',
      'PU 32 T10/7200-V-Z-MG142',
      'PU 32 T10/4140-V-Z-MG142',
      'PU 32 T10/2890-V-Z-MG142',
      'PU 32 T10/6720-V-Z-MG142',
      'T10/8350-V-PAZ/PVR',
      'T10/7660-V-PAZ/PVR',
    ].map((s) => 'Ремень Зубчатый Приводной ' + s),
  );
  expect(result.items.reduce((n, i) => n + Number(i.quantity), 0)).toBe(260);
  expect(result.groups).toHaveLength(2);
  expect(result.items[0].technicalRequirements).toContain('Supergrip / Longitudinal ribs');
  expect(result.items[4].technicalRequirements).toContain('NFT, PAZ');
  expect(result.items[5].technicalRequirements).toContain('PAZ / PAR');
  expect(result.items[5].technicalRequirements).not.toContain('Supergrip');
});
it('preserves leading digits, wrapped names, long dash and units without a period', () => {
  const result = parseTzList([
    {
      page: 2,
      text: 'Перечень позиций\n1. 32 Ремень T10/1234-V\nдлинный артикул — 4 шт\n6. Ремень T10/9999\n– 2 шт.',
    },
  ]);
  expect(result.items.map((i) => [i.name, i.quantity])).toEqual([
    ['32 Ремень T10/1234-V длинный артикул', '4'],
    ['Ремень T10/9999', '2'],
  ]);
});
it('keeps unknown quantity null and does not make technical details or version rows into items', () => {
  const result = parseTzList([
    {
      page: 1,
      text: 'Таблица версий\n1. Версия 2\nПеречень позиций\n1. Ремень T10/1234\nКорд — стальной\nШирина 32 мм\nПодписи\n1. Подпись',
    },
  ]);
  expect(result.items).toHaveLength(1);
  expect(result.items[0].quantity).toBeNull();
  expect(result.items[0].unit).toBeNull();
  expect(result.diagnostics).toContain('quantity_requires_review');
});
it('returns no invented text from an image-only/blank PDF and rejects invalid signature', async () => {
  const service = new PdfTextExtractionService();
  const result = await service.extractText(
    await readFile(resolve(__dirname, '../../../../tests/fixtures/tz-no-text.pdf')),
  );
  expect(result.hasText).toBe(false);
  expect(result.diagnostics).toEqual([]);
  expect(parseTzList(result.pages).items).toEqual([]);
  expect((await service.extractText(Buffer.from('not PDF'))).diagnostics).toEqual(['invalid_pdf']);
});
it('terminates an over-time worker with a safe diagnostic', async () => {
  const result = await new PdfTextExtractionService(1).extractText(
    await readFile(resolve(__dirname, '../../../../tests/fixtures/tz-seven-items.pdf')),
  );
  expect(result.diagnostics).toEqual(['timeout']);
});

it('accepts a list number on a separate line without losing the leading product digits', () => {
  const result = parseTzList([{ page: 2, text: 'Перечень позиций\n1.\n32 Ремень T10/1234\n– 3 шт' }]);
  expect(result.items.map((i) => [i.name, i.quantity, i.page])).toEqual([['32 Ремень T10/1234', '3', 2]]);
});
