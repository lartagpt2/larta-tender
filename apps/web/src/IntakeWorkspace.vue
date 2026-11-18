<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { api } from './tender-api';
import {
  emptyFields,
  normalizedFields,
  type VerificationContext,
  type VerifiedItem,
} from './verification-api';
import CommercialFieldsEditor from './CommercialFieldsEditor.vue';
import {
  reviewDetails,
  type CompanyDetail,
  type ReviewCompany,
  type ReviewReceipt,
  type ReviewWorkspace,
  typeLabels,
  reviewLabels,
  processingLabels,
} from './intake-review-api';
const route = useRoute(),
  router = useRouter(),
  client = useQueryClient(),
  id = computed(() => String(route.params.id));
const sort = ref('received_asc');
const filter = ref('all'),
  page = ref(1),
  pageSize = ref(5),
  selectedReceipt = ref(String(route.query.receiptId ?? ''));
const query = useQuery({
  queryKey: computed(() => ['intake-review', id.value, filter.value, page.value, pageSize.value, sort.value]),
  queryFn: () =>
    api<ReviewWorkspace>(
      `/tenders/${id.value}/intake/workspace?filter=${filter.value}&page=${page.value}&pageSize=${pageSize.value}&sort=${sort.value}`,
    ),
  refetchInterval: (q) =>
    q.state.data?.items.some((r) => ['queued', 'running', 'retry_wait'].includes(r.processingState))
      ? 1500
      : false,
});
const detail = useQuery({
  queryKey: computed(() => ['intake-review-receipt', id.value, selectedReceipt.value]),
  queryFn: () => reviewDetails(id.value, selectedReceipt.value),
  enabled: computed(() => !!selectedReceipt.value),
});
const context = useQuery({
  queryKey: computed(() => ['intake-legacy-context', id.value]),
  queryFn: () => api<VerificationContext>(`/tenders/${id.value}/verification`),
});
const row = computed(
  () =>
    detail.data.value?.receipt ?? query.data.value?.items.find((r) => r.receiptId === selectedReceipt.value),
);
const canWrite = computed(() => query.data.value?.canWrite === true),
  busy = ref(false),
  error = ref(''),
  message = ref('');
const files = ref<File[]>([]),
  uploadKey = ref(crypto.randomUUID()),
  fileInput = ref<HTMLInputElement>();
const companyId = ref(''),
  companyNote = ref(''),
  companyField = ref('legalName'),
  companyValue = ref(''),
  companyRegistrationOverride = ref(''),
  existingSupplier = ref('');
const companyDetail = useQuery({
  queryKey: computed(() => ['intake-company-detail', id.value, companyId.value]),
  queryFn: () => api<CompanyDetail>('/tenders/' + id.value + '/intake/companies/' + companyId.value),
  enabled: computed(() => !!companyId.value),
});
const observationNote = ref('');
function observationRevision(observation: string) {
  return (
    detail.data.value?.observationDecisions.filter((d) => d.observation_id === observation).at(-1)
      ?.revision ?? 0
  );
}
async function rejectObservation(observation: string) {
  await act(
    '/tenders/' +
      id.value +
      '/intake/receipts/' +
      selectedReceipt.value +
      '/observations/' +
      observation +
      '/decisions',
    {
      action: 'reject',
      expectedRevision: observationRevision(observation),
      note: observationNote.value,
      ...impactAck(),
    },
  );
}
const company = computed(() =>
  query.data.value?.companies.items.find((c) => c.preliminaryCompanyId === companyId.value),
);
const classification = ref('unknown'),
  classificationNote = ref(''),
  associationNote = ref(''),
  associationTargets = ref<Record<string, string>>({});
const acknowledge = ref(false),
  draftFields = ref(emptyFields()),
  draftItems = ref<VerifiedItem[]>([]),
  lotId = ref(''),
  draftNote = ref(''),
  selectedFields = ref<string[]>([]),
  draftSavedId = ref('');
const mappedItems = computed(() => context.data.value?.lotItems[lotId.value] ?? []);
watch([filter, sort], () => (page.value = 1));
watch(
  () => route.query.receiptId,
  (value) => (selectedReceipt.value = String(value ?? '')),
);
watch(selectedReceipt, () => {
  classificationNote.value = '';
  associationNote.value = '';
  acknowledge.value = false;
  draftSavedId.value = '';
  selectedFields.value = [];
  draftFields.value = emptyFields();
  draftItems.value = [];
});
watch(
  () => detail.data.value,
  () => {
    classification.value =
      row.value?.effectiveClassification ?? detail.data.value?.revisions.at(-1)?.type ?? 'unknown';
  },
);
function currentCompanyValue(value: ReviewCompany | undefined) {
  if (!value) return '';
  const r = value.requisites;
  return companyField.value === 'legalName'
    ? (r.names[0] ?? '')
    : companyField.value === 'country'
      ? (r.countries[0] ?? '')
      : companyField.value === 'address'
        ? (r.addresses[0] ?? '')
        : companyField.value === 'email'
          ? (r.emails[0] ?? '')
          : (r.identifiers.find((i) => i.valid)?.raw_value ?? '');
}
watch([companyId, companyField], () => (companyValue.value = currentCompanyValue(company.value)));
async function refresh() {
  await Promise.all([
    client.invalidateQueries({ queryKey: ['intake-review', id.value] }),
    client.invalidateQueries({ queryKey: ['intake-company-detail', id.value] }),
    client.invalidateQueries({ queryKey: ['intake-review-receipt', id.value] }),
    client.invalidateQueries({ queryKey: ['intake-legacy-context', id.value] }),
    client.invalidateQueries({ queryKey: ['offers', id.value] }),
    client.invalidateQueries({ queryKey: ['verification', id.value] }),
    client.invalidateQueries({ queryKey: ['comparison', id.value] }),
  ]);
}
const pendingKeys = new Map<string, string>();
async function act(path: string, body: unknown) {
  if (busy.value || !canWrite.value) return;
  busy.value = true;
  error.value = '';
  message.value = '';
  const fingerprint = path + JSON.stringify(body),
    key = pendingKeys.get(fingerprint) ?? crypto.randomUUID();
  pendingKeys.set(fingerprint, key);
  try {
    const reply = await api<Record<string, unknown>>(path, {
      method: 'POST',
      headers: { 'idempotency-key': key },
      body: JSON.stringify(body),
    });
    pendingKeys.delete(fingerprint);
    message.value = 'Решение сохранено. Остальные статусы подтверждаются отдельно.';
    await refresh();
    return reply;
  } catch (e) {
    error.value = (e as Error).message;
    await refresh();
  } finally {
    busy.value = false;
  }
}
async function upload() {
  if (!files.value.length || !canWrite.value) return;
  busy.value = true;
  error.value = '';
  const form = new FormData();
  for (const file of files.value) form.append('files', file);
  try {
    const reply = await api<{ outcomes: { name: string; status: string; code?: string }[] }>(
      `/tenders/${id.value}/intake/batches`,
      { method: 'POST', headers: { 'idempotency-key': uploadKey.value }, body: form },
    );
    message.value = reply.outcomes
      .map((o) => o.name + ': ' + (o.status === 'accepted' ? 'принят' : (o.code ?? 'отказ')))
      .join('; ');
    files.value = [];
    if (fileInput.value) fileInput.value.value = '';
    uploadKey.value = crypto.randomUUID();
    page.value = 1;
    filter.value = 'all';
    await refresh();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
function chooseFiles(event: Event) {
  files.value = [...((event.target as HTMLInputElement).files ?? [])];
  uploadKey.value = crypto.randomUUID();
}
async function selectReceipt(value: ReviewReceipt) {
  selectedReceipt.value = value.receiptId;
  await router.replace({ query: { ...route.query, receiptId: value.receiptId } });
}
function selectCompany(value: ReviewCompany) {
  companyRegistrationOverride.value = '';
  companyId.value = value.preliminaryCompanyId;
  companyNote.value = '';
  existingSupplier.value = '';
  companyValue.value = currentCompanyValue(value);
}
async function companyAction(action: string) {
  if (!company.value || !companyNote.value.trim()) return;
  const body = {
    action,
    expectedRevision: company.value.stateRevision,
    note: companyNote.value,
    ...(action === 'edit'
      ? {
          changes: {
            [companyField.value]: companyValue.value,
            ...(companyField.value === 'country' && companyRegistrationOverride.value.trim()
              ? { registrationNumber: companyRegistrationOverride.value.trim() }
              : {}),
          },
        }
      : {}),
    ...(action === 'confirm' ? { createFromRevision: true } : {}),
    ...(action === 'choose_existing' ? { existingSupplierId: existingSupplier.value } : {}),
  };
  await act(`/tenders/${id.value}/intake/companies/${companyId.value}/decisions`, body);
}
function impactAck() {
  return detail.data.value?.impact.versions.length
    ? { impactPreviewHash: detail.data.value.impact.previewHash, acknowledgeImpact: acknowledge.value }
    : {};
}
async function classify(action: string) {
  const latest = detail.data.value?.revisions.at(-1);
  if (!latest || !classificationNote.value.trim()) return;
  await act(`/tenders/${id.value}/intake/receipts/${selectedReceipt.value}/classification-decisions`, {
    action,
    expectedRevision: latest.revision,
    type: classification.value,
    note: classificationNote.value,
    ...impactAck(),
  });
}
async function associate(a: ReviewReceipt['associations'][number], action: string) {
  if (!associationNote.value.trim()) return;
  await act(`/tenders/${id.value}/intake/receipts/${selectedReceipt.value}/associations/${a.id}/decisions`, {
    action,
    expectedRevision: a.revision,
    note: associationNote.value,
    ...(action === 'change' && a.companyId ? { companyId: associationTargets.value[a.id] } : {}),
    ...impactAck(),
  });
}
async function transfer() {
  const current = detail.data.value?.intakeContext;
  if (!current || !draftNote.value.trim() || !lotId.value) return;
  const reply = await act(`/tenders/${id.value}/intake/receipts/${selectedReceipt.value}/transfer-draft`, {
    expectedRevision: detail.data.value?.drafts.at(-1)?.revision ?? 0,
    contextToken: current.contextToken,
    lotId: lotId.value,
    selectedFields: selectedFields.value,
    form: normalizedFields(draftFields.value),
    items: draftItems.value,
    note: draftNote.value,
  });
  if (reply) draftSavedId.value = String(reply.draftId);
}
function reviewLink() {
  const current = detail.data.value?.intakeContext,
    draft =
      detail.data.value?.drafts.find((d) => d.id === draftSavedId.value) ?? detail.data.value?.drafts.at(-1);
  return {
    path: '/review',
    query: {
      tenderId: id.value,
      documentId: current?.documentId,
      receiptId: current?.legacyReceiptId,
      supplierId: current?.supplierId,
      lotId: draft?.form.lotId,
      intakeReceiptId: selectedReceipt.value,
      intakeDraftId: draft?.id,
    },
  };
}
</script>
<template>
  <section class="page-heading">
    <div>
      <p class="eyebrow">LARTA TENDER / ПРОВЕРКА ДОКУМЕНТОВ</p>
      <h1>Единая проверка документов</h1>
      <p>Компания, тип, принадлежность и коммерческие данные подтверждаются независимо.</p>
    </div>
    <RouterLink :to="`/tenders/${id}`" class="secondary-action">К карточке тендера</RouterLink>
  </section>
  <p v-if="query.isPending.value" role="status">Загружаем документы…</p>
  <p v-if="query.isError.value" role="alert">
    {{ query.error.value?.message }} <button @click="query.refetch()">Повторить загрузку</button>
  </p>
  <p v-if="error" role="alert">{{ error }} <button @click="refresh">Обновить состояние</button></p>
  <p v-if="message" role="status">{{ message }}</p>
  <p v-if="query.data.value && !canWrite">
    Доступен только просмотр. Изменения запрещены правами или состоянием тендера.
  </p>
  <section class="content-card" aria-label="Единая загрузка">
    <h2>Загрузить документы</h2>
    <p>
      PDF, TXT, XLSX, EML. До 10 файлов, 20 MiB на файл, 40 MiB на пакет. Тип и поставщик до загрузки не
      требуются.
    </p>
    <input
      ref="fileInput"
      type="file"
      multiple
      accept=".pdf,.txt,.xlsx,.eml"
      aria-label="Смешанный комплект документов"
      :disabled="!canWrite || busy"
      @change="chooseFiles"
    /><button class="primary-action" :disabled="!canWrite || busy || !files.length" @click="upload">
      Загрузить документы
    </button>
  </section>
  <section class="content-card" aria-label="Предварительные компании">
    <h2>Компании</h2>
    <p v-if="!query.data.value?.companies.items.length">Предварительных компаний пока нет.</p>
    <ul>
      <li v-for="c in query.data.value?.companies.items" :key="c.preliminaryCompanyId">
        <button @click="selectCompany(c)">{{ c.requisites.names[0] ?? 'Название не определено' }}</button> ·
        {{ reviewLabels[c.review_state] ?? c.review_state }} · revision {{ c.stateRevision }}
        <span v-if="c.confirmedSupplierId">· Supplier {{ c.confirmedSupplierId }}</span>
      </li>
    </ul>
    <fieldset v-if="company" :disabled="!canWrite || busy">
      <legend>Проверка компании: {{ company.requisites.names[0] }}</legend>
      <dl>
        <dt>Страна</dt>
        <dd>{{ company.requisites.countries.join(', ') || 'Не установлена' }}</dd>
        <dt>Идентификаторы</dt>
        <dd
          v-for="identifier in company.requisites.identifiers"
          :key="identifier.scheme + identifier.raw_value"
        >
          {{ identifier.scheme }}: {{ identifier.raw_value }} ·
          {{ identifier.valid ? 'Формат проверен' : 'Нужна проверка' }}
        </dd>
        <dt>Адрес</dt>
        <dd>{{ company.requisites.addresses.join('; ') || 'Не установлен' }}</dd>
        <dt>Контакты</dt>
        <dd>
          {{ company.requisites.emails.join('; ') || 'Не установлены' }}. Подтверждение компании не
          подтверждает контакт.
        </dd>
      </dl>
      <label
        >Изменяемое поле<select v-model="companyField" aria-label="Изменяемое поле">
          <option value="legalName">Название</option>
          <option value="country">Страна</option>
          <option value="registrationNumber">Регистрационный номер</option>
          <option value="address">Адрес</option>
          <option value="email">Email-кандидат</option>
        </select></label
      ><label>Исправленное значение<input v-model="companyValue" /></label
      ><label v-if="companyField === 'country'"
        >Регистрационный номер для новой страны (при необходимости)<input
          v-model="companyRegistrationOverride" /></label
      ><label>Основание решения по компании<textarea v-model="companyNote" /></label>
      <button :disabled="!companyNote.trim()" @click="companyAction('edit')">Сохранить исправление</button
      ><button :disabled="!companyNote.trim()" @click="companyAction('confirm')">
        Подтвердить новую компанию</button
      ><label
        >Уже существующий участник<select v-model="existingSupplier" aria-label="Уже существующий участник">
          <option value="">Выберите участника</option>
          <option v-for="s in context.data.value?.suppliers" :key="s.id" :value="s.id">{{ s.name }}</option>
        </select></label
      ><button :disabled="!existingSupplier || !companyNote.trim()" @click="companyAction('choose_existing')">
        Выбрать существующего поставщика</button
      ><button :disabled="!companyNote.trim()" @click="companyAction('reject')">Отклонить компанию</button
      ><button :disabled="!companyNote.trim()" @click="companyAction('defer')">
        Отложить решение по компании
      </button>
    </fieldset>
  </section>
  <section v-if="companyId" class="content-card" aria-label="История компании">
    <h2>История и источники компании</h2>
    <p v-if="companyDetail.isPending.value" role="status">Загружаем компанию…</p>
    <p v-if="companyDetail.isError.value" role="alert">
      {{ companyDetail.error.value?.message }} <button @click="companyDetail.refetch()">Повторить</button>
    </p>
    <template v-if="companyDetail.data.value">
      <p>
        Роли: {{ companyDetail.data.value.requisites.roles.join(', ') }}. Конфликты:
        {{ companyDetail.data.value.conflicts.join('; ') || 'Не обнаружены' }}
      </p>
      <ul>
        <li v-for="o in companyDetail.data.value.observations" :key="o.id">
          <RouterLink :to="{ query: { receiptId: o.receipt_id } }"
            >Источник: {{ o.legal_name || 'Организация' }}</RouterLink
          >
          · {{ o.role }} · {{ o.id }}
        </li>
      </ul>
      <details>
        <summary>Ревизии компании</summary>
        <ol>
          <li v-for="r in companyDetail.data.value.revisions" :key="r.id">
            {{ r.revision }} · {{ r.source }} · {{ reviewLabels[r.review_state] }} · {{ r.actor_id }} ·
            {{ r.created_at }}
            <pre>{{ r.requisites }}</pre>
          </li>
        </ol>
      </details>
      <details>
        <summary>Доказательства компании</summary>
        <ul>
          <li v-for="e in companyDetail.data.value.evidence" :key="e.id">
            {{ e.field_path }} · {{ e.method }} · {{ e.page ?? e.sheet ?? 'Расположение не указано' }}
            <blockquote>{{ e.excerpt }}</blockquote>
            <small>{{ e.id }} · {{ e.result_id }}</small>
          </li>
        </ul>
      </details>
    </template>
  </section>
  <section class="content-card" aria-label="Реестр поступлений">
    <h2>Документы</h2>
    <label
      >Сортировка<select v-model="sort" aria-label="Сортировка">
        <option value="received_asc">Сначала ранние поступления</option>
        <option value="received_desc">Сначала новые поступления</option>
        <option value="name">По имени</option>
      </select></label
    >
    <label
      >Раздел<select v-model="filter" aria-label="Раздел">
        <option value="all">Все документы</option>
        <option value="preliminary">Предварительные компании</option>
        <option value="unassigned">Без установленного поставщика</option>
        <option value="review">Требуют проверки</option>
        <option value="errors">Ошибки и блокировки</option>
      </select></label
    ><label
      >На странице<select v-model.number="pageSize" aria-label="На странице">
        <option :value="5">5</option>
        <option :value="10">10</option>
        <option :value="25">25</option>
      </select></label
    >
    <p>Найдено: {{ query.data.value?.total ?? 0 }} / {{ query.data.value?.allCount ?? 0 }}</p>
    <p v-if="query.data.value && !query.data.value.items.length">В этом разделе пока нет документов.</p>
    <div class="intake-table">
      <table>
        <thead>
          <tr>
            <th>Документ / оригинал / поступление</th>
            <th>Обработка</th>
            <th>Тип</th>
            <th>Компания и связь</th>
            <th>Коммерческие данные</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in query.data.value?.items" :key="r.receiptId">
            <td>
              <button @click="selectReceipt(r)">{{ r.name }}</button
              ><small
                >Original: {{ r.originalId }}<br />Receipt: {{ r.receiptId }}<br />{{ r.mime }} ·
                {{ r.bytes }} bytes<br />SHA-256: {{ r.sha256 }}<br />Stage: {{ r.stageId ?? 'Не задан'
                }}<br />Legacy document: {{ r.legacyDocumentId ?? 'Нет' }}<br />Legacy receipt:
                {{ r.legacyReceiptId ?? 'Нет' }}</small
              >
            </td>
            <td>
              {{ processingLabels[r.processingState] ?? r.processingState }}<br />Этап:
              {{ r.processingStage }} · попытки: {{ r.attempts }}<br /><span
                v-if="r.safeError"
                class="form-error"
                >{{ r.safeError }}</span
              ><small
                >Coverage: {{ r.coverage }}<br />Run revision {{ r.runRevision }}<br />{{
                  r.updatedAt
                }}</small
              >
            </td>
            <td>
              Исходный: {{ typeLabels[r.initialClassification ?? 'unknown'] }}<br />Текущий:
              {{ typeLabels[r.effectiveClassification ?? 'unknown'] }}<br />{{
                reviewLabels[r.classificationReview ?? 'needs_review']
              }}
            </td>
            <td>
              <div v-for="a in r.associations" :key="a.id">
                {{ a.kind }} · {{ reviewLabels[a.state] ?? a.state }}<br />Компания:
                {{ reviewLabels[a.companyReview ?? 'needs_review'] ?? 'Без компании' }}
              </div>
              <span v-if="!r.associations.length">Поставщик не установлен</span>
            </td>
            <td>{{ reviewLabels[r.commercialReview] ?? r.commercialReview }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <button :disabled="page <= 1" @click="page--">Предыдущая страница</button><span>Страница {{ page }}</span
    ><button :disabled="page * pageSize >= (query.data.value?.total ?? 0)" @click="page++">
      Следующая страница
    </button>
  </section>
  <section v-if="selectedReceipt" class="content-card" aria-label="Карточка документа">
    <h2>Карточка документа: {{ row?.name ?? selectedReceipt }}</h2>
    <p v-if="detail.isPending.value" role="status">Загружаем историю и доказательства…</p>
    <p v-if="detail.isError.value" role="alert">
      {{ detail.error.value?.message }} <button @click="detail.refetch()">Обновить карточку документа</button>
    </p>
    <template v-if="detail.data.value"
      ><a v-if="row" :href="`/api/tenders/${id}/intake/originals/${row.originalId}/download`"
        >Скачать неизменяемый оригинал</a
      >
      <fieldset :disabled="!canWrite || busy">
        <legend>Независимая проверка типа</legend>
        <label
          >Тип документа<select v-model="classification" aria-label="Тип документа">
            <option v-for="(label, type) in typeLabels" :key="type" :value="type">{{ label }}</option>
          </select></label
        ><label>Основание решения по типу<textarea v-model="classificationNote" /></label
        ><button :disabled="!classificationNote.trim()" @click="classify('confirm')">Подтвердить тип</button
        ><button :disabled="!classificationNote.trim()" @click="classify('change')">Изменить тип</button
        ><button :disabled="!classificationNote.trim()" @click="classify('reject')">Отклонить тип</button>
      </fieldset>
      <div v-if="detail.data.value.impact.versions.length">
        <h3>Затрагиваемые коммерческие версии</h3>
        <ul>
          <li v-for="version in detail.data.value.impact.versions" :key="version.versionId">
            {{ version.versionId }}
          </li>
        </ul>
        <label
          ><input v-model="acknowledge" type="checkbox" />Я понимаю, что изменение типа или связи может
          исключить эти версии из нового рейтинга</label
        >
      </div>
      <fieldset :disabled="!canWrite || busy">
        <legend>Независимая проверка принадлежности</legend>
        <p>Подтверждение типа не подтверждает связь. MIME-вложение само по себе не доказывает поставщика.</p>
        <label>Основание решения по связи<textarea v-model="associationNote" /></label>
        <div v-for="a in row?.associations" :key="a.id">
          <p>{{ a.kind }} → {{ a.companyId ?? a.targetReceiptId }} · {{ reviewLabels[a.state] }}</p>
          <button :disabled="!associationNote.trim()" @click="associate(a, 'confirm')">
            Подтвердить связь {{ a.kind }}</button
          ><button :disabled="!associationNote.trim()" @click="associate(a, 'reject')">
            Отклонить связь {{ a.kind }}</button
          ><button :disabled="!associationNote.trim()" @click="associate(a, 'defer')">
            Отложить связь {{ a.kind }}</button
          ><template v-if="a.companyId"
            ><select v-model="associationTargets[a.id]" :aria-label="`Новая компания для ${a.kind}`">
              <option value="">Выберите подтверждённую компанию</option>
              <option
                v-for="c in query.data.value?.companies.items.filter((c) => c.confirmedSupplierId)"
                :key="c.preliminaryCompanyId"
                :value="c.preliminaryCompanyId"
              >
                {{ c.requisites.names[0] }}
              </option></select
            ><button
              :disabled="!associationTargets[a.id] || !associationNote.trim()"
              @click="associate(a, 'change')"
            >
              Изменить связь {{ a.kind }}
            </button></template
          >
        </div>
      </fieldset>
      <h3>Организации и роли</h3>
      <label v-if="canWrite">Основание отклонения наблюдения<textarea v-model="observationNote" /></label>
      <p v-if="!detail.data.value.organizations.length">Сведения об организациях не найдены.</p>
      <ul>
        <li v-for="o in detail.data.value.organizations" :key="o.id">
          {{ o.legal_name ?? o.name ?? 'Название неизвестно' }} · {{ o.role }} ·
          {{ o.country ?? 'Страна неизвестна' }}
          <span v-if="observationRevision(o.id)"> · Наблюдение отклонено</span>
          <button
            v-if="canWrite"
            :disabled="busy || !observationNote.trim() || observationRevision(o.id) > 0"
            @click="rejectObservation(o.id)"
          >
            Отклонить наблюдение
          </button>
        </li>
      </ul>
      <details>
        <summary>Решения по наблюдениям</summary>
        <ul>
          <li v-for="d in detail.data.value.observationDecisions" :key="d.id">
            {{ d.observation_id }} · {{ d.action }} · {{ d.note }} · {{ d.actor_id }} · {{ d.created_at }}
          </li>
        </ul>
      </details>
      <h3>Доказательства и расположение источника</h3>
      <ul>
        <li v-for="e in detail.data.value.evidence" :key="e.id">
          <strong>{{ e.field_path }}</strong> · страница {{ e.page ?? 'не указана'
          }}<span v-if="e.sheet"> · лист {{ e.sheet }} {{ e.cell_range }}</span>
          <blockquote>{{ e.excerpt }}</blockquote>
          <small>Evidence {{ e.id }} · Result {{ e.result_id }} · {{ e.method }}</small>
        </li>
      </ul>
      <details>
        <summary>История классификации и решений</summary>
        <ul>
          <li v-for="r in detail.data.value.revisions" :key="r.id">
            Revision {{ r.revision }} · {{ typeLabels[r.type] }} · {{ reviewLabels[r.reviewState] }} ·
            {{ r.reason }} · {{ r.actorId }} · {{ r.createdAt }}
          </li>
          <li v-for="d in detail.data.value.decisions" :key="d.id">
            {{ d.action }} · {{ d.reason }} · {{ d.actor_id }} · {{ d.created_at }}
          </li>
        </ul>
      </details>
      <details>
        <summary>Processing runs и события</summary>
        <ul>
          <li v-for="r in detail.data.value.processing.runs" :key="r.id">
            {{ r.id }} · {{ processingLabels[r.status] }} · {{ r.stage }} · {{ r.attempt_count }}
          </li>
          <li v-for="e in detail.data.value.processing.events" :key="e.id">
            {{ e.code }} · {{ e.stage }} · {{ e.to_state }} · {{ e.worker_id ?? e.actor_id }} ·
            {{ e.created_at }}
          </li>
        </ul>
      </details>
      <h3>Коммерческий draft</h3>
      <p>
        Перенос не создаёт бизнес-версию и не подтверждает цену. Ручные значения сохраняются; позиции требуют
        явного выбора lotItemId.
      </p>
      <p v-if="!detail.data.value.intakeContext">
        Сначала независимо подтвердите компанию, тип КП и связь supplier_of.
      </p>
      <fieldset :disabled="!canWrite || busy || !detail.data.value.intakeContext">
        <legend>Перенести выбранные значения в draft</legend>
        <p v-if="!detail.data.value.commercial || !Object.keys(detail.data.value.commercial.output).length">
          Нативные коммерческие значения не найдены. Допускается проверенная ручная транскрипция.
        </p>
        <label v-for="(v, field) in detail.data.value.commercial?.output" :key="field"
          ><input v-model="selectedFields" type="checkbox" :value="field" />Перенести {{ field }}:
          {{ v.value }} · Evidence {{ v.evidenceId }}</label
        ><CommercialFieldsEditor v-model="draftFields" label="Черновик" /><label
          >Лот для переноса<select v-model="lotId" aria-label="Лот для переноса">
            <option value="">Выберите лот явно</option>
            <option v-for="l in context.data.value?.lots" :key="l.id" :value="l.id">{{ l.name }}</option>
          </select></label
        >
        <p v-if="context.data.value && !context.data.value.lots.length">
          Создайте лот отдельно в существующем OfferReview.
        </p>
        <div v-for="(item, index) in draftItems" :key="index">
          <label
            >Сопоставление позиции<select v-model="item.lotItemId">
              <option value="">Выберите lotItemId</option>
              <option v-for="i in mappedItems" :key="i.id" :value="i.id">{{ i.name }} · {{ i.id }}</option>
            </select></label
          ><label>Количество<input v-model="item.quantity" /></label
          ><label>Единица<input v-model="item.unit" /></label
          ><label>Цена единицы<input v-model="item.unitPrice" /></label>
        </div>
        <button
          type="button"
          @click="draftItems.push({ lotItemId: '', quantity: '', unit: '', unitPrice: null })"
        >
          Добавить сопоставленную позицию</button
        ><label>Основание переноса<textarea v-model="draftNote" /></label
        ><button :disabled="!lotId || !draftNote.trim()" @click="transfer">
          Перенести в draft без подтверждения цены
        </button>
      </fieldset>
      <p v-if="detail.data.value.drafts.length">
        <RouterLink :to="reviewLink()">Открыть draft в OfferReview</RouterLink>
      </p>
    </template>
  </section>
</template>
<style scoped>
.content-card {
  padding: 1.25rem;
  margin-block: 1rem;
}
.intake-table {
  overflow: auto;
}
table {
  width: 100%;
  border-collapse: collapse;
}
th,
td {
  text-align: left;
  vertical-align: top;
  padding: 0.75rem;
  border-bottom: 1px solid #dce2e8;
}
small {
  display: block;
  overflow-wrap: anywhere;
  font-size: 0.75rem;
  max-width: 24rem;
}
fieldset {
  margin-block: 1rem;
  padding: 1rem;
  display: flex;
  gap: 0.75rem;
  flex-wrap: wrap;
  align-items: end;
}
label {
  display: grid;
  gap: 0.25rem;
}
textarea {
  min-width: 16rem;
  min-height: 3rem;
}
blockquote {
  white-space: pre-wrap;
  margin: 0.5rem 0;
}
button {
  cursor: pointer;
}
button:disabled {
  cursor: default;
}
h2,
h3 {
  margin-block: 0.75rem;
}
dt {
  font-weight: 600;
}
dd {
  margin-bottom: 0.5rem;
}
</style>
