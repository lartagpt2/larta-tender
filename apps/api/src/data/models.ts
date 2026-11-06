/** PostgreSQL NUMERIC is represented as text: never install a floating point parser. */
export type Decimal = string;
export type UUID = string;
export interface LotItem {
  id: UUID;
  lotId: UUID;
  itemName: string;
  quantity: Decimal;
  unit: string;
  techRequirements: string | null;
}
export interface Supplier {
  id: UUID;
  legalName: string;
  taxId: string | null;
  country: string | null;
}
export interface Document {
  id: UUID;
  tenderId: UUID;
  supplierId: UUID | null;
  blobSha256: string;
  status: 'uploaded' | 'queued' | 'processing' | 'extracted' | 'needs_review' | 'confirmed' | 'failed';
}
export interface Offer {
  id: UUID;
  tenderId: UUID;
  supplierId: UUID;
  lotId: UUID;
  verificationStatus: 'needs_review' | 'confirmed' | 'rejected';
}
export interface OfferVersion {
  id: UUID;
  offerId: UUID;
  stageId: UUID | null;
  amount: Decimal | null;
  extraCost: Decimal | null;
  currency: string | null;
  isInitial: boolean;
  sourceDocumentId: UUID | null;
}
export interface TenderStage {
  id: UUID;
  tenderId: UUID;
  kind: 'clarification' | 'round' | 'negotiation';
  ordinal: number;
  label: string;
}
export interface AccreditationReport {
  id: UUID;
  tenderId: UUID;
  supplierId: UUID;
  documentId: UUID;
  status: 'passed' | 'conditional' | 'pending' | 'failed' | 'no_conclusion';
}
export interface AuditEvent {
  id: UUID;
  actorId: UUID;
  tenderId: UUID;
  entity: string | null;
  entityId: UUID | null;
  action: string;
}
export interface FieldDecision {
  id: UUID;
  documentId: UUID;
  fieldKey: string;
  value: string | null;
  sourceType: 'document' | 'phone' | 'email' | 'other';
  sourceNote: string;
  decidedBy: UUID;
}
export interface CostComponent {
  id: UUID;
  offerVersionId: UUID;
  amount: Decimal | null;
  currency: string | null;
  treatment: 'add' | 'included' | 'unknown';
  source: string;
}
