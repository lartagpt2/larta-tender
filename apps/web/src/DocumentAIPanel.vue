<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { api } from './tender-api';
interface Field {
  rawValue: string | null;
  value: string | null;
  page: number | null;
  evidenceSnippet: string | null;
  confidence: null;
}
interface Draft {
  items: Record<string, Field>[];
  [key: string]: Field | Record<string, Field>[];
}
interface Job {
  id: string;
  documentId: string;
  receiptId: string | null;
  supplierId: string | null;
  lotId: string | null;
  stageId: string | null;
  name: string;
  status: string;
  revision: number;
  error: string | null;
  result?: { draft: Draft; model: string; digest: string | null; durationMs: number };
  matches?: { id: string; name: string; reason: string }[];
  warnings: string[];
  reviews: {
    fields: Record<string, string | null>;
    verification?: Record<string, unknown>;
    note: string;
    actorId: string;
    at: string;
  }[];
  events: { status: string; at: string; actorId: string }[];
}
const props = defineProps<{
  tenderId: string;
  documentId: string;
  kind: 'offer' | 'specification';
  receiptId?: string;
  supplierId?: string;
  lotId?: string;
  requiredItems?: { id: string; name: string; quantity: string; unit: string }[];
}>();
const emit = defineEmits<{
  ready: [jobId: string];
  restore: [snapshot: Record<string, unknown>, jobId: string];
  'use-field': [key: string, value: string, jobId: string];
  'use-line': [item: Record<string, Field>, lotItemId: string, jobId: string];
  'use-supplier': [id: string];
  'use-scope': [items: Record<string, Field>[]];
}>();
const context = computed(() =>
  JSON.stringify([props.documentId, props.receiptId ?? null, props.supplierId ?? null, props.lotId ?? null]),
);
const query = useQuery({
  queryKey: computed(() => ['document-ai', props.tenderId]),
  queryFn: () =>
    api<{ enabled: boolean; syntheticOnly: boolean; jobs: Job[] }>(`/tenders/${props.tenderId}/document-ai`),
  enabled: computed(() => !!props.tenderId && !!props.documentId),
  refetchOnWindowFocus: false,
  refetchInterval: (q) =>
    q.state.data?.jobs.some((j) => ['pending', 'running'].includes(j.status)) ? 1500 : false,
});
const jobs = computed(
  () =>
    query.data.value?.jobs.filter(
      (j) =>
        j.documentId === props.documentId &&
        j.receiptId === (props.receiptId ?? null) &&
        j.supplierId === (props.supplierId ?? null) &&
        j.lotId === (props.lotId ?? null),
    ) ?? [],
);
const chosen = ref(''),
  summary = computed(() => jobs.value.find((j) => j.id === chosen.value) ?? jobs.value[0]);
const detail = useQuery({
  queryKey: computed(() => ['document-ai-job', props.tenderId, summary.value?.id]),
  queryFn: () => api<Job>(`/tenders/${props.tenderId}/document-ai/${summary.value!.id}`),
  enabled: computed(() => !!summary.value?.id),
  refetchOnWindowFocus: false,
  refetchInterval: (q) => (['pending', 'running'].includes(q.state.data?.status ?? '') ? 1500 : false),
});
const selected = computed(() =>
  detail.data.value?.id === summary.value?.id ? detail.data.value : summary.value,
);
const edits = ref<Record<string, string | null>>({}),
  note = ref(''),
  busy = ref(false),
  error = ref(''),
  message = ref(''),
  mapping = ref<Record<number, string>>({});
const labels: Record<string, string> = {
  description: 'Наименование',
  sku: 'Артикул',
  quantity: 'Количество',
  unit: 'Единица',
  unitPrice: 'Цена за единицу',
  lineTotal: 'Сумма строки',
  technicalRequirements: 'Требования ТЗ',
  supplierName: 'Поставщик',
  taxId: 'ИНН / регистрационный номер',
  kpp: 'КПП',
  buyerName: 'Покупатель',
  consignee: 'Грузополучатель',
  documentNumber: 'Номер документа',
  documentDate: 'Дата документа',
  email: 'Email в документе (не From)',
  address: 'Адрес в документе',
  total: 'Итог',
  currency: 'Валюта',
  vat: 'НДС',
  payment: 'Оплата',
  delivery: 'Поставка',
  deliveryCost: 'Расходы доставки',
  validUntil: 'Срок действия',
  remarks: 'Замечания',
};
const warningsText: Record<string, string> = {
  tax_id_invalid_format:
    'ИНН прочитан в неверном формате. Сверьте с оригиналом; нули не добавляются автоматически.',
  tax_id_wrong_role: 'В источнике указан ИНН покупателя. Сверьте реквизиты поставщика вручную.',
  tax_id_requires_review: 'Формат регистрационного номера требует ручной проверки.',
  evidence_source_reanchored:
    'Источник отдельных полей уточнён по той же строке текстового слоя. Проверьте оригинал.',
  missing_evidence: 'Для значения нет страницы или фрагмента источника.',
  unverified_evidence: 'Фрагмент не найден в тексте указанной страницы.',
  raw_value_not_in_evidence: 'Исходное значение не найдено в приведённом фрагменте.',
  invalid_number: 'Число неоднозначно или не прочитано — проверьте вручную.',
  unknown_currency: 'Валюта неизвестна; курс и пересчёт не применяются.',
  missing_line_price: 'В позиции отсутствует количество или цена.',
  nonpositive_quantity: 'Количество должно быть больше нуля.',
  line_arithmetic_mismatch: 'Количество × цена не совпадает с суммой строки.',
  total_arithmetic_mismatch: 'Сумма позиций не совпадает с объявленным итогом.',
  mixed_currency: 'В документе встречаются разные валюты.',
  missing_total: 'Итоговая сумма не определена.',
  vision_evidence_requires_review: 'Проверьте фрагменты скана по оригиналу.',
  native_text_draft_requires_review: 'Позиции получены из текстового слоя PDF и требуют вашей проверки.',
  supplier_unresolved_or_ambiguous: 'Поставщик не найден однозначно. Выберите компанию вручную.',
  candidate_differs_selected_supplier: 'Кандидат из документа отличается от выбранного поставщика.',
};
const errorsText: Record<string, string> = {
  cloud_not_disabled: 'Сервер не подтвердил отключение облачной обработки. Документ не отправлен в модель.',
  local_ai_unavailable: 'Локальная модель недоступна или превысила время ожидания.',
  model_digest_mismatch: 'Версия модели изменилась; требуется проверка настройки.',
  document_parse_failed: 'Не удалось прочитать документ. Оригинал доступен для ручной проверки.',
  document_parse_timeout: 'Подготовка документа превысила время ожидания.',
  page_limit: 'Документ превышает предел 10 страниц для локальной обработки.',
  text_limit: 'Документ превышает допустимый объём текста.',
  image_limit: 'Изображение превышает допустимый размер.',
  xlsx_formula_or_external_unsupported:
    'Формулы и внешние связи XLSX не обрабатываются. Проверьте файл вручную.',
  unsupported_format: 'Этот формат пока не поддерживается.',
  ai_configuration_changed: 'Настройки обработки изменились. Запустите новую обработку явно.',
  synthetic_policy_changed: 'Оригинал больше не входит в разрешённый список тестовых документов.',
};
const statusLabels: Record<string, string> = {
  pending: 'Ожидает распознавания',
  running: 'Обрабатывается',
  needs_review: 'Черновик готов — не подтверждён',
  failed: 'Ошибка распознавания',
  unsupported: 'Формат или содержимое не поддерживается',
};
const fields = computed(
  () =>
    Object.entries(selected.value?.result?.draft ?? {}).filter(([key]) => key !== 'items') as [
      string,
      Field,
    ][],
);
watch(context, () => {
  chosen.value = '';
  edits.value = {};
  mapping.value = {};
  error.value = '';
  message.value = '';
});
watch(
  () => selected.value?.id,
  () => {
    edits.value = { ...selected.value?.reviews.at(-1)?.fields };
    note.value = '';
    mapping.value = {};
  },
);
watch(
  () => [selected.value?.id, selected.value?.status].join(':'),
  () => emit('ready', selected.value?.status === 'needs_review' ? selected.value.id : ''),
);
async function start(retry = false) {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    const job = await api<Job>(`/tenders/${props.tenderId}/document-ai`, {
      method: 'POST',
      body: JSON.stringify({
        documentId: props.documentId,
        kind: props.kind,
        ...(props.receiptId ? { receiptId: props.receiptId } : {}),
        ...(props.supplierId ? { supplierId: props.supplierId } : {}),
        ...(props.lotId ? { lotId: props.lotId } : {}),
        ...(retry && selected.value ? { retryOf: selected.value.id } : {}),
      }),
    });
    chosen.value = job.id;
    await query.refetch();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
async function save() {
  if (!selected.value) return;
  busy.value = true;
  error.value = '';
  try {
    await api(`/tenders/${props.tenderId}/document-ai/${selected.value.id}/review`, {
      method: 'POST',
      body: JSON.stringify({ revision: selected.value.revision, fields: edits.value, note: note.value }),
    });
    await query.refetch();
    await detail.refetch();
    message.value = 'ИИ-черновик сохранён. Цены и подтверждённые данные не изменены.';
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
function value(key: string, field: Field) {
  return Object.hasOwn(edits.value, key) ? edits.value[key] : field.value;
}
</script>
<template>
  <section class="content-card ai-panel" aria-label="Локальное распознавание документа">
    <h2>{{ kind === 'offer' ? 'ИИ-черновик КП' : 'Локальное распознавание ТЗ' }}</h2>
    <p>
      Все значения требуют проверки закупщиком. Ручные и подтверждённые данные не заполняются автоматически.
    </p>
    <p v-if="query.isError.value" role="alert">{{ query.error.value?.message }}</p>
    <p v-if="query.data.value && !query.data.value.enabled">
      Локальное распознавание выключено. Ручная работа и оригиналы доступны.
    </p>
    <p>До отдельного допуска доступны только оригиналы из утверждённого списка синтетических SHA.</p>
    <button
      type="button"
      class="secondary-action"
      :disabled="busy || !query.data.value?.enabled || (kind === 'offer' && (!receiptId || !lotId))"
      @click="start()"
    >
      {{ kind === 'offer' ? 'Распознать КП локально' : 'Распознать ТЗ локально' }}
    </button>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="message" role="status">{{ message }}</p>
    <template v-if="selected">
      <label
        >История распознавания<select v-model="chosen" aria-label="История распознавания">
          <option v-for="job in jobs" :key="job.id" :value="job.id">
            {{ statusLabels[job.status] }} · {{ job.id.slice(0, 10) }}
          </option>
        </select></label
      >
      <p role="status">{{ statusLabels[selected.status] }}</p>
      <small
        >Поступление {{ selected.receiptId ?? 'ТЗ' }} · этап {{ selected.stageId ?? 'без этапа' }} · лот
        {{ selected.lotId ?? 'не выбран' }}</small
      >
      <p v-if="selected.error" role="alert">
        {{
          errorsText[selected.error] ??
          'Не удалось завершить обработку. Продолжите вручную или повторите позже.'
        }}
      </p>
      <button
        v-if="!['pending', 'running'].includes(selected.status)"
        type="button"
        class="secondary-action"
        :disabled="busy || !query.data.value?.enabled"
        @click="start(true)"
      >
        Повторить обработку
      </button>
      <template v-if="selected.result">
        <p>
          Источник: {{ selected.result.model }} · {{ selected.result.durationMs }} мс. Данные не подтверждены.
        </p>
        <p v-for="warning in selected.warnings" :key="warning" class="ai-warning">
          {{ warningsText[warning] ?? 'Требуется ручная проверка документа.' }}
        </p>
        <div v-if="kind === 'offer'" class="ai-candidates">
          <h3>Кандидат поставщика</h3>
          <p v-if="!selected.matches?.length">
            Поставщик не определён. Выберите или создайте компанию вручную.
          </p>
          <article v-for="match in selected.matches" :key="match.id">
            <strong>{{ match.name }}</strong>
            <p>{{ match.reason }}</p>
            <button type="button" class="secondary-action" @click="emit('use-supplier', match.id)">
              Выбрать кандидата для проверки
            </button>
          </article>
        </div>
        <div class="ai-scroll">
          <table>
            <caption>
              Получено из документа / ИИ / правка черновика
            </caption>
            <thead>
              <tr>
                <th>Поле</th>
                <th>Исходный фрагмент</th>
                <th>Извлечено ИИ</th>
                <th>Правка черновика</th>
                <th>Ручной перенос</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="[key, field] in fields" :key="key">
                <th>{{ labels[key] ?? key }}</th>
                <td>
                  {{ field.rawValue ?? 'Нет данных' }}
                  <details v-if="field.evidenceSnippet">
                    <summary>Страница {{ field.page }} · источник</summary>
                    {{ field.evidenceSnippet }}
                  </details>
                </td>
                <td>{{ field.value ?? 'Не определено' }}</td>
                <td>
                  <input
                    :value="value(key, field) ?? ''"
                    :aria-label="`ИИ-черновик: ${labels[key] ?? key}`"
                    maxlength="2000"
                    @input="edits[key] = ($event.target as HTMLInputElement).value || null"
                  />
                </td>
                <td>
                  <button
                    v-if="kind === 'offer' && value(key, field) !== null"
                    type="button"
                    class="secondary-action"
                    @click="emit('use-field', key, value(key, field)!, selected.id)"
                  >
                    Ввести в пустое поле
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <label
          >Основание правки ИИ-черновика<textarea
            v-model="note"
            aria-label="Основание правки ИИ-черновика"
            maxlength="1000"
          /></label
        ><button type="button" class="secondary-action" :disabled="busy || !note.trim()" @click="save">
          Сохранить ИИ-черновик
        </button>
        <button
          v-if="kind === 'offer' && selected.reviews.at(-1)?.verification"
          type="button"
          class="secondary-action"
          @click="emit('restore', selected.reviews.at(-1)!.verification!, selected.id)"
        >
          Восстановить сохранённый ИИ-черновик в форму
        </button>
        <h3>Позиции из документа</h3>
        <p v-if="!selected.result.draft.items.length">Позиции не извлечены.</p>
        <article v-for="(item, index) in selected.result.draft.items" :key="index" class="ai-item">
          <h4>{{ index + 1 }}. {{ item.description?.value ?? 'Описание не определено' }}</h4>
          <p v-for="(field, key) in item" :key="key">
            {{ labels[key] ?? key }}: {{ field.value ?? 'Не определено' }}
            <small>· стр. {{ field.page ?? '—' }}</small>
          </p>
          <details>
            <summary>Фрагмент позиции</summary>
            {{ item.description?.evidenceSnippet }}
          </details>
          <template v-if="kind === 'offer'"
            ><label
              >Сопоставить с позицией ТЗ<select
                v-model="mapping[index]"
                :aria-label="`Позиция ТЗ для строки ИИ ${index + 1}`"
              >
                <option value="">Выбрать вручную</option>
                <option v-for="r in requiredItems ?? []" :key="r.id" :value="r.id">
                  {{ r.name }} · {{ r.quantity }} {{ r.unit }}
                </option>
              </select></label
            ><button
              type="button"
              class="secondary-action"
              :disabled="!mapping[index]"
              @click="emit('use-line', item, mapping[index], selected.id)"
            >
              Ввести цену в пустую строку
            </button></template
          >
        </article>
        <button
          v-if="kind === 'specification' && selected.result.draft.items.length"
          type="button"
          class="secondary-action"
          @click="emit('use-scope', selected.result.draft.items)"
        >
          Добавить позиции в редактор для проверки
        </button>
        <details>
          <summary>История правок черновика</summary>
          <p v-for="review in selected.reviews" :key="review.at">
            {{ review.at }} · {{ review.actorId }} · {{ review.note }}
          </p>
        </details>
        <details>
          <summary>История задания</summary>
          <p v-for="event in selected.events" :key="event.at + event.status">
            {{ event.at }} · {{ statusLabels[event.status] ?? event.status }} · {{ event.actorId }}
          </p>
        </details>
      </template>
    </template>
  </section>
</template>
<style scoped>
.ai-panel {
  display: grid;
  gap: 0.8rem;
  min-width: 0;
  margin-top: 1rem;
}
.ai-panel button {
  justify-self: start;
}
.ai-panel label {
  display: grid;
  gap: 0.4rem;
}
.ai-panel input,
.ai-panel select,
.ai-panel textarea {
  font: inherit;
  min-width: 0;
  max-width: 100%;
  padding: 0.5rem;
  border: 1px solid #b8c8d2;
  border-radius: 0.4rem;
}
.ai-scroll {
  overflow: auto;
  max-width: 100%;
}
table {
  border-collapse: collapse;
  width: 100%;
  font-size: 0.85rem;
}
th,
td {
  padding: 0.6rem;
  border: 1px solid #d8e0e7;
  text-align: left;
  vertical-align: top;
}
td input {
  width: 10rem;
}
caption {
  text-align: left;
  font-weight: 600;
  padding: 0.5rem;
}
.ai-panel small,
.ai-panel details {
  overflow-wrap: anywhere;
}
.ai-warning {
  color: #8a4800;
}
.ai-item {
  border-top: 1px solid #d8e0e7;
  padding: 0.6rem 0;
}
</style>
