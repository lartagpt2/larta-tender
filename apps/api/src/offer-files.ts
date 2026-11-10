import { specificationType } from './specification-file';
export interface IncomingOfferFile {
  name: string;
  mime: string;
  content: Buffer;
  sender?: string;
  parent?: number;
}
export interface DocumentProcessingPort {
  inspect(file: IncomingOfferFile): { status: 'uploaded'; reason: string };
}
export class WaitingDocumentProcessor implements DocumentProcessingPort {
  inspect(file: IncomingOfferFile) {
    void file;
    return { status: 'uploaded' as const, reason: 'awaiting_local_processing' };
  }
}
export class FileRejected extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
function reject(code: string): never {
  throw new FileRejected(code);
}
function headers(text: string): Record<string, string> {
  if (text.length > 32768) reject('email_header_limit');
  const result: Record<string, string> = {};
  for (const line of text.replace(/\r\n[ \t]+/g, ' ').split('\r\n')) {
    const match = /^([a-zA-Z0-9-]+):[ \t]*(.*)$/.exec(line);
    if (!match || result[match[1].toLowerCase()] !== undefined) reject('unsupported_email_headers');
    result[match[1].toLowerCase()] = match[2];
  }
  return result;
}
/** Inspect only bounded ZIP metadata; never inflate XML or execute container content. */
function checkXlsx(content: Buffer) {
  let end = -1;
  for (let i = content.length - 22; i >= Math.max(0, content.length - 65557); i--) {
    if (content.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) reject('invalid_xlsx_container');
  const count = content.readUInt16LE(end + 10),
    size = content.readUInt32LE(end + 12),
    offset = content.readUInt32LE(end + 16);
  if (
    content.readUInt16LE(end + 4) !== 0 ||
    content.readUInt16LE(end + 6) !== 0 ||
    content.readUInt16LE(end + 8) !== count ||
    count === 0 ||
    count > 200 ||
    offset + size !== end ||
    end + 22 + content.readUInt16LE(end + 20) !== content.length
  )
    reject('xlsx_container_limit');
  let cursor = offset,
    total = 0;
  const names = new Set<string>();
  for (let n = 0; n < count; n++) {
    if (cursor + 46 > end || content.readUInt32LE(cursor) !== 0x02014b50) reject('invalid_xlsx_container');
    const flags = content.readUInt16LE(cursor + 8),
      method = content.readUInt16LE(cursor + 10),
      packed = content.readUInt32LE(cursor + 20),
      unpacked = content.readUInt32LE(cursor + 24),
      length = content.readUInt16LE(cursor + 28),
      extra = content.readUInt16LE(cursor + 30),
      comment = content.readUInt16LE(cursor + 32),
      local = content.readUInt32LE(cursor + 42);
    if (cursor + 46 + length + extra + comment > end) reject('invalid_xlsx_container');
    const name = content.subarray(cursor + 46, cursor + 46 + length).toString('utf8');
    total += unpacked;
    if (
      flags & 1 ||
      ![0, 8].includes(method) ||
      total > 40 * 1024 * 1024 ||
      unpacked > 10 * 1024 * 1024 ||
      unpacked > Math.max(1024, packed * 100) ||
      name.startsWith('/') ||
      name.includes('\\') ||
      name.includes(':') ||
      name.split('/').includes('..') ||
      Array.from(name).some((c) => c.charCodeAt(0) < 32) ||
      names.has(name) ||
      /\.(zip|eml|exe|bin)$/i.test(name)
    )
      reject('unsafe_xlsx_container');
    if (local + 30 > offset || content.readUInt32LE(local) !== 0x04034b50) reject('invalid_xlsx_container');
    const ll = content.readUInt16LE(local + 26),
      le = content.readUInt16LE(local + 28);
    if (
      local + 30 + ll + le + packed > offset ||
      content.subarray(local + 30, local + 30 + ll).toString('utf8') !== name
    )
      reject('invalid_xlsx_container');
    names.add(name);
    cursor += 46 + length + extra + comment;
  }
  if (cursor !== end || !names.has('[Content_Types].xml') || !names.has('xl/workbook.xml'))
    reject('invalid_xlsx_container');
}
/** Conservative MIME subset: CRLF, multipart/mixed, single-level, base64 attachments only. */
export function inspectOffer(file: IncomingOfferFile): IncomingOfferFile[] {
  if (!file.content.length || file.content.length > 20 * 1024 * 1024) reject('file_size');
  if (
    !file.name ||
    file.name.length > 255 ||
    /[\\/]/.test(file.name) ||
    Array.from(file.name).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  )
    reject('invalid_filename');
  const ext = file.name.toLowerCase().split('.').pop();
  if (ext === 'zip') reject('archive_handler_not_approved');
  if (ext === 'pdf' || ext === 'txt') {
    try {
      file.mime = specificationType(file.name, file.mime, file.content);
    } catch {
      reject('type_mismatch');
    }
    return [file];
  }
  // XLSX is a ZIP container. Preserve as opaque input; no decompression or XML execution.
  if (ext === 'xlsx') {
    if (
      ![
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/octet-stream',
      ].includes(file.mime) ||
      file.content.length < 4 ||
      file.content.readUInt32LE(0) !== 0x04034b50
    )
      reject('type_mismatch');
    checkXlsx(file.content);
    file.mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    return [file];
  }
  if (ext !== 'eml' || !['message/rfc822', 'application/octet-stream'].includes(file.mime))
    reject('unsupported_type');
  const text = file.content.toString('latin1');
  const split = text.indexOf('\r\n\r\n');
  if (split < 0) reject('invalid_email');
  const h = headers(text.slice(0, split));
  if (!h.from || !h['mime-version'] || h['mime-version'] !== '1.0') reject('invalid_email');
  const emails = h.from.match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+/gi) ?? [];
  file.sender = emails.length === 1 ? emails[0].toLowerCase() : undefined;
  file.mime = 'message/rfc822';
  const result = [file];
  const type = h['content-type'] ?? 'text/plain';
  if (/^text\/(plain|html)(?:;|$)/i.test(type)) return result;
  const boundary = /^multipart\/mixed;\s*boundary="([A-Za-z0-9'()+_,./:=? -]{1,70})"\s*$/i.exec(type)?.[1];
  if (!boundary) reject('unsupported_email_structure');
  const parts = text.slice(split + 4).split('--' + boundary);
  if (parts.length > 23 || !parts[parts.length - 1].startsWith('--')) reject('email_part_limit');
  for (const part of parts.slice(1, -1)) {
    const p = part.replace(/^\r\n/, '');
    const end = p.indexOf('\r\n\r\n');
    if (end < 0) reject('invalid_email');
    const ph = headers(p.slice(0, end));
    const disp = ph['content-disposition'] ?? '';
    if (!/^attachment;/i.test(disp)) {
      if (!/^text\/(plain|html)(?:;|$)/i.test(ph['content-type'] ?? 'text/plain'))
        reject('unsupported_email_structure');
      continue;
    }
    const name = /^attachment;\s*filename="([^"\r\n]+)"\s*$/i.exec(disp)?.[1];
    if (!name || ph['content-transfer-encoding']?.toLowerCase() !== 'base64')
      reject('unsupported_email_attachment');
    const encoded = p.slice(end + 4).replace(/\r\n/g, '');
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))
      reject('invalid_base64');
    const child = {
      name,
      mime: (ph['content-type'] ?? 'application/octet-stream').split(';')[0].trim().toLowerCase(),
      content: Buffer.from(encoded, 'base64'),
      sender: file.sender,
      parent: 0,
    };
    if (/\.(eml|zip)$/i.test(name)) reject('nested_container_not_supported');
    inspectOffer(child);
    result.push(child);
  }
  return result;
}
