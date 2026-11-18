import { TextPage } from './organizations';
export const commercialSchema = 'intake-commercial-native-v1';
export interface CommercialCandidate {
  field: string;
  value: string;
  page: number;
  excerpt: string;
}
export interface CommercialPort {
  readonly method: 'native_labeled' | 'test_mock';
  extract(pages: TextPage[]): Promise<CommercialCandidate[]>;
}
export class NativeCommercialPort implements CommercialPort {
  readonly method = 'native_labeled' as const;
  async extract(pages: TextPage[]) {
    const found: CommercialCandidate[] = [];
    const patterns: [string, RegExp][] = [
      [
        'amount',
        /(?:Total amount|Amount|Итого|Стоимость)\s*:\s*((?:0|[1-9]\d{0,13})(?:\.\d{1,6})?)(?![\d.,])/i,
      ],
      ['currency', /(?:Currency|Валюта)\s*:\s*(RUB|USD|EUR|CNY)\b/i],
      ['paymentTerms', /(?:Payment terms|Условия оплаты)\s*:\s*([^\r\n;]{1,1000})/i],
      ['deliveryTerms', /(?:Delivery terms|Срок поставки)\s*:\s*([^\r\n;]{1,1000})/i],
      ['vatMode', /(?:VAT|НДС)\s*:\s*(included|excluded)\b/i],
    ];
    for (const [field, pattern] of patterns) {
      const candidates = pages.flatMap((p) => {
        const matches = [...p.text.matchAll(new RegExp(pattern.source, pattern.flags + 'g'))];
        return matches.map((match) => ({
          field,
          value: field === 'currency' ? match[1].toUpperCase() : match[1].trim(),
          page: p.page,
          excerpt: match[0].trim().slice(0, 1800),
        }));
      });
      // Conflicting native values remain missing, never choose an arbitrary amount.
      if (new Set(candidates.map((v) => v.value)).size === 1) found.push(candidates[0]);
    }
    return found;
  }
}
