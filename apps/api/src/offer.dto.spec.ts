import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AssociateOfferDto } from './offer.dto';
const check = (body: unknown) =>
  validate(plainToInstance(AssociateOfferDto, body), { whitelist: true, forbidNonWhitelisted: true });
describe('supplier creation DTO', () => {
  it('trims mandatory name and accepts missing optional contact fields', async () => {
    const dto = plainToInstance(AssociateOfferDto, {
      revision: 1,
      note: '  Synthetic basis ',
      newSupplier: { name: '  Synthetic supplier ', email: '  ', registrationNumber: ' ' },
    });
    expect(await validate(dto)).toHaveLength(0);
    expect(dto.newSupplier?.name).toBe('Synthetic supplier');
    expect(dto.newSupplier?.email).toBeUndefined();
    expect(dto.note).toBe('Synthetic basis');
  });
  it.each([
    { name: ' ' },
    { name: 'x', email: 'invalid' },
    [],
    null,
    { name: 'x', unknown: 'value' },
    { name: 'x', registrationNumber: 'x'.repeat(65) },
  ])('rejects invalid nested supplier %j', async (newSupplier) => {
    expect((await check({ revision: 1, note: 'Synthetic basis', newSupplier })).length).toBeGreaterThan(0);
  });
  it('accepts optional international registration and contact metadata', async () => {
    expect(
      await check({
        revision: 1,
        note: 'Synthetic basis',
        newSupplier: {
          name: 'Synthetic',
          registrationNumber: 'REG:005B',
          email: 'sales@example.test',
          comment: 'Synthetic comment',
        },
      }),
    ).toHaveLength(0);
  });
  it('validates revisions and existing supplier UUIDs', async () => {
    expect((await check({ revision: 0, note: 'Synthetic', supplierId: 'invalid' })).length).toBeGreaterThan(
      0,
    );
    expect(await check({ revision: 1, note: 'Synthetic', supplierId: null })).toHaveLength(0);
  });
});
