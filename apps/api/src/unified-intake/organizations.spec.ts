import { countryKey, identifier } from './organization-identity';
import {
  DisabledLocalAIAdapter,
  NativeOrganizationsExtractor,
  organizationSchema,
  TestOrganizationsMock,
  validateOrganizations,
  OrganizationRequest,
  organizationText,
} from './organizations';
const request = (text: string): OrganizationRequest => ({
  tenderId: 't',
  originalId: 'd',
  receiptId: 'r',
  contractVersion: organizationSchema,
  pages: [{ page: 1, text }],
  structure: { mime: 'text/plain' },
});
const extractor = new NativeOrganizationsExtractor();
const inn = (prefix: string) =>
  prefix + (([2, 4, 10, 3, 5, 9, 4, 6, 8].reduce((s, w, i) => s + w * Number(prefix[i]), 0) % 11) % 10);
describe('TASK011C evidenced organizations', () => {
  test.each(['900000001', '900000002', '012345678'])(
    'INN checksum and leading zero preserved %s',
    (prefix) => {
      const value = inn(prefix);
      expect(identifier('RU', 'RU_INN', value).normalized_value).toBe(value);
      expect(identifier('RU', 'RU_INN', value.slice(0, -1) + ((Number(value.at(-1)) + 1) % 10)).valid).toBe(
        false,
      );
    },
  );
  test('12 digit INN checksum, invalid lengths/zero, explicit country and foreign subset', () => {
    expect(identifier('RU', 'RU_INN', '500100732259').valid).toBe(true);
    for (const v of ['123', '0000000000', '500100732258'])
      expect(identifier('RU', 'RU_INN', v).valid).toBe(false);
    expect(identifier(null, 'RU_INN', inn('900000001')).valid).toBe(false);
    expect(identifier('GB', 'GB_CRN', 'SC123456').valid).toBe(true);
    expect(identifier('GB', 'RU_INN', inn('900000001')).valid).toBe(false);
    expect(identifier('GB', 'UNKNOWN_VAT', 'GB123').valid).toBe(false);
    expect(countryKey('United Kingdom')).toBe('GB');
  });
  test.each([
    ['Поставщик', 'supplier'],
    ['Продавец', 'supplier'],
    ['Покупатель', 'buyer'],
    ['Изготовитель', 'manufacturer'],
    ['Грузоперевозчик', 'carrier'],
    ['Грузоотправитель', 'other'],
    ['Seller / Buyer', 'unknown'],
    ['Организация', 'unknown'],
  ])('explicit role %s', async (label, role) => {
    const input = request(label + ': Synthetic; Страна: RU; ИНН: ' + inn('900000001'));
    const orgs = await extractor.extract(input);
    expect(orgs[0].role).toBe(role);
    expect(() => validateOrganizations(orgs, input.pages)).not.toThrow();
  });
  test('multiple roles and complete per-field evidence; names never guessed from field labels', async () => {
    const input = request(
      'Buyer: Synthetic Buyer; Country: RU; INN: ' +
        inn('900000002') +
        '\nSeller: Synthetic; Legal Name: Synthetic LLC; Country: RU; INN: ' +
        inn('900000001') +
        '; Address: Synthetic Street; Email: one@example.invalid; Phone: 123',
    );
    const orgs = await extractor.extract(input);
    expect(orgs).toHaveLength(2);
    expect(orgs.map((o) => o.role)).toEqual(['buyer', 'supplier']);
    expect(orgs[1].evidence_by_field.address).toBeDefined();
    expect(orgs[1].evidence_by_field['emails.0']).toBeDefined();
    expect(() => validateOrganizations(orgs, input.pages)).not.toThrow();
    const unnamed = await extractor.extract(request('Seller: ; Country: RU; INN: ' + inn('900000001')));
    expect(unnamed[0].name).toBeNull();
    expect(unnamed[0].warnings).toContain('missing_name');
  });
  test('no arbitrary organization inference, missing ID and conflicting IDs need review', async () => {
    expect(await extractor.extract(request('Synthetic LLC 1234567890 random text'))).toEqual([]);
    expect((await extractor.extract(request('Seller: Synthetic')))[0].review_state).toBe('needs_review');
    const conflict = (
      await extractor.extract(
        request('Seller: Synthetic; Country: RU; INN: ' + inn('900000001') + '; INN: ' + inn('900000002')),
      )
    )[0];
    expect(conflict.warnings).toContain('conflicting_identifiers');
  });
  test('supported plain EML body is native; corrupt UTF8/unsupported encoding gives no organizations', async () => {
    const header =
      'From: synthetic@example.invalid\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: ';
    const input = (encoding: string, body: string) => ({
      name: 'synthetic.eml',
      mime: 'message/rfc822',
      content: Buffer.from(header + encoding + '\r\n\r\n' + body),
    });
    expect(await organizationText(input('8bit', 'Seller: Synthetic'))).toEqual([
      { page: 1, text: 'Seller: Synthetic' },
    ]);
    expect(await organizationText(input('base64', '/w=='))).toEqual([]);
    expect(await organizationText(input('quoted-printable', 'Seller: Synthetic'))).toEqual([]);
  });
  test('missing/unrelated evidence and role substitution rejected; mock tagged and disabled adapter inert', async () => {
    const input = request('Buyer: Synthetic; Country: GB; Company Registration Number: 12345678');
    const orgs = await extractor.extract(input);
    const mock = new TestOrganizationsMock(() => orgs);
    expect((await mock.extract(input))[0].extraction_method).toBe('test_mock');
    expect(await new DisabledLocalAIAdapter().extract(input)).toEqual([]);
    orgs[0].role = 'supplier';
    expect(() => validateOrganizations(orgs, input.pages)).toThrow('role_evidence_mismatch');
    orgs[0].role = 'buyer';
    orgs[0].name = 'invented';
    expect(() => validateOrganizations(orgs, input.pages)).toThrow();
  });
});
