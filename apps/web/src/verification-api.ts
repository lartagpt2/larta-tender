export interface CommercialFields {
  amount: string | null;
  currency: string | null;
  vatMode: 'included' | 'excluded' | 'unknown';
  paymentTerms: string | null;
  deliveryTerms: string | null;
  compliance: 'matches' | 'partial' | 'unknown';
}
export interface VerifiedItem {
  lotItemId: string;
  quantity: string;
  unit: string;
  unitPrice: string | null;
}
export interface VerifiedCost {
  name: string;
  treatment: 'add' | 'included' | 'unknown';
  amount: string | null;
  currency: string | null;
}
export interface VerificationMeta {
  offerId: string;
  versionId: string;
  documentId: string;
  receiptId: string;
  supplierId: string;
  lotId: string;
  original: CommercialFields;
  fields: CommercialFields;
  intent: 'draft' | 'confirm';
  items: VerifiedItem[];
  costs: VerifiedCost[];
  costsEnabled: boolean;
  questions: { id: string; text: string; resolved: boolean }[];
  sources: Record<string, { type: string; note: string; actorId: string; at: string }>;
  actorId: string;
  at: string;
}
export interface VerificationContext {
  scope: { title: string; revision: number; selectionMode: 'lot' | 'items' };
  lots: { id: string; name: string }[];
  lotItems: Record<string, { id: string; name: string; quantity: string; unit: string }[]>;
  suppliers: { id: string; name: string }[];
  documents: {
    id: string;
    name: string;
    receipts: {
      id: string;
      receivedAt: string;
      supplierName: string | null;
      senderEmail: string | null;
      stage: string | null;
      legacy: boolean;
    }[];
  }[];
  offers: {
    id: string;
    supplierId: string;
    lotId: string;
    status: string;
    warnings: { code: string; message: string }[];
    versions: {
      id: string;
      version: number;
      metadata: VerificationMeta | null;
      isInitial: boolean;
      stageId: string | null;
      amount: string | null;
    }[];
  }[];
}
export const emptyFields = (): CommercialFields => ({
  amount: null,
  currency: null,
  vatMode: 'unknown',
  paymentTerms: null,
  deliveryTerms: null,
  compliance: 'unknown',
});
export const sourceLabels: Record<string, string> = {
  document: 'Документ',
  phone: 'Телефон',
  email: 'Письмо',
  other: 'Другое',
};
export function decimalInput(value: string | null): string | null {
  return value?.replace(/[\s\u00a0]/g, '').replace(',', '.') || null;
}
export function normalizedFields(fields: CommercialFields): CommercialFields {
  return {
    ...fields,
    amount: decimalInput(fields.amount),
    currency: fields.currency || null,
    paymentTerms: fields.paymentTerms?.trim() || null,
    deliveryTerms: fields.deliveryTerms?.trim() || null,
  };
}

export const fieldLabels: Record<string, string> = {
  amount: 'Цена',
  currency: 'Валюта',
  vatMode: 'НДС',
  paymentTerms: 'Оплата',
  deliveryTerms: 'Срок поставки',
  compliance: 'Соответствие ТЗ',
  items: 'Позиции',
  costs: 'Расходы',
  costsEnabled: 'Учёт расходов',
};
