<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, RouterLink } from 'vue-router';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { api, checkSpecification } from './tender-api';
import { type VerificationContext } from './verification-api';
import { type StageContext, accreditationLabels, stageLabels, responseLabels } from './stages-api';
import TenderSelector from './TenderSelector.vue';
import OfferRegistry from './OfferRegistry.vue';
const props = defineProps<{ accreditation?: boolean }>();
const route = useRoute(),
  client = useQueryClient(),
  id = computed(() => String(route.query.tenderId ?? ''));
const query = useQuery({
  queryKey: computed(() => ['stages', id.value]),
  queryFn: () => api<StageContext>(`/tenders/${id.value}/stages`),
  enabled: computed(() => !!id.value),
  refetchOnWindowFocus: false,
});
const verification = useQuery({
  queryKey: computed(() => ['verification', id.value]),
  queryFn: () => api<VerificationContext>(`/tenders/${id.value}/verification`),
  enabled: computed(() => !!id.value),
  refetchOnWindowFocus: false,
});
const supplier = ref(''),
  stage = ref(''),
  kind = ref('negotiation'),
  label = ref(''),
  comment = ref('');
const offer = ref(''),
  version = ref(''),
  response = ref('received'),
  note = ref('');
const baselineVersion = ref(''),
  baselineNote = ref('');
const email = ref(''),
  contactDoc = ref(''),
  contactNote = ref(''),
  contactIds = ref<string[]>([]);
const subject = ref(''),
  body = ref(''),
  previousId = ref<string | undefined>();
const reportFile = ref<File>(),
  reportDoc = ref(''),
  reportKey = ref(''),
  assessedAt = ref(new Date().toISOString().slice(0, 10)),
  reportStatus = ref('pending'),
  source = ref(''),
  reportNote = ref('');
const reportInput = ref<HTMLInputElement>();
const busy = ref(false),
  error = ref(''),
  message = ref('');
const contacts = computed(
  () =>
    query.data.value?.contacts.filter((c) => c.supplierId === supplier.value && c.verified && c.documentId) ??
    [],
);
const offers = computed(
  () => verification.data.value?.offers.filter((o) => o.supplierId === supplier.value) ?? [],
);
const versions = computed(
  () =>
    offers.value
      .find((o) => o.id === offer.value)
      ?.versions.filter((v) => v.metadata && v.metadata.intent === 'confirm' && v.stageId === stage.value) ??
    [],
);
const responseExists = computed(() =>
  query.data.value?.responses.some((r) => r.stageId === stage.value && r.offerId === offer.value),
);
const supplierName = (value: string) =>
  verification.data.value?.suppliers.find((s) => s.id === value)?.name ?? value;
watch(id, () => {
  supplier.value = '';
  stage.value = '';
  reportDoc.value = '';
  reportFile.value = undefined;
  error.value = '';
  message.value = '';
});
watch([supplier, stage], () => {
  offer.value = '';
  version.value = '';
  contactIds.value = [];
  subject.value = '';
  body.value = '';
  previousId.value = undefined;
  email.value = '';
  contactDoc.value = '';
  contactNote.value = '';
  reportDoc.value = '';
  reportFile.value = undefined;
  source.value = '';
  reportNote.value = '';
});
watch(offer, () => {
  version.value = '';
  baselineVersion.value = '';
  baselineNote.value = '';
});
function template() {
  const selected = query.data.value?.stages.find((s) => s.id === stage.value);
  subject.value = `${query.data.value?.scope.title ?? ''}: ${selected?.label ?? ''}`;
  body.value = `Уважаемые коллеги!\n\nПросим предоставить ${selected?.kind === 'clarification' ? 'уточнённое коммерческое предложение' : 'обновлённое коммерческое предложение'} по тендеру «${query.data.value?.scope.title ?? ''}».\n${selected?.comment ?? ''}\n\nПросим указать стоимость, условия оплаты и срок поставки.`;
  contactIds.value = contacts.value.map((c) => c.id);
  previousId.value = undefined;
}
function editDraft(d: StageContext['drafts'][number]) {
  supplier.value = d.supplierId;
  stage.value = d.stageId;
  // Selection watchers clear context synchronously on the next tick; restore explicitly after them.
  queueMicrotask(() => {
    subject.value = d.subject;
    body.value = d.body;
    previousId.value = d.id;
    contactIds.value = contacts.value.filter((c) => d.recipients.includes(c.email)).map((c) => c.id);
  });
}
async function save(path: string, payload: Record<string, unknown>) {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  message.value = '';
  try {
    await api(`/tenders/${id.value}/${path}`, {
      method: 'POST',
      body: JSON.stringify({ ...payload, expectedRevision: query.data.value!.scope.revision }),
    });
    await query.refetch();
    await Promise.all(
      ['comparison', 'verification', 'offers', 'offer-stages'].map((key) =>
        client.invalidateQueries({ queryKey: [key, id.value] }),
      ),
    );
    message.value = 'Сохранено';
    return true;
  } catch (e) {
    error.value = (e as Error).message;
    return false;
  } finally {
    busy.value = false;
  }
}
async function createStage() {
  if (await save('stages', { kind: kind.value, label: label.value, comment: comment.value })) {
    label.value = '';
    comment.value = '';
  }
}
async function saveBaseline() {
  if (
    await save('stages/baseline', {
      offerId: offer.value,
      versionId: baselineVersion.value,
      note: baselineNote.value,
    })
  ) {
    baselineVersion.value = '';
    baselineNote.value = '';
  }
}
async function saveResponse() {
  await save(`stages/${stage.value}/responses`, {
    offerId: offer.value,
    status: response.value,
    ...(response.value === 'received' ? { versionId: version.value } : {}),
    note: note.value,
  });
}
async function saveContact() {
  if (
    await save('contacts/confirm', {
      supplierId: supplier.value,
      email: email.value,
      documentId: contactDoc.value,
      note: contactNote.value,
    })
  ) {
    email.value = '';
    contactNote.value = '';
  }
}
async function saveDraft() {
  if (
    await save(`stages/${stage.value}/drafts`, {
      supplierId: supplier.value,
      contactIds: contactIds.value,
      subject: subject.value,
      body: body.value,
      ...(previousId.value ? { previousId: previousId.value } : {}),
    })
  ) {
    previousId.value = undefined;
    subject.value = '';
    body.value = '';
  }
}
function chooseFile(e: Event) {
  reportFile.value = (e.target as HTMLInputElement).files?.[0];
  reportDoc.value = '';
  reportKey.value = crypto.randomUUID();
}
async function saveReport() {
  if (!reportFile.value || busy.value) return;
  const problem = checkSpecification(reportFile.value);
  if (problem) {
    error.value = problem;
    return;
  }
  const tenderId = id.value,
    supplierId = supplier.value,
    file = reportFile.value;
  const payload = {
    supplierId,
    assessedAt: assessedAt.value + 'T00:00:00.000Z',
    status: reportStatus.value,
    source: source.value,
    note: reportNote.value,
    expectedRevision: query.data.value!.scope.revision,
  };
  busy.value = true;
  error.value = '';
  message.value = '';
  try {
    let documentId = reportDoc.value;
    if (!documentId) {
      const form = new FormData();
      form.append('file', file);
      documentId = (
        await api<{ id: string }>(`/tenders/${tenderId}/accreditations/files`, {
          method: 'POST',
          headers: { 'Idempotency-Key': reportKey.value },
          body: form,
        })
      ).id;
    }
    if (id.value === tenderId && supplier.value === supplierId) reportDoc.value = documentId;
    await api(`/tenders/${tenderId}/accreditations`, {
      method: 'POST',
      body: JSON.stringify({ ...payload, documentId }),
    });
    if (id.value === tenderId && supplier.value === supplierId) {
      reportFile.value = undefined;
      reportDoc.value = '';
      source.value = '';
      reportNote.value = '';
      if (reportInput.value) reportInput.value.value = '';
      await query.refetch();
      message.value = 'Сохранено';
    }
    await client.invalidateQueries({ queryKey: ['comparison', tenderId] });
  } catch (e) {
    if (id.value === tenderId) error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <section class="page-heading">
    <div>
      <p class="eyebrow">{{ props.accreditation ? 'АККРЕДИТАЦИЯ / S07' : 'ЭТАПЫ / S06' }}</p>
      <h1>{{ props.accreditation ? 'Аккредитация поставщиков' : 'Этапы тендера и черновики' }}</h1>
      <p>История сохраняется. Письма доступны только как редактируемые черновики.</p>
    </div>
  </section>
  <TenderSelector :tender-id="id" />
  <nav v-if="id" class="stage-links">
    <RouterLink :to="`/comparison?tenderId=${id}`">Сравнение</RouterLink
    ><RouterLink :to="`/review?tenderId=${id}`">Проверка КП</RouterLink
    ><RouterLink :to="`/${props.accreditation ? 'stages' : 'accreditation'}?tenderId=${id}`">{{
      props.accreditation ? 'Этапы' : 'Аккредитация'
    }}</RouterLink>
  </nav>
  <p v-if="!id">Выберите тендер.</p>
  <p v-else-if="query.isPending.value || verification.isPending.value">Загружаем данные…</p>
  <p v-if="query.isError.value || verification.isError.value" role="alert">
    {{ query.error.value?.message ?? verification.error.value?.message }}
  </p>
  <p v-if="error" role="alert">{{ error }}</p>
  <p v-if="message" role="status">{{ message }}</p>
  <template v-if="query.data.value && verification.data.value">
    <section class="content-card stage-card">
      <label
        >Поставщик этапа<select v-model="supplier" aria-label="Поставщик этапа" :disabled="busy">
          <option value="">Выберите поставщика</option>
          <option v-for="s in verification.data.value.suppliers" :key="s.id" :value="s.id">
            {{ s.name }}
          </option>
        </select></label
      >
    </section>
    <template v-if="props.accreditation">
      <form class="content-card stage-card" @submit.prevent="saveReport">
        <fieldset :disabled="busy" class="report-fields">
          <h2>Новый отчёт аккредитации</h2>
          <p>
            Каждая загрузка относится только к выбранному поставщику. Одинаковый файл не переносит статус
            другим компаниям.
          </p>
          <label
            >Файл отчёта (PDF/TXT, до 20 МБ)<input
              ref="reportInput"
              type="file"
              accept=".pdf,.txt"
              required
              aria-label="Файл отчёта"
              @change="chooseFile"
          /></label>
          <label
            >Дата отчёта<input v-model="assessedAt" type="date" required aria-label="Дата отчёта"
          /></label>
          <label
            >Статус отчёта<select v-model="reportStatus" aria-label="Статус отчёта">
              <option v-for="(text, value) in accreditationLabels" :key="value" :value="value">
                {{ text }}
              </option>
            </select></label
          >
          <label
            >Источник отчёта<input
              v-model="source"
              required
              maxlength="1000"
              aria-label="Источник отчёта"
              placeholder="Название ресурса или подразделения"
          /></label>
          <label
            >Примечание<textarea v-model="reportNote" maxlength="2000" aria-label="Примечание отчёта" />
          </label>
          <button class="primary-action" :disabled="busy || !supplier || !reportFile">
            Добавить отчёт в историю
          </button>
        </fieldset>
      </form>
      <section class="content-card stage-card">
        <h2>История аккредитаций</h2>
        <div v-for="s in verification.data.value.suppliers" :key="s.id" class="stage-history">
          <h3>{{ s.name }}</h3>
          <p v-if="!query.data.value.reports.some((r) => r.supplierId === s.id)" class="missing-report">
            Нет проверки
          </p>
          <article v-for="r in query.data.value.reports.filter((r) => r.supplierId === s.id)" :key="r.id">
            <strong>{{ accreditationLabels[r.status] }} · {{ r.assessedAt.slice(0, 10) }}</strong>
            <p>{{ r.source }} · {{ r.note }}</p>
            <a :href="`/api/tenders/${id}/offers/${r.documentId}/original`">{{ r.name }}</a
            ><small>SHA-256: {{ r.sha256 }} · Автор: {{ r.actorId }} · Запись: {{ r.createdAt }}</small>
          </article>
        </div>
      </section>
    </template>
    <template v-else>
      <form class="content-card stage-card" @submit.prevent="createStage">
        <h2>Добавить коммерческий этап</h2>
        <p>Номер назначается последовательно. Сохранения КП остаются отдельной технической историей.</p>
        <label
          >Тип этапа<select v-model="kind" aria-label="Тип этапа">
            <option v-for="(text, value) in stageLabels" :key="value" :value="value">{{ text }}</option>
          </select></label
        >
        <label
          >Название этапа<input v-model="label" required maxlength="300" aria-label="Название этапа" /></label
        ><label
          >Комментарий этапа<textarea
            v-model="comment"
            maxlength="2000"
            :required="kind === 'round'"
            aria-label="Комментарий этапа"
          /></label
        ><button class="primary-action" :disabled="busy">Создать этап</button>
      </form>
      <section class="content-card stage-card">
        <h2>Коммерческие этапы</h2>
        <p v-if="!query.data.value.stages.length">Этапов пока нет.</p>
        <article v-for="s in query.data.value.stages" :key="s.id">
          <strong>{{ s.ordinal }}. {{ s.label }} · {{ stageLabels[s.kind] }}</strong>
          <p>{{ s.comment }}</p>
          <small>{{ s.createdAt }} · {{ s.actorId }}</small>
        </article>
        <label
          >Выбранный этап<select v-model="stage" aria-label="Выбранный этап">
            <option value="">Выберите этап</option>
            <option v-for="s in query.data.value.stages" :key="s.id" :value="s.id">
              {{ s.ordinal }}. {{ s.label }}
            </option>
          </select></label
        >
      </section>
      <form class="content-card stage-card" @submit.prevent="saveResponse">
        <h2>Зафиксировать ответ поставщика</h2>
        <p>
          Сначала загрузите ответное КП с выбранным этапом и подтвердите его в проверке КП. Фиксация ответа
          окончательна; исходные цены сохраняются.
        </p>
        <label
          >Предложение поставщика<select v-model="offer" aria-label="Предложение поставщика">
            <option value="">Выберите лот</option>
            <option v-for="o in offers" :key="o.id" :value="o.id">
              {{ verification.data.value.lots.find((l) => l.id === o.lotId)?.name }}
            </option>
          </select></label
        >
        <label
          >Результат этапа<select v-model="response" aria-label="Результат этапа">
            <option value="received">Ответ получен</option>
            <option value="no_reply">Нет ответа</option>
            <option value="withdrawn">Предложение отозвано</option>
          </select></label
        >
        <label v-if="response === 'received'"
          >Подтверждённая версия этапа<select v-model="version" aria-label="Подтверждённая версия этапа">
            <option value="">Выберите версию</option>
            <option v-for="v in versions" :key="v.id" :value="v.id">
              Техническое сохранение {{ v.version }} · {{ v.metadata?.at }}
            </option>
          </select></label
        >
        <label
          >Основание ответа<textarea v-model="note" required maxlength="1000" aria-label="Основание ответа" />
        </label>
        <p v-if="responseExists">Ответ на этот этап уже зафиксирован.</p>
        <button
          class="primary-action"
          :disabled="busy || !stage || !offer || responseExists || (response === 'received' && !version)"
        >
          Зафиксировать ответ
        </button>
        <article v-for="r in query.data.value.responses.filter((r) => r.supplierId === supplier)" :key="r.id">
          {{ query.data.value.stages.find((s) => s.id === r.stageId)?.label }} ·
          {{ responseLabels[r.status] }} · {{ r.createdAt }} · {{ r.actorId }} · {{ r.note }}
        </article>
      </form>
      <form
        v-if="offer && !query.data.value.baselines.some((b) => b.value.offerId === offer)"
        class="content-card stage-card"
        @submit.prevent="saveBaseline"
      >
        <h2>Исходная подтверждённая цена участника</h2>
        <p>
          Для поставщика, добавленного после начала этапов, отдельно зафиксируйте базовую версию КП без этапа.
          Уже зафиксированную цену нельзя заменить.
        </p>
        <label
          >Базовая версия КП<select v-model="baselineVersion" required aria-label="Базовая версия КП">
            <option value="">Выберите подтверждённую версию без этапа</option>
            <option
              v-for="v in offers
                .find((o) => o.id === offer)
                ?.versions.filter((v) => v.metadata?.intent === 'confirm' && !v.stageId) ?? []"
              :key="v.id"
              :value="v.id"
            >
              Техническое сохранение {{ v.version }}
            </option>
          </select></label
        >
        <label
          >Основание базовой цены<textarea
            v-model="baselineNote"
            required
            maxlength="1000"
            aria-label="Основание базовой цены"
          /></label
        ><button class="secondary-action" :disabled="busy || !baselineVersion">
          Зафиксировать базовую цену
        </button>
      </form>
      <section class="content-card stage-card">
        <h2>Ответные КП</h2>
        <OfferRegistry :tender-id="id" />
      </section>
      <form class="content-card stage-card" @submit.prevent="saveContact">
        <h2>Подтвердить контакт</h2>
        <p>Введите адрес из проверенного источника для выбранного поставщика.</p>
        <label
          >Email контакта<input
            v-model="email"
            type="email"
            required
            maxlength="254"
            aria-label="Email контакта"
        /></label>
        <label
          >Документ — источник контакта<select v-model="contactDoc" required aria-label="Документ контакта">
            <option value="">Выберите документ</option>
            <option v-for="d in verification.data.value.documents" :key="d.id" :value="d.id">
              {{ d.name }}
            </option>
          </select></label
        ><label
          >Основание подтверждения<textarea
            v-model="contactNote"
            required
            maxlength="1000"
            aria-label="Основание подтверждения контакта"
          /></label
        ><button class="secondary-action" :disabled="busy || !supplier">Подтвердить контакт</button>
      </form>
      <form class="content-card stage-card" @submit.prevent="saveDraft">
        <h2>{{ previousId ? 'Редактировать черновик' : 'Черновик письма' }}</h2>
        <p>Отправка отсутствует. Сохранение новой редакции оставляет предыдущую в истории.</p>
        <button type="button" class="secondary-action" :disabled="!stage || !supplier" @click="template">
          Заполнить шаблон
        </button>
        <p v-if="!contacts.length" class="missing-report">
          Нет подтверждённого email. Черновик сохранится без адресата.
        </p>
        <label v-for="c in contacts" :key="c.id" class="contact-choice"
          ><input v-model="contactIds" type="checkbox" :value="c.id" />{{ c.email }} · источник
          {{ c.documentId }}</label
        >
        <label>Тема письма<input v-model="subject" required maxlength="300" aria-label="Тема письма" /></label
        ><label
          >Текст письма<textarea
            v-model="body"
            required
            maxlength="20000"
            rows="8"
            aria-label="Текст письма"
          /></label
        ><button class="primary-action" :disabled="busy || !stage || !supplier">
          Сохранить черновик письма
        </button>
      </form>
      <section class="content-card stage-card">
        <h2>История черновиков</h2>
        <article v-for="d in query.data.value.drafts" :key="d.id">
          <h3>{{ d.subject }}</h3>
          <p>{{ supplierName(d.supplierId) }} · {{ d.recipients.join(', ') || 'Нет адресата' }}</p>
          <pre>{{ d.body }}</pre>
          <small>{{ d.createdAt }} · {{ d.actorId }} · {{ d.id }}</small>
          <p v-if="d.superseded">Сохранена новая редакция этого черновика.</p>
          <button v-else class="secondary-action" @click="editDraft(d)">Редактировать эту редакцию</button>
        </article>
      </section>
    </template>
    <details class="content-card stage-card">
      <summary>Журнал действий</summary>
      <article v-for="a in query.data.value.audit" :key="a.id">
        {{ a.at }} · {{ a.action }} · {{ a.entityId }} · {{ a.actorId }}
      </article>
    </details>
  </template>
</template>
<style scoped>
.report-fields {
  display: grid;
  gap: 1rem;
  min-width: 0;
  border: 0;
  padding: 0;
  margin: 0;
}
.stage-card {
  display: grid;
  gap: 1rem;
  margin-top: 1rem;
  min-width: 0;
}
.stage-card label {
  display: grid;
  gap: 0.35rem;
}
.stage-card input,
.stage-card select,
.stage-card textarea {
  max-width: 100%;
  min-width: 0;
  width: 100%;
  padding: 0.6rem;
  border: 1px solid var(--border-color, #ccc);
  border-radius: 6px;
  background: var(--surface-card, #fff);
  color: inherit;
}
.stage-card button {
  justify-self: start;
}
.stage-card article {
  border-top: 1px solid #ddd;
  padding: 1rem 0;
  overflow-wrap: anywhere;
}
.stage-card small {
  display: block;
  overflow-wrap: anywhere;
}
.stage-card pre {
  white-space: pre-wrap;
  font: inherit;
}
.missing-report {
  color: #b42318;
  font-weight: 600;
}
.stage-links {
  display: flex;
  gap: 1rem;
  flex-wrap: wrap;
  margin: 1rem 0;
}
.stage-card .contact-choice {
  display: flex;
  align-items: center;
  overflow-wrap: anywhere;
}
.contact-choice input {
  width: auto;
}
.stage-history {
  min-width: 0;
}
</style>
