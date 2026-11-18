import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
const uuid: SchemaObject = { type: 'string', format: 'uuid' };
const array = (items: SchemaObject): SchemaObject => ({ type: 'array', items });
const evidence: SchemaObject = {
  type: 'object',
  required: ['id', 'receipt_id', 'result_id', 'source_sha', 'field_path', 'excerpt', 'method'],
  properties: {
    id: uuid,
    receipt_id: uuid,
    result_id: uuid,
    source_sha: { type: 'string' },
    field_path: { type: 'string' },
    excerpt: { type: 'string' },
    method: { type: 'string' },
    page: { type: 'integer' },
    sheet: { type: 'string', nullable: true },
    cell_range: { type: 'string', nullable: true },
  },
};
export const organizationObservationSchema: SchemaObject = {
  type: 'object',
  required: [
    'id',
    'result_id',
    'receipt_id',
    'role',
    'identifiers',
    'evidence_by_field',
    'extraction_method',
    'review_state',
    'warnings',
  ],
  properties: {
    id: uuid,
    result_id: uuid,
    receipt_id: uuid,
    local_key: { type: 'string' },
    role: { type: 'string', enum: ['supplier', 'buyer', 'manufacturer', 'carrier', 'other', 'unknown'] },
    name: { type: 'string', nullable: true },
    legal_name: { type: 'string', nullable: true },
    country: { type: 'string', nullable: true },
    address: { type: 'string', nullable: true },
    identifiers: array({
      type: 'object',
      required: ['scheme', 'raw_value', 'normalized_value', 'valid', 'validator_version'],
      properties: {
        scheme: { type: 'string' },
        raw_value: { type: 'string' },
        normalized_value: { type: 'string', nullable: true },
        valid: { type: 'boolean' },
        validator_version: { type: 'string' },
      },
    }),
    emails: array({ type: 'string' }),
    contacts: array({ type: 'string' }),
    evidence_by_field: {
      type: 'object',
      additionalProperties: uuid,
      description:
        'One evidence UUID per extracted field/array element; derived normalization retains raw-value proof',
    },
    extraction_method: { type: 'string', enum: ['native_labeled', 'localai', 'test_mock'] },
    review_state: { type: 'string', enum: ['proposed', 'needs_review'] },
    warnings: array({ type: 'string' }),
    associationProposals: array({ type: 'object', additionalProperties: true }),
  },
};
const company: SchemaObject = {
  type: 'object',
  required: [
    'preliminaryCompanyId',
    'name',
    'requisites',
    'supplierRole',
    'observationCount',
    'receiptCount',
    'reviewState',
    'documents',
    'matchProposals',
    'evidenceReferences',
    'conflicts',
    'confirmedSupplierId',
  ],
  properties: {
    preliminaryCompanyId: uuid,
    name: { type: 'string', nullable: true },
    stateRevision: { type: 'integer' },
    confirmedSupplierId: { ...uuid, nullable: true, description: 'Always null in TASK-011C' },
    requisites: {
      type: 'object',
      properties: {
        names: array({ type: 'string' }),
        identifiers: array({ type: 'object', additionalProperties: true }),
        roles: array({ type: 'string' }),
        emails: array({ type: 'string' }),
        contacts: array({ type: 'string' }),
        addresses: array({ type: 'string' }),
        countries: array({ type: 'string' }),
        conflicts: array({ type: 'string' }),
      },
    },
    supplierRole: { type: 'boolean' },
    observationCount: { type: 'integer' },
    receiptCount: { type: 'integer' },
    reviewState: {
      type: 'string',
      enum: ['proposed', 'needs_review', 'confirmed', 'rejected', 'superseded'],
    },
    documents: array({ type: 'object', additionalProperties: true }),
    associationProposals: array({ type: 'object', additionalProperties: true }),
    matchProposals: array({ type: 'object', additionalProperties: true }),
    evidenceReferences: array(uuid),
    conflicts: array({ type: 'string' }),
    existingParticipantCandidates: array(uuid),
  },
};
export const companyListSchema: SchemaObject = {
  type: 'object',
  required: ['contractVersion', 'items', 'nextCursor', 'unassignedReceipts'],
  properties: {
    contractVersion: { type: 'string', enum: ['intake-organizations-v1'] },
    items: array(company),
    nextCursor: { ...uuid, nullable: true },
    unassignedReceipts: array({
      type: 'object',
      required: ['receiptId', 'name'],
      properties: { receiptId: uuid, name: { type: 'string' } },
    }),
  },
};
export const companyDetailSchema: SchemaObject = {
  allOf: [
    company,
    {
      type: 'object',
      properties: {
        contractVersion: { type: 'string', enum: ['intake-organizations-v1'] },
        currentRevision: { type: 'object', additionalProperties: true },
        revisions: array({ type: 'object', additionalProperties: true }),
        observations: array(organizationObservationSchema),
        evidence: array(evidence),
      },
    },
  ],
};
export const extendedReceiptSchema: SchemaObject = {
  type: 'object',
  required: [
    'revisions',
    'evidence',
    'organizationsContractVersion',
    'organizations',
    'organizationResults',
    'matchProposals',
  ],
  properties: {
    revisions: array({ type: 'object', additionalProperties: true }),
    evidence: array(evidence),
    organizationsContractVersion: { type: 'string', enum: ['intake-organizations-v1'] },
    organizations: array(organizationObservationSchema),
    organizationResults: array({
      type: 'object',
      properties: {
        id: uuid,
        schemaVersion: { type: 'string' },
        policyVersion: { type: 'string' },
        extractionMethod: { type: 'string' },
        model: { type: 'boolean', enum: [false] },
      },
    }),
    matchProposals: array({ type: 'object', additionalProperties: true }),
  },
};
