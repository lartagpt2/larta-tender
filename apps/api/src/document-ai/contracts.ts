import Ajv from 'ajv';
import Decimal from 'decimal.js';
const ExactDecimal = Decimal.clone({ precision: 60 });
export const schemaVersion = 'document-draft-v2',
  promptVersion = 'untrusted-compact-evidence-v2';
export interface Evidence {
  sourceDocumentId?: string;
  rawValue: string | null;
  value: string | null;
  page: number | null;
  evidenceSnippet: string | null;
  confidence: null;
}
export interface DraftItem {
  description: Evidence;
  sku: Evidence;
  quantity: Evidence;
  unit: Evidence;
  unitPrice: Evidence;
  lineTotal: Evidence;
  currency: Evidence;
  delivery: Evidence;
  technicalRequirements: Evidence;
}
export interface AIDraft {
  supplierName: Evidence;
  taxId: Evidence;
  kpp: Evidence;
  buyerName: Evidence;
  consignee: Evidence;
  documentNumber: Evidence;
  documentDate: Evidence;
  email: Evidence;
  address: Evidence;
  total: Evidence;
  currency: Evidence;
  vat: Evidence;
  payment: Evidence;
  delivery: Evidence;
  deliveryCost: Evidence;
  validUntil: Evidence;
  remarks: Evidence;
  items: DraftItem[];
}
const field = {
  type: 'object',
  additionalProperties: false,
  required: ['rawValue', 'value', 'page', 'evidenceSnippet', 'confidence'],
  properties: {
    rawValue: { type: ['string', 'null'], maxLength: 2000 },
    value: { type: ['string', 'null'], maxLength: 2000 },
    page: { type: ['integer', 'null'], minimum: 1, maximum: 30 },
    evidenceSnippet: { type: ['string', 'null'], maxLength: 2000 },
    confidence: { type: 'null' },
  },
};
export const fieldNames = [
  'supplierName',
  'taxId',
  'kpp',
  'buyerName',
  'consignee',
  'documentNumber',
  'documentDate',
  'email',
  'address',
  'total',
  'currency',
  'vat',
  'payment',
  'delivery',
  'deliveryCost',
  'validUntil',
  'remarks',
] as const;
export const itemNames = [
  'description',
  'sku',
  'quantity',
  'unit',
  'unitPrice',
  'lineTotal',
  'currency',
  'delivery',
  'technicalRequirements',
] as const;
export const draftSchema = {
  type: 'object',
  additionalProperties: false,
  required: [...fieldNames, 'items'],
  properties: {
    ...Object.fromEntries(fieldNames.map((k) => [k, field])),
    items: {
      type: 'array',
      maxItems: 100,
      items: {
        type: 'object',
        additionalProperties: false,
        required: itemNames,
        properties: Object.fromEntries(itemNames.map((k) => [k, field])),
      },
    },
  },
};
const validate = new Ajv({ strict: true }).compile(draftSchema);
export function emptyField(): Evidence {
  return { rawValue: null, value: null, page: null, evidenceSnippet: null, confidence: null };
}
export function emptyDraft(): AIDraft {
  return { ...Object.fromEntries(fieldNames.map((k) => [k, emptyField()])), items: [] } as unknown as AIDraft;
}
export function numeric(raw: string | null): string | null {
  if (raw === null) return null;
  const match = raw
    .trim()
    .match(
      /^(?:(?:Qty|Quantity|Количество|UnitPrice|Unit price|Цена|Amount|Сумма|Grand total|Total|Итого)\s*:?\s*)?((?:\d{1,3}(?:[ \u00a0]\d{3})+|\d+)(?:[.,]\d{1,6})?)\s*(?:RUB|USD|EUR|CNY|руб\.?|₽|pcs|pieces|шт\.?)?$/i,
    );
  if (!match) return null;
  const value = match[1].replace(/[\s\u00a0]/g, '').replace(',', '.');
  if (!/^(?:0|[1-9]\d{0,13})(?:\.\d{1,6})?$/.test(value)) return null;
  return new ExactDecimal(value).toFixed();
}
export function validateDraft(
  input: unknown,
  pages: { page: number; text: string }[],
  vision = false,
): { draft: AIDraft; warnings: string[] } {
  if (!validate(input)) throw new Error('invalid_ai_schema');
  const draft = structuredClone(input) as unknown as AIDraft,
    warnings = new Set<string>();
  const entries = [
    ...fieldNames.map((k) => [k, draft[k]] as const),
    ...draft.items.flatMap((item, i) => itemNames.map((k) => [`${i}:${k}`, item[k]] as const)),
  ];
  for (const [key, value] of entries) {
    const source = pages.find((p) => p.page === value.page);
    if (value.value === null) continue;
    if (!source || !value.rawValue || !value.evidenceSnippet) {
      value.value = null;
      warnings.add('missing_evidence');
      continue;
    }
    if (
      (!vision || !!source.text.trim()) &&
      !source.text.replace(/\s+/g, ' ').includes(value.evidenceSnippet.replace(/\s+/g, ' '))
    ) {
      value.value = null;
      warnings.add('unverified_evidence');
      continue;
    }
    if (
      (!vision || !!source.text.trim()) &&
      !value.evidenceSnippet.replace(/\s+/g, ' ').includes(value.rawValue.replace(/\s+/g, ' '))
    ) {
      value.value = null;
      warnings.add('raw_value_not_in_evidence');
      continue;
    }
    const name = key.split(':').at(-1)!;
    if (
      [
        'supplierName',
        'buyerName',
        'consignee',
        'taxId',
        'kpp',
        'email',
        'address',
        'documentNumber',
      ].includes(name)
    )
      value.value = value.rawValue.trim();
    if (['quantity', 'unitPrice', 'lineTotal', 'total', 'deliveryCost'].includes(name)) {
      value.value = numeric(value.rawValue);
      if (value.value === null) warnings.add('invalid_number');
    }
    if (name === 'currency' && !['RUB', 'USD', 'EUR', 'CNY'].includes(value.value ?? ''))
      warnings.add('unknown_currency');
  }
  // A unit printed literally inside the quantity is deterministic evidence, not a guessed unit.
  for (const item of draft.items) {
    if (item.unit.value !== null || item.quantity.value === null) continue;
    const unit = item.quantity.rawValue?.match(/\s(pcs|pieces|шт\.?)$/i)?.[1];
    if (unit) item.unit = { ...item.quantity, rawValue: unit, value: unit, confidence: null };
  }
  let sum = new ExactDecimal(0),
    complete = draft.items.length > 0;
  for (const item of draft.items) {
    const { quantity: q, unitPrice: p, lineTotal: t } = item;
    if (q.value === null || p.value === null) {
      complete = false;
      warnings.add('missing_line_price');
      continue;
    }
    if (new ExactDecimal(q.value).lte(0)) warnings.add('nonpositive_quantity');
    const amount = new ExactDecimal(q.value).mul(p.value);
    sum = sum.add(amount);
    if (t.value !== null && !amount.eq(t.value)) warnings.add('line_arithmetic_mismatch');
    if (item.currency.value && draft.currency.value && item.currency.value !== draft.currency.value)
      warnings.add('mixed_currency');
  }
  if (complete && draft.total.value !== null && !sum.eq(draft.total.value))
    warnings.add('total_arithmetic_mismatch');
  if (draft.total.value === null) warnings.add('missing_total');
  if (vision) warnings.add('vision_evidence_requires_review');
  return { draft, warnings: [...warnings] };
}
export interface AIPage {
  page: number;
  text: string;
  image?: string;
}
export interface AIResult {
  draft: AIDraft;
  model: string;
  digest: string | null;
  warnings: string[];
  durationMs: number;
}
export interface LocalDocumentAI {
  extract(pages: AIPage[]): Promise<AIResult>;
}

const wireField = {
  anyOf: [
    { type: 'null' },
    {
      type: 'object',
      additionalProperties: false,
      required: ['text', 'page', 'snippet'],
      properties: {
        text: { type: 'string', maxLength: 2000 },
        page: { type: 'integer', minimum: 1, maximum: 30 },
        snippet: { type: 'string', maxLength: 240 },
      },
    },
  ],
};
export const wireSchema = {
  type: 'object',
  additionalProperties: false,
  required: [...fieldNames, 'items'],
  properties: {
    ...Object.fromEntries(fieldNames.map((k) => [k, wireField])),
    items: {
      type: 'array',
      maxItems: 100,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [...itemNames, 'page', 'snippet'],
        properties: {
          ...Object.fromEntries(itemNames.map((k) => [k, { type: ['string', 'null'], maxLength: 2000 }])),
          page: { type: 'integer', minimum: 1, maximum: 30 },
          snippet: { type: 'string', maxLength: 500 },
        },
      },
    },
  },
};
interface WireField {
  text: string;
  page: number;
  snippet: string;
}
interface WireDraft {
  items: (Record<(typeof itemNames)[number], string | null> & { page: number; snippet: string })[];
  [key: string]: WireField | null | WireDraft['items'];
}
const validateWire = new Ajv({ strict: true }).compile(wireSchema);
export function expandWireDraft(input: unknown): AIDraft {
  if (!validateWire(input)) throw new Error('invalid_ai_schema');
  const wire = input as unknown as WireDraft,
    draft = emptyDraft();
  const field = (text: string | null, page: number | null, snippet: string | null): Evidence => ({
    rawValue: text,
    value: text,
    page,
    evidenceSnippet: snippet,
    confidence: null,
  });
  for (const key of fieldNames) {
    const raw = wire[key] as WireField | null;
    draft[key] = raw ? field(raw.text, raw.page, raw.snippet) : emptyField();
  }
  draft.items = wire.items.map(
    (item) =>
      Object.fromEntries(
        itemNames.map((key) => [key, field(item[key], item.page, item.snippet)]),
      ) as unknown as DraftItem,
  );
  return draft;
}
export function packWireDraft(draft: AIDraft) {
  return {
    ...Object.fromEntries(
      fieldNames.map((key) => {
        const f = draft[key];
        return [
          key,
          f.rawValue !== null ? { text: f.rawValue, page: f.page, snippet: f.evidenceSnippet } : null,
        ];
      }),
    ),
    items: draft.items.map((item) => ({
      ...Object.fromEntries(itemNames.map((key) => [key, item[key].rawValue])),
      page: item.description.page,
      snippet: item.description.evidenceSnippet,
    })),
  };
}
