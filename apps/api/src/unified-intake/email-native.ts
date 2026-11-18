import type { IncomingOfferFile } from '../offer-files';
export function emailTextPages(file: IncomingOfferFile): { page: number; text: string }[] {
  // Existing bounded EML subset; headers/From/filenames never establish an organization role.
  let raw: string;
  try {
    raw = new TextDecoder('utf-8', { fatal: true }).decode(file.content);
  } catch {
    return [];
  }
  const split = raw.indexOf('\r\n\r\n');
  if (split < 0) return [];
  const head = raw.slice(0, split),
    body = raw.slice(split + 4);
  const boundary = head.match(/boundary="([^"]+)"/i)?.[1];
  const candidates = boundary ? body.split('--' + boundary).slice(1, -1) : [raw];
  const output: { page: number; text: string }[] = [];
  for (const part of candidates) {
    const text = part.replace(/^\r\n/, '');
    const at = text.indexOf('\r\n\r\n');
    if (at < 0) continue;
    const headers = text.slice(0, at),
      encoded = text.slice(at + 4).replace(/\r\n$/, '');
    if (
      /content-disposition:\s*attachment/i.test(headers) ||
      !/content-type:\s*text\/plain(?:;|\r|$)/i.test(headers)
    )
      continue;
    if (/charset\s*=\s*"?((?!utf-8\b|us-ascii\b)[^";\r]+)/i.test(headers)) continue;
    const encoding = headers
      .match(/content-transfer-encoding:\s*([^\r\n]+)/i)?.[1]
      .trim()
      .toLowerCase();
    let decoded: string;
    if (encoding === 'base64' && /^[a-z\d+/=\r\n]+$/i.test(encoded)) {
      try {
        decoded = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(encoded, 'base64'));
      } catch {
        continue;
      }
    } else if (!encoding || ['7bit', '8bit'].includes(encoding)) decoded = encoded;
    else continue;
    if (decoded.length > 50000) continue;
    output.push({ page: output.length + 1, text: decoded });
  }
  return output;
}
