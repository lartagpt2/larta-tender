import { FileRejected, inspectOffer, WaitingDocumentProcessor } from './offer-files';
const pdf = (name = 'offer.pdf') => ({
  name,
  mime: 'application/pdf',
  content: Buffer.from('%PDF-1.7 synthetic'),
});
function eml(from = 'Sales <sales@example.test>', attachment = 'offer.pdf') {
  return {
    name: 'message.eml',
    mime: 'message/rfc822',
    content: Buffer.from(
      `From: ${from}\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="sample"\r\n\r\n--sample\r\nContent-Type: text/plain\r\n\r\nSynthetic\r\n--sample\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename="${attachment}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${pdf().content.toString('base64')}\r\n--sample--\r\n`,
    ),
  };
}
describe('bounded offer file intake', () => {
  it('retains original email and decodes attachment, preserving sender evidence', () => {
    const input = eml(),
      parts = inspectOffer(input);
    expect(parts).toHaveLength(2);
    expect(parts[0].content).toEqual(input.content);
    expect(parts[1].content).toEqual(pdf().content);
    expect(parts[1].sender).toBe('sales@example.test');
    expect(parts[1].parent).toBe(0);
  });
  it('does not invent an ambiguous sender', () => {
    expect(inspectOffer(eml('a@example.test, b@example.test'))[1].sender).toBeUndefined();
  });
  it.each(['../offer.pdf', 'C:\\offer.pdf', 'bad\u0000.pdf'])(
    'rejects dangerous input and attachment names %s',
    (name) => {
      expect(() => inspectOffer(pdf(name))).toThrow(FileRejected);
      expect(() => inspectOffer(eml(undefined, name))).toThrow(FileRejected);
    },
  );
  it('rejects every unapproved ZIP without decompressing even an apparent bomb', () => {
    expect(() =>
      inspectOffer({ name: 'bomb.zip', mime: 'application/zip', content: Buffer.from('PK\x03\x04') }),
    ).toThrow('archive_handler_not_approved');
  });
  it('rejects nested containers, malformed and unsupported MIME', () => {
    expect(() => inspectOffer(eml(undefined, 'nested.eml'))).toThrow('nested_container_not_supported');
    expect(() =>
      inspectOffer({ name: 'a.eml', mime: 'message/rfc822', content: Buffer.from('garbage') }),
    ).toThrow('invalid_email');
    expect(() =>
      inspectOffer({ name: 'a.pdf', mime: 'application/pdf', content: Buffer.from('not pdf') }),
    ).toThrow('type_mismatch');
  });
  it('rejects empty/oversized files and short XLSX signatures safely', () => {
    expect(() => inspectOffer({ ...pdf(), content: Buffer.alloc(0) })).toThrow('file_size');
    expect(() => inspectOffer({ ...pdf(), content: Buffer.alloc(20 * 1024 * 1024 + 1) })).toThrow(
      'file_size',
    );
    expect(() =>
      inspectOffer({ name: 'a.xlsx', mime: 'application/octet-stream', content: Buffer.from('P') }),
    ).toThrow('type_mismatch');
  });
  it('never claims OCR or extracts commercial terms', () => {
    expect(new WaitingDocumentProcessor().inspect(pdf())).toEqual({
      status: 'uploaded',
      reason: 'awaiting_local_processing',
    });
  });
});

function xlsxFixture(names = ['[Content_Types].xml', 'xl/workbook.xml'], declaredSize = 1): Buffer {
  const local: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const name of names) {
    const bytes = Buffer.from(name),
      header = Buffer.alloc(30),
      data = Buffer.from('x');
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(1, 18);
    header.writeUInt32LE(declaredSize, 22);
    header.writeUInt16LE(bytes.length, 26);
    local.push(header, bytes, data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50);
    c.writeUInt16LE(20, 6);
    c.writeUInt32LE(1, 20);
    c.writeUInt32LE(declaredSize, 24);
    c.writeUInt16LE(bytes.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, bytes);
    offset += header.length + bytes.length + data.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
describe('opaque XLSX metadata guard', () => {
  const file = (content: Buffer) => ({ name: 'synthetic.xlsx', mime: 'application/octet-stream', content });
  it('accepts bounded OOXML container metadata without inflating XML', () => {
    expect(inspectOffer(file(xlsxFixture()))).toHaveLength(1);
  });
  it('rejects traversal, archive bombs and disguised arbitrary ZIP', () => {
    expect(() => inspectOffer(file(xlsxFixture(['../escape', 'xl/workbook.xml'])))).toThrow(
      'unsafe_xlsx_container',
    );
    expect(() => inspectOffer(file(xlsxFixture(undefined, 10000000)))).toThrow('unsafe_xlsx_container');
    expect(() => inspectOffer(file(xlsxFixture(['random.txt'])))).toThrow('invalid_xlsx_container');
  });
});
