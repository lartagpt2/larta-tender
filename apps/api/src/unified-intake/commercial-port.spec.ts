import { NativeCommercialPort } from './commercial-port';
describe('native commercial source candidates', () => {
  const port = new NativeCommercialPort();
  it('keeps exact labeled values and page excerpts without a model', async () => {
    const values = await port.extract([
      {
        page: 3,
        text: 'Amount: 123.45; Currency: RUB; VAT: included; Payment terms: after delivery; Delivery terms: seven days',
      },
    ]);
    expect(values.find((v) => v.field === 'amount')).toEqual({
      field: 'amount',
      value: '123.45',
      page: 3,
      excerpt: 'Amount: 123.45',
    });
    expect(values.find((v) => v.field === 'currency')?.value).toBe('RUB');
    expect(values.find((v) => v.field === 'paymentTerms')?.value).toBe('after delivery');
    expect(port.method).toBe('native_labeled');
  });
  it('does not invent absent prices from supplier names or unlabeled numbers', async () => {
    expect(await port.extract([{ page: 1, text: 'Synthetic Alpha, 900000001. Seven items.' }])).toEqual([]);
  });
  it('abstains on conflicting prices across pages', async () => {
    expect(
      (
        await port.extract([
          { page: 1, text: 'Amount: 100' },
          { page: 2, text: 'Amount: 200' },
        ])
      ).some((v) => v.field === 'amount'),
    ).toBe(false);
  });
  it('abstains on conflicting prices within the same page', async () => {
    expect(
      (await port.extract([{ page: 1, text: 'Amount: 100; Amount: 200' }])).some((v) => v.field === 'amount'),
    ).toBe(false);
  });
  it('preserves repeated identical values with their first actual source', async () => {
    expect(
      (await port.extract([{ page: 1, text: 'Amount: 100; Amount: 100' }])).filter(
        (v) => v.field === 'amount',
      ),
    ).toEqual([{ field: 'amount', value: '100', page: 1, excerpt: 'Amount: 100' }]);
  });
});
