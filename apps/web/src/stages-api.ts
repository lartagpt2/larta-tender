export interface StageContext {
  baselines: { value: { offerId: string; versionId: string }; note: string; actorId: string; at: string }[];
  scope: { revision: number; title: string };
  stages: {
    id: string;
    ordinal: number;
    kind: string;
    label: string;
    comment: string;
    createdAt: string;
    actorId: string;
  }[];
  responses: {
    id: string;
    stageId: string;
    offerId: string;
    supplierId: string;
    status: string;
    versionId: string | null;
    note: string | null;
    actorId: string;
    createdAt: string;
  }[];
  contacts: { id: string; supplierId: string; email: string; verified: boolean; documentId: string | null }[];
  drafts: {
    id: string;
    stageId: string;
    supplierId: string;
    recipients: string[];
    superseded: boolean;
    subject: string;
    body: string;
    actorId: string;
    createdAt: string;
    revision: number;
  }[];
  reports: {
    id: string;
    supplierId: string;
    documentId: string;
    name: string;
    sha256: string;
    assessedAt: string;
    status: string;
    source: string;
    note: string;
    actorId: string;
    createdAt: string;
  }[];
  audit: {
    id: string;
    action: string;
    entity: string;
    entityId: string;
    actorId: string;
    at: string;
    revision: number;
  }[];
}
export const accreditationLabels: Record<string, string> = {
  passed: 'Аккредитован',
  conditional: 'Условно',
  pending: 'На проверке',
  failed: 'Не пройдена',
  no_conclusion: 'Нет заключения',
};
export const stageLabels: Record<string, string> = {
  clarification: 'Уточнение КП',
  round: 'Следующий этап',
  negotiation: 'Переторжка',
};
export const responseLabels: Record<string, string> = {
  received: 'Ответ получен',
  no_reply: 'Нет ответа',
  withdrawn: 'Предложение отозвано',
};
