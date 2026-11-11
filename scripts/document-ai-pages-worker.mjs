import { parentPort, workerData } from 'node:worker_threads';
import { inflateRawSync, crc32 } from 'node:zlib';
globalThis.fetch = async () => {
  throw new Error('network_disabled');
};
function entity(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_m, key) => {
    if (key[0] === '#') {
      const n = key[1].toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : Number(key.slice(1));
      if (!Number.isSafeInteger(n) || n < 32 || n > 0x10ffff) return '';
      return String.fromCodePoint(n);
    }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[key];
  });
}
function xlsx(bytes) {
  const b = Buffer.from(bytes);
  let end = -1;
  for (let p = b.length - 22; p >= Math.max(0, b.length - 65557); p--)
    if (b.readUInt32LE(p) === 0x06054b50) {
      end = p;
      break;
    }
  if (end < 0) throw new Error('invalid_xlsx');
  const count = b.readUInt16LE(end + 10),
    offset = b.readUInt32LE(end + 16);
  if (count > 200) throw new Error('xlsx_limit');
  const files = new Map();
  let p = offset,
    total = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > end || b.readUInt32LE(p) !== 0x02014b50) throw new Error('invalid_xlsx');
    const flags = b.readUInt16LE(p + 8),
      method = b.readUInt16LE(p + 10),
      crc = b.readUInt32LE(p + 16),
      packed = b.readUInt32LE(p + 20),
      size = b.readUInt32LE(p + 24),
      n = b.readUInt16LE(p + 28),
      e = b.readUInt16LE(p + 30),
      c = b.readUInt16LE(p + 32),
      local = b.readUInt32LE(p + 42);
    const name = b.subarray(p + 46, p + 46 + n).toString('utf8');
    p += 46 + n + e + c;
    total += size;
    if (
      flags & 1 ||
      ![0, 8].includes(method) ||
      size > 10 * 1024 * 1024 ||
      total > 40 * 1024 * 1024 ||
      size > Math.max(1024, packed * 100) ||
      !name ||
      name.includes('..') ||
      name.includes('\\') ||
      name.includes(':') ||
      name.startsWith('/') ||
      files.has(name) ||
      local + 30 > offset ||
      b.readUInt32LE(local) !== 0x04034b50
    )
      throw new Error('unsafe_xlsx');
    const ln = b.readUInt16LE(local + 26),
      le = b.readUInt16LE(local + 28),
      start = local + 30 + ln + le;
    if (start + packed > offset || b.subarray(local + 30, local + 30 + ln).toString() !== name)
      throw new Error('invalid_xlsx');
    const data =
      method === 0
        ? b.subarray(start, start + packed)
        : inflateRawSync(b.subarray(start, start + packed), { maxOutputLength: 10 * 1024 * 1024 });
    if (data.length !== size || crc32(data) !== crc) throw new Error('xlsx_integrity');
    if (name.endsWith('.xml')) {
      const xml = data.toString('utf8');
      if (/<!DOCTYPE|<!ENTITY|<f\b|<externalLink\b/i.test(xml))
        throw new Error('xlsx_formula_or_external_unsupported');
      files.set(name, xml);
    } else files.set(name, '');
  }
  const textOf = (xml) =>
    [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => entity(m[1])).join('');
  const shared = [
    ...(files.get('xl/sharedStrings.xml') ?? '').matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g),
  ].map((m) => textOf(m[1]));
  const sheets = [...files.keys()]
    .filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (!sheets.length || sheets.length > 10) throw new Error('xlsx_sheet_limit');
  return sheets.map((name, index) => {
    let count = 0;
    const lines = [];
    for (const row of files.get(name).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [];
      for (const cell of row[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
        if (++count > 10000) throw new Error('xlsx_cell_limit');
        const ref = cell[1].match(/\br="([A-Z]+\d+)"/)?.[1] ?? '?';
        const type = cell[1].match(/\bt="([^"]+)"/)?.[1];
        const raw = cell[2].match(/<v>([\s\S]*?)<\/v>/)?.[1];
        const value =
          type === 's'
            ? (shared[Number(raw)] ?? '')
            : type === 'inlineStr'
              ? textOf(cell[2])
              : entity(raw ?? '');
        cells.push(`${ref}: ${value}`);
      }
      if (cells.length) lines.push(cells.join(' | '));
    }
    const text = lines.join('\n');
    if (text.length > 50000) throw new Error('xlsx_text_limit');
    return { page: index + 1, text };
  });
}
try {
  const bytes = new Uint8Array(workerData.bytes);
  let pages;
  if (workerData.mime === 'application/pdf') {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task = getDocument({
      data: bytes,
      isEvalSupported: false,
      useWorkerFetch: false,
      useWasm: false,
      disableAutoFetch: true,
      stopAtErrors: true,
      verbosity: 0,
    });
    const pdf = await task.promise;
    try {
      if (pdf.numPages > 10) throw new Error('page_limit');
      pages = [];
      for (let n = 1; n <= pdf.numPages; n++) {
        const page = await pdf.getPage(n),
          content = await page.getTextContent();
        const lines = [];
        for (const item of content.items) {
          if (!('str' in item) || !item.str.trim()) continue;
          const y = item.transform[5],
            x = item.transform[4];
          let line = lines.find((l) => Math.abs(l.y - y) < 2);
          if (!line) {
            line = { y, words: [] };
            lines.push(line);
          }
          line.words.push({ x, text: item.str });
        }
        const text = lines
          .sort((a, b) => b.y - a.y)
          .map((l) =>
            l.words
              .sort((a, b) => a.x - b.x)
              .map((w) => w.text)
              .join(' '),
          )
          .join('\n');
        if (text.length > 50000) throw new Error('text_limit');
        if (text.trim()) pages.push({ page: n, text });
        else {
          const initial = page.getViewport({ scale: 1 }),
            scale = Math.min(2, Math.sqrt(2000000 / (initial.width * initial.height))),
            viewport = page.getViewport({ scale });
          if (!Number.isFinite(scale) || viewport.width <= 0 || viewport.height <= 0)
            throw new Error('invalid_pdf_size');
          const { canvas, context } = pdf.canvasFactory.create(
            Math.ceil(viewport.width),
            Math.ceil(viewport.height),
          );
          try {
            await page.render({ canvasContext: context, viewport }).promise;
            const png = canvas.toBuffer('image/png');
            if (png.length > 4 * 1024 * 1024) throw new Error('image_limit');
            pages.push({ page: n, text: '', image: png.toString('base64') });
          } finally {
            canvas.width = 0;
            canvas.height = 0;
          }
        }
        page.cleanup();
      }
    } finally {
      await task.destroy();
    }
  } else if (workerData.mime === 'text/plain') {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (text.length > 50000) throw new Error('text_limit');
    pages = [{ page: 1, text }];
  } else if (workerData.mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    pages = xlsx(bytes);
  else throw new Error('unsupported_format');
  parentPort.postMessage({ pages });
} catch (error) {
  const allowed = [
    'page_limit',
    'text_limit',
    'image_limit',
    'xlsx_limit',
    'unsafe_xlsx',
    'xlsx_sheet_limit',
    'xlsx_cell_limit',
    'xlsx_text_limit',
    'xlsx_formula_or_external_unsupported',
    'unsupported_format',
  ];
  parentPort.postMessage({
    error: allowed.includes(error.message) ? error.message : 'document_parse_failed',
  });
}
