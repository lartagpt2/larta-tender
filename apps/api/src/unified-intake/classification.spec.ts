import { classify } from './classification';
const file = (text: string, name = 'neutral.txt') => ({
  name,
  mime: 'text/plain',
  content: Buffer.from(text),
});
describe('native intake classification with source evidence', () => {
  it.each([
    ['Техническое задание на поставку.', 'specification'],
    ['Коммерческое предложение на товары.', 'offer'],
    ['Сертификат качества материала.', 'quality_certificate'],
    ['Приложение №1 с размерами.', 'supporting'],
  ])('classifies literal content, without a model: %s', async (text, type) => {
    const value = await classify(file(text));
    expect(value.type).toBe(type);
    expect(value.evidence[0].excerpt).toContain(text);
    expect(value.coverage.model).toBe(false);
    expect(value.coverage.ocr).toBe(false);
  });
  it('does not treat misleading names as proof', async () => {
    const value = await classify(file('Неопределённое синтетическое содержимое.', 'commercial-offer.txt'));
    expect(value.type).toBe('unknown');
    expect(value.reason).toBe('insufficient_content_evidence');
  });
  it('abstains on contradictory markers and preserves both sources', async () => {
    const value = await classify(file('Technical specification. Commercial offer.'));
    expect(value.type).toBe('unknown');
    expect(value.reason).toBe('ambiguous_content_markers');
    expect(value.evidence).toHaveLength(2);
  });
  it('keeps EML as a container, without inventing a semantic classification', async () => {
    const value = await classify({
      name: 'mail.eml',
      mime: 'message/rfc822',
      content: Buffer.from('Synthetic'),
    });
    expect(value.type).toBe('unknown');
    expect(value.coverage.nativeTextAttempted).toBe(true);
    expect(value.coverage.model).toBe(false);
    expect(value.coverage.ocr).toBe(false);
  });
});
