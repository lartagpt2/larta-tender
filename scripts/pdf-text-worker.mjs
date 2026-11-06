import { parentPort, workerData } from 'node:worker_threads';
// No URL input, rendering, scripting or network resources. This is a bounded worker,
// not an operating-system security sandbox.
globalThis.fetch = async () => {
  throw new Error('Network resources disabled');
};
try {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({
    data: new Uint8Array(workerData.bytes),
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    useWorkerFetch: false,
    useWasm: false,
    disableAutoFetch: true,
    disableStream: true,
    stopAtErrors: true,
    verbosity: 0,
  });
  const pdf = await task.promise;
  try {
    if (pdf.numPages > 30) throw new Error('page_limit');
    const pages = [];
    let total = 0;
    for (let page = 1; page <= pdf.numPages; page++) {
      const source = await pdf.getPage(page);
      const content = await source.getTextContent();
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
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim(),
        )
        .join('\n');
      total += text.length;
      if (text.length > 100000 || total > 500000) throw new Error('text_limit');
      pages.push({ page, text });
      source.cleanup();
    }
    parentPort.postMessage({ pages, hasText: pages.some((p) => p.text.trim()), diagnostics: [] });
  } finally {
    await task.destroy();
  }
} catch (error) {
  const code = ['page_limit', 'text_limit'].includes(error.message)
    ? error.message
    : error.name === 'PasswordException'
      ? 'encrypted_pdf'
      : 'invalid_pdf';
  parentPort.postMessage({ pages: [], hasText: false, diagnostics: [code] });
}
