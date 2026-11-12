import { api, type Tender } from './tender-api';
export type LifecycleState = 'active' | 'archived' | 'trash';
export interface LifecyclePage {
  items: (Tender & { state: LifecycleState; classification: string })[];
  total: number;
  page: number;
  pageSize: number;
}
export interface LifecyclePreview {
  id: string;
  title: string;
  state: LifecycleState;
  classification: string;
  previewHash: string;
  revision: number;
  dependencyRevision: string;
  contentRevision: string;
  classified_content_revision: string | null;
  classified_ocr_hash: string | null;
  ocrHash: string;
  counts: Record<string, number>;
  sharedBlobs: number;
  held: boolean;
  busy: boolean;
  dbActive: number;
  ocr: { jobs: { id: string; status: string; path: string }[]; active: number };
  allowed: Record<string, boolean>;
}
export const lifecycleLabels: Record<string, string> = {
  archive: 'В архив',
  restore: 'Восстановить в активные',
  trash: 'В корзину',
  classify_synthetic: 'Подтвердить синтетические данные',
  classify_working: 'Защитить как рабочий тендер',
};
export function confirmationValid(
  p: LifecyclePreview,
  title: string,
  id: string,
  reason: string,
  action: string,
  evidence: string,
) {
  return (
    p.title === title &&
    p.id === id &&
    reason.trim().length >= 10 &&
    !!p.allowed[action] &&
    (action !== 'classify_synthetic' || evidence.trim().length >= 10)
  );
}
export function loadLifecyclePage(state: LifecycleState, page: number, search: string) {
  return api<LifecyclePage>(
    `/tenders/lifecycle/page?${new URLSearchParams({ state, page: String(page), pageSize: '25', search })}`,
  );
}
export const classificationLabels: Record<string, string> = {
  unclassified: 'Не классифицирован',
  synthetic: 'Подтверждённая синтетика',
  working: 'Рабочие данные',
};
export const dependencyLabels: Record<string, string> = {
  document: 'Документы',
  document_receipt: 'Квитанции загрузок',
  document_relation: 'Связи документов',
  offer_package: 'Пакеты КП',
  offer: 'Предложения',
  offer_version: 'Все версии КП',
  offer_item: 'Позиции КП',
  lot: 'Лоты',
  lot_item: 'Позиции ТЗ',
  specification_item: 'Состав ТЗ',
  tender_supplier: 'Контрагенты',
  tender_member: 'Участники',
  tender_stage: 'Коммерческие этапы',
  upload_batch: 'Пакеты загрузок',
  extraction_run: 'Запуски распознавания',
  extracted_field: 'Извлечённые поля',
  evidence_reference: 'Источники распознанных данных',
  field_decision: 'Поступления и решения по полям',
  cost_component: 'Дополнительные затраты',
  accreditation_report: 'Отчёты аккредитации',
  stage_response: 'Ответы на этапах',
  contact: 'Контакты',
  draft_message: 'Черновики писем',
  calculation_run: 'Расчёты',
  comparison: 'Сравнения',
  comparison_offer: 'Предложения в сравнениях',
  audit_event: 'Аудит',
  lifecycle_event: 'История состояний',
  tender_lifecycle: 'Состояние тендера',
  tender_capability: 'Отдельные права',
};
