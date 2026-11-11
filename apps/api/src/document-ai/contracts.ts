import {
  numeric,
  printedUnit,
  normalizedText,
  absent,
  fold,
  containsRaw,
  rowEvidence,
} from './normalization';
export { numeric } from './normalization';
import Ajv from 'ajv';
import Decimal from 'decimal.js';
const ExactDecimal = Decimal.clone({ precision: 60 });
export const schemaVersion = 'document-draft-v3',
  promptVersion = 'untrusted-compact-evidence-v3';
export interface Evidence {
  sourceDocumentId?: string;
  originalEvidenceSnippet?: string | null;
  evidenceMethod?: 'source_row_reanchored';
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
    originalEvidenceSnippet: { type: ['string', 'null'], maxLength: 2000 },
    evidenceMethod: { enum: ['source_row_reanchored'] },
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
    const source = pages.find((p) => p.page === value.page),
      name = key.split(':').at(-1)!;
    delete value.originalEvidenceSnippet;
    delete value.evidenceMethod;
    if (value.rawValue === null) {
      value.value = null;
      continue;
    }
    if (absent(value.rawValue)) {
      value.value = null;
      continue;
    }
    if (!source || !value.rawValue || !value.evidenceSnippet) {
      value.value = null;
      warnings.add('missing_evidence');
      continue;
    }
    const native = !vision || !!source.text.trim();
    if (
      native &&
      (!fold(source.text).includes(fold(value.evidenceSnippet)) ||
        !containsRaw(value.evidenceSnippet, value.rawValue))
    ) {
      const index = key.includes(':') ? Number(key.split(':')[0]) : -1;
      const replacement = index >= 0 ? rowEvidence(draft, index, name, value, source.text) : null;
      if (replacement) {
        value.originalEvidenceSnippet = value.evidenceSnippet;
        value.evidenceSnippet = replacement;
        value.evidenceMethod = 'source_row_reanchored';
        warnings.add('evidence_source_reanchored');
      } else {
        value.value = null;
        warnings.add(
          fold(source.text).includes(fold(value.evidenceSnippet))
            ? 'raw_value_not_in_evidence'
            : 'unverified_evidence',
        );
        continue;
      }
    }
    value.value = normalizedText(name, value.rawValue);
    if (!value.value) {
      value.value = null;
      continue;
    }
    if (name === 'taxId') {
      if (/(?:ИНН\s+покупателя|buyer\s+tax)/i.test(value.evidenceSnippet ?? '')) {
        value.value = null;
        warnings.add('tax_id_wrong_role');
        continue;
      }
      // Never parse an identifier as a number, guess omitted zeros or repair a checksum.
      if (/^\d+$/.test(value.value) && !/^\d{10}(?:\d{2})?$/.test(value.value)) {
        value.value = null;
        warnings.add('tax_id_invalid_format');
      } else if (!/^\d{10}(?:\d{2})?$/.test(value.value)) warnings.add('tax_id_requires_review');
    }
    if (['quantity', 'unitPrice', 'lineTotal', 'total', 'deliveryCost'].includes(name)) {
      value.value = numeric(value.rawValue, name === 'quantity' ? 'quantity' : 'money');
      if (value.value === null) warnings.add('invalid_number');
    }
    if (name === 'currency') {
      value.value = value.value?.toUpperCase() ?? null;
      if (!['RUB', 'USD', 'EUR', 'CNY'].includes(value.value ?? '')) warnings.add('unknown_currency');
    }
  }
  for (const item of draft.items) {
    if (item.unit.value !== null || item.quantity.value === null) continue;
    const unit = printedUnit(item.quantity.rawValue);
    if (unit) item.unit = { ...item.quantity, rawValue: unit, value: unit, confidence: null };
  }
  let sum = new ExactDecimal(0),
    complete = draft.items.length > 0;
  const currencies = new Set(
    [draft.currency.value, ...draft.items.map((i) => i.currency.value)].filter(Boolean),
  );
  if (currencies.size > 1) {
    warnings.add('mixed_currency');
    complete = false;
  }
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
    if (item.currency.value && draft.currency.value && item.currency.value !== draft.currency.value) {
      warnings.add('mixed_currency');
      complete = false;
    }
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
