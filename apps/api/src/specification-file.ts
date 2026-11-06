import { BadRequestException } from '@nestjs/common';
export function specificationType(name: string, mime: string, content: Buffer): string {
  if (
    name.length > 255 ||
    /[\\/]/.test(name) ||
    Array.from(name).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
    !content.length
  )
    throw new BadRequestException();
  const lower = name.toLowerCase();
  if (
    lower.endsWith('.pdf') &&
    ['application/pdf', 'application/octet-stream'].includes(mime) &&
    content.subarray(0, 5).toString('ascii') === '%PDF-'
  )
    return 'application/pdf';
  if (
    lower.endsWith('.txt') &&
    ['text/plain', 'application/octet-stream'].includes(mime) &&
    !content.includes(0)
  ) {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(content);
      return 'text/plain';
    } catch {
      throw new BadRequestException();
    }
  }
  throw new BadRequestException();
}
