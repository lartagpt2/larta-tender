import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { randomUUID } from 'node:crypto';
import { VerificationDto } from './verification.dto';
const body = () => ({
  supplierId: randomUUID(),
  lotId: randomUUID(),
  documentId: randomUUID(),
  receiptId: randomUUID(),
  expectedVersion: 0,
  contextConfirmed: true,
  intent: 'draft',
  sourceType: 'document',
  sourceNote: 'Synthetic source',
  fields: {},
});
const check = (input: unknown) =>
  validate(plainToInstance(VerificationDto, input), { whitelist: true, forbidNonWhitelisted: true });
describe('verification API validation', () => {
  it('allows explicitly unknown draft fields without invented zero values', async () => {
    const v = plainToInstance(VerificationDto, body());
    expect(await validate(v)).toHaveLength(0);
    expect(v.fields.amount).toBeNull();
    expect(v.costsEnabled).toBe(false);
  });
  it.each(['-1', 'NaN', '1e9', '0.1234567', '100000000000000', '0,1'])(
    'rejects invalid monetary string %s',
    async (amount) => {
      expect((await check({ ...body(), fields: { amount } })).length).toBeGreaterThan(0);
    },
  );
  it.each([{ currency: 'XXX' }, { vatMode: 'guess' }, { unknown: 'field' }])(
    'rejects unapproved currency/VAT or unknown fields %j',
    async (fields) => {
      expect((await check({ ...body(), fields })).length).toBeGreaterThan(0);
    },
  );
  it('requires explicit supplier context acknowledgement', async () => {
    expect((await check({ ...body(), contextConfirmed: false })).length).toBeGreaterThan(0);
  });
  it('rejects zero quantities and oversized item arrays', async () => {
    expect(
      (await check({ ...body(), items: [{ lotItemId: randomUUID(), quantity: '0', unit: 'шт' }] })).length,
    ).toBeGreaterThan(0);
    expect(
      (
        await check({
          ...body(),
          items: Array.from({ length: 101 }, () => ({ lotItemId: randomUUID(), quantity: '1', unit: 'шт' })),
        })
      ).length,
    ).toBeGreaterThan(0);
  });
});
