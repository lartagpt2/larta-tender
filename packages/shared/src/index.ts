export type DocumentStatus = 'uploaded' | 'recognized' | 'review' | 'confirmed' | 'error';
export interface Evidence {
  documentId: string;
  location: string;
  excerpt: string;
}
export interface ExtractedField {
  value: string | null;
  confidence: number;
  source: Evidence | null;
}
export interface OfferDocument {
  id: string;
  originalName: string;
  sha256: string;
  bytes: number;
  mime: string;
  status: DocumentStatus;
  supplier: ExtractedField;
  email: ExtractedField;
  price: ExtractedField;
  currency: ExtractedField;
  payment: ExtractedField;
  delivery: ExtractedField;
  extraCost: ExtractedField;
  error?: string;
  version: number;
  createdAt: string;
}
export interface Tender {
  id: string;
  title: string;
  createdAt: string;
  specificationSkipped: boolean;
  documents: OfferDocument[];
}
export interface AuditEvent {
  id: string;
  at: string;
  action: string;
  tenderId: string;
  documentId?: string;
}
export interface SupplierGroup {
  name: string;
  documents: OfferDocument[];
}
export function groupSuppliers(documents: OfferDocument[]): SupplierGroup[] {
  const groups = new Map<string, OfferDocument[]>();
  for (const doc of documents) {
    const label = doc.supplier.value?.trim() || 'Поставщик не определён';
    const key = label.toLocaleLowerCase('ru');
    const group = groups.get(key);
    if (group) group.push(doc);
    else groups.set(key, [doc]);
  }
  return [...groups.values()].map((docs) => ({
    name: docs[0].supplier.value?.trim() || 'Поставщик не определён',
    documents: docs,
  }));
}
export function moneyToMinorUnits(value: string): bigint {
  const normalized = value.replace(/[\s\u00a0]/g, '').replace(',', '.');
  if (!/^\d{1,13}(\.\d{1,2})?$/.test(normalized)) throw new Error('Некорректная сумма');
  const [whole, fraction = ''] = normalized.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
}
export function offerTotal(price: string | null, extra: string | null): string | null {
  if (!price) return null;
  try {
    const amount = moneyToMinorUnits(price) + moneyToMinorUnits(extra || '0');
    return `${amount / 100n}.${(amount % 100n).toString().padStart(2, '0')}`;
  } catch {
    return null;
  }
}

export { suggestArticles, type ArticleCandidate } from './article-matching';
