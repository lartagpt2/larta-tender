import { api } from './tender-api';
import type { CommercialFields, VerifiedItem } from './verification-api';
export interface IntakeContext {
  receiptId: string;
  resultId: string;
  companyRevisionId: string;
  classificationRevisionId: string;
  associationRevisionId: string;
  contextToken: string;
  draftId: string;
  operationKey: string;
}
export interface ServerIntakeContext extends Omit<IntakeContext, 'draftId' | 'operationKey'> {
  supplierId: string;
  documentId: string;
  legacyReceiptId: string;
  companyId: string;
  tenderId: string;
}
export interface ReviewCompany {
  preliminaryCompanyId: string;
  stateRevision: number;
  confirmedSupplierId: string | null;
  review_state: string;
  requisites: {
    names: string[];
    countries: string[];
    addresses: string[];
    emails: string[];
    identifiers: { scheme: string; raw_value: string; normalized_value: string | null; valid: boolean }[];
    roles: string[];
    conflicts: string[];
  };
}
export interface ReceiptAssociation {
  id: string;
  companyId: string | null;
  targetReceiptId: string | null;
  kind: string;
  state: string;
  revision: number;
  companyReview: string | null;
  supplierId: string | null;
}
export interface ReviewReceipt {
  receiptId: string;
  originalId: string;
  name: string;
  mime: string;
  bytes: string;
  sha256: string;
  stageId: string | null;
  processingState: string;
  processingStage: string;
  attempts: number;
  coverage: Record<string, boolean>;
  safeError: string | null;
  updatedAt: string;
  runRevision: number;
  initialClassification: string | null;
  effectiveClassification: string | null;
  classificationReview: string | null;
  classificationRevision: number | null;
  associations: ReceiptAssociation[];
  legacyDocumentId: string | null;
  legacyReceiptId: string | null;
  commercialReview: string;
}
export interface ReviewWorkspace {
  canWrite: boolean;
  page: number;
  pageSize: number;
  total: number;
  allCount: number;
  items: ReviewReceipt[];
  companies: { items: ReviewCompany[] };
  warnings: string[];
}
export interface ReviewDraft {
  id: string;
  revision: number;
  context_token: string;
  form: { fields: CommercialFields; lotId: string; items: VerifiedItem[] };
}
export interface ReviewEvidence {
  id: string;
  result_id: string;
  field_path: string;
  page: number | null;
  sheet: string | null;
  cell_range: string | null;
  excerpt: string;
  method: string;
}
export interface CompanyDetail extends ReviewCompany {
  revisions: {
    id: string;
    revision: number;
    source: string;
    review_state: string;
    actor_id: string;
    created_at: string;
    requisites: ReviewCompany['requisites'];
  }[];
  observations: { id: string; receipt_id: string; role: string; legal_name: string | null }[];
  evidence: ReviewEvidence[];
  source_observations: string[];
  conflicts: string[];
}
export interface DraftFieldSource {
  id: string;
  draft_id: string;
  field_path: string;
  evidence_id: string | null;
  manual_decision_id: string | null;
  value_hash: string;
  manual_note: string | null;
  manual_actor_id: string | null;
  manual_created_at: string | null;
}
export interface ReceiptDetail {
  receipt: ReviewReceipt;
  observationDecisions: {
    id: string;
    observation_id: string;
    revision: number;
    action: string;
    actor_id: string;
    note: string;
    created_at: string;
  }[];
  draftFields: DraftFieldSource[];
  processing: {
    runs: { id: string; status: string; stage: string; attempt_count: number }[];
    events: {
      id: string;
      code: string;
      stage: string;
      to_state: string;
      created_at: string;
      worker_id: string | null;
      actor_id: string | null;
    }[];
  };
  revisions: {
    id: string;
    revision: number;
    type: string;
    reviewState: string;
    source: string;
    reason: string;
    actorId: string;
    createdAt: string;
  }[];
  organizations: {
    id: string;
    role: string;
    name: string | null;
    legal_name: string | null;
    country: string | null;
  }[];
  evidence: ReviewEvidence[];
  drafts: ReviewDraft[];
  decisions: { id: string; action: string; reason: string; actor_id: string; created_at: string }[];
  commercial: {
    schema_version: string;
    method: string;
    model: false;
    output: Record<string, { value: string; evidenceId: string }>;
  } | null;
  intakeContext: ServerIntakeContext | null;
  impact: { versions: { versionId: string }[]; previewHash: string };
}
export function verificationIntakeContext(
  context: ServerIntakeContext,
  draftId: string,
  operationKey = crypto.randomUUID(),
): IntakeContext {
  return {
    receiptId: context.receiptId,
    resultId: context.resultId,
    companyRevisionId: context.companyRevisionId,
    classificationRevisionId: context.classificationRevisionId,
    associationRevisionId: context.associationRevisionId,
    contextToken: context.contextToken,
    draftId,
    operationKey,
  };
}
export const reviewDetails = (tender: string, receipt: string) =>
  api<ReceiptDetail>(`/tenders/${tender}/intake/receipts/${receipt}/review`);
export const typeLabels: Record<string, string> = {
  offer: 'КП',
  specification: 'Техническое задание',
  quality_certificate: 'Паспорт качества',
  supporting: 'Сопроводительный документ',
  unknown: 'Не определён',
};
export const reviewLabels: Record<string, string> = {
  proposed: 'Предложено',
  needs_review: 'Требует проверки',
  confirmed: 'Подтверждено',
  rejected: 'Отклонено',
  deferred: 'Отложено',
  revoked: 'Отозвано',
  stale: 'Контекст изменён',
  not_transferred: 'Не перенесено',
  confirm: 'Подтверждено',
  draft: 'Черновик',
};
export const processingLabels: Record<string, string> = {
  queued: 'В очереди',
  running: 'Обрабатывается',
  retry_wait: 'Ожидает повторной попытки',
  completed: 'Обработка завершена',
  failed: 'Ошибка обработки',
  blocked: 'Обработка заблокирована',
  unsupported: 'Формат не поддерживается',
};
