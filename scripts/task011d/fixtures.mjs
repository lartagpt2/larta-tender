import { txt, asPdf, asXlsx, seller, inn, multipart } from '../task011c/fixtures.mjs';
import { createHash } from 'node:crypto';
export { txt, asPdf, asXlsx, seller, inn, multipart };
export const sha = (b) => createHash('sha256').update(b).digest('hex');
export const gamma = inn('900000003');
export const tenFiles = () => [
  asPdf('offer.pdf', 'Commercial offer; ' + seller('Synthetic Alpha')),
  txt('offer.txt', 'Commercial offer; ' + seller('Synthetic Beta', inn('900000002'))),
  asXlsx('offer.xlsx', 'Commercial offer; ' + seller('Synthetic Gamma', gamma)),
  txt('quality.txt', 'Quality certificate; ' + seller('Synthetic Alpha')),
  asPdf('quality.pdf', 'Quality certificate; ' + seller('Synthetic Beta', inn('900000002'))),
  asXlsx('quality.xlsx', 'Quality certificate; ' + seller('Synthetic Gamma', gamma)),
  txt(
    'specification.txt',
    'Technical specification; Buyer: Synthetic Buyer; Country: RU; INN: ' + inn('900000009'),
  ),
  asPdf(
    'specification.pdf',
    'Technical specification; Buyer: Synthetic Buyer; Country: RU; INN: ' + inn('900000009'),
  ),
  txt('supporting.txt', 'Supporting document; General information, no supplier proof.'),
  { name: 'broken.pdf', mime: 'application/pdf', content: Buffer.from('%PDF-1.7 SYNTHETIC broken') },
];
export function mail(name, sender, body, attachment) {
  const boundary = 'synthetic-mail';
  return {
    name,
    mime: 'message/rfc822',
    content: Buffer.from(
      'From: ' +
        sender +
        '\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="' +
        boundary +
        '"\r\n\r\n--' +
        boundary +
        '\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n' +
        body +
        '\r\n--' +
        boundary +
        '\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename="' +
        attachment.name +
        '"\r\nContent-Transfer-Encoding: base64\r\n\r\n' +
        attachment.content.toString('base64') +
        '\r\n--' +
        boundary +
        '--\r\n',
    ),
  };
}
