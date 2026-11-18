<script setup lang="ts">
import { computed, ref } from 'vue';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { api } from './tender-api';
const props = defineProps<{ tenderId: string; readOnly?: boolean }>();
interface Row {
  receiptId: string;
  originalId: string;
  name: string;
  mimeType: string;
  blobSha256: string;
  receivedAt: string;
  batchId: string;
  type: string;
  initialType: string;
  reviewState: string;
  revision: number;
  reason: string;
  processingStatus: string;
  coverage: { nativeTextAttempted: boolean; nativeTextAvailable: boolean; ocr: boolean; model: boolean };
}
interface History {
  revisions: {
    id: string;
    revision: number;
    type: string;
    source: string;
    reason: string;
    actorId: string;
    createdAt: string;
  }[];
  evidence: { id: string; page: number; sheet?: string; cellRange?: string; excerpt: string }[];
}
const types: Record<string, string> = {
  specification: 'ТЗ',
  offer: 'КП',
  quality_certificate: 'Паспорт качества',
  supporting: 'Приложение',
  unknown: 'Не определён',
};
const reasons: Record<string, string> = {
  explicit_content_marker: 'Назначение предложено по явным признакам содержимого.',
  xlsx_formula_or_external_unsupported:
    'Таблица содержит формулы или внешние связи; требуется ручная проверка.',
  document_parse_failed: 'Не удалось прочитать содержимое документа.',
  ocr_required_no_text_layer: 'Нет текстового слоя — требуется OCR. OCR не запускался.',
  insufficient_content_evidence: 'Недостаточно признаков в содержимом.',
  ambiguous_content_markers: 'Обнаружены противоречивые признаки.',
  native_parse_failed: 'Не удалось прочитать документ.',
  email_container_not_content_classified: 'Оригинал письма сохранён; вложения показаны отдельно.',
  no_text: 'Текст отсутствует.',
};
const rejectionLabels: Record<string, string> = {
  archive_handler_not_approved: 'ZIP пока не поддерживается.',
  unsupported_type: 'Этот формат пока не поддерживается.',
  type_mismatch: 'Содержимое не соответствует формату файла.',
  invalid_filename: 'Недопустимое имя файла.',
  file_size: 'Недопустимый размер файла.',
  invalid_xlsx_container: 'Структура XLSX повреждена.',
  unsafe_xlsx_container: 'Таблица не прошла проверку безопасности.',
  invalid_email: 'Не удалось прочитать письмо.',
};
const client = useQueryClient();
const list = useQuery({
  queryKey: computed(() => ['intake', props.tenderId]),
  queryFn: () => api<Row[]>(`/tenders/${props.tenderId}/intake/documents`),
});
const files = ref<File[]>([]),
  key = ref(crypto.randomUUID()),
  busy = ref(false),
  error = ref(''),
  outcomes = ref<{ name: string; status: string; code?: string }[]>([]);
const selected = ref<Row>(),
  newType = ref('unknown'),
  note = ref(''),
  history = ref<History>(),
  historyReceipt = ref('');
function pick(e: Event) {
  files.value = Array.from((e.target as HTMLInputElement).files ?? []);
  key.value = crypto.randomUUID();
  outcomes.value = [];
}
function newIntake() {
  key.value = crypto.randomUUID();
  void upload();
}
async function upload() {
  if (!files.value.length || busy.value || props.readOnly) return;
  if (
    files.value.length > 10 ||
    files.value.some((f) => f.size > 20 * 1024 * 1024) ||
    files.value.reduce((s, f) => s + f.size, 0) > 40 * 1024 * 1024
  ) {
    error.value = 'До 10 файлов, 20 MiB на файл, 40 MiB на пакет.';
    return;
  }
  error.value = '';
  busy.value = true;
  try {
    const body = new FormData();
    for (const f of files.value) body.append('files', f);
    const r = await api<{ outcomes: typeof outcomes.value }>(`/tenders/${props.tenderId}/intake/batches`, {
      method: 'POST',
      headers: { 'Idempotency-Key': key.value },
      body,
    });
    outcomes.value = r.outcomes;
    await client.invalidateQueries({ queryKey: ['intake', props.tenderId] });
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
async function showHistory(row: Row) {
  error.value = '';
  try {
    history.value = await api<History>(`/tenders/${props.tenderId}/intake/receipts/${row.receiptId}`);
    historyReceipt.value = row.receiptId;
  } catch (e) {
    error.value = (e as Error).message;
  }
}
function edit(row: Row) {
  selected.value = row;
  newType.value = row.type;
  note.value = '';
}
async function save() {
  if (!selected.value || !note.value.trim() || busy.value || props.readOnly) return;
  busy.value = true;
  error.value = '';
  try {
    await api(
      `/tenders/${props.tenderId}/intake/receipts/${selected.value.receiptId}/classification-decisions`,
      {
        method: 'POST',
        body: JSON.stringify({
          expectedRevision: selected.value.revision,
          action: 'change',
          type: newType.value,
          note: note.value.trim(),
        }),
      },
    );
    selected.value = undefined;
    history.value = undefined;
    await client.invalidateQueries({ queryKey: ['intake', props.tenderId] });
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <section class="content-card purchase-card" aria-label="Единая загрузка документов">
    <h2>Загрузить документы</h2>
    <p>ТЗ, КП и приложения вместе. Тип, поставщик и лот до загрузки не требуются.</p>
    <p>PDF, TXT, XLSX и ограниченные EML. ZIP, MSG и DOCX не поддерживаются. OCR и модель не запускаются.</p>
    <form @submit.prevent="upload">
      <fieldset :disabled="busy || readOnly">
        <label
          >Смешанный комплект<input
            aria-label="Смешанный комплект"
            type="file"
            multiple
            accept=".pdf,.txt,.xlsx,.eml"
            @change="pick"
        /></label>
        <p>До 10 файлов; 20 MiB на файл; 40 MiB на пакет.</p>
        <button class="primary-action" :disabled="!files.length">
          {{ busy ? 'Обработка…' : 'Загрузить пакет' }}
        </button>
        <button v-if="outcomes.length" type="button" class="secondary-action" @click="newIntake">
          Новое поступление тех же файлов
        </button>
      </fieldset>
    </form>
    <p v-if="error" role="alert">{{ error }}</p>
    <ul aria-label="Результаты приёма">
      <li v-for="(o, i) in outcomes" :key="i">
        {{ o.name }} — {{ o.status === 'accepted' ? 'Принят' : 'Отклонён' }}
        {{ o.code ? (rejectionLabels[o.code] ?? 'Файл не прошёл проверку формата или содержимого.') : '' }}
      </li>
    </ul>
    <p v-if="list.isError.value" role="alert">{{ list.error.value?.message }}</p>
    <p v-if="list.isPending.value">Загружаем intake-реестр…</p>
    <p v-if="list.data.value?.length === 0">Пока нет документов в intake-реестре.</p>
    <article
      v-for="row in list.data.value"
      :key="row.receiptId"
      class="intake-document"
      :aria-label="'Документ ' + row.name"
    >
      <h3>{{ row.name }}</h3>
      <p>Приём: принят. Оригинал сохранён без изменения.</p>
      <p>
        Формат: {{ row.mimeType }} · Категория: <strong>{{ types[row.type] }}</strong> · Первоначально:
        {{ types[row.initialType] }}
      </p>
      <p>
        Обработка:
        {{
          row.processingStatus === 'failed'
            ? 'Ошибка чтения'
            : row.processingStatus === 'unsupported'
              ? 'Недостаточно данных для классификации'
              : 'Проверка содержимого завершена'
        }}
        · {{ row.reviewState === 'confirmed' ? 'Тип подтверждён человеком' : 'Тип требует проверки' }}
      </p>
      <p>{{ reasons[row.reason] ?? row.reason }}</p>
      <p>
        Текстовый слой: {{ row.coverage.nativeTextAvailable ? 'прочитан' : 'не получен' }}. OCR: нет. Модель:
        нет.
      </p>
      <p>
        Поступление: {{ new Date(row.receivedAt).toLocaleString('ru-RU') }} · {{ row.receiptId }} · пакет
        {{ row.batchId }}
      </p>
      <details>
        <summary>SHA-256 оригинала</summary>
        {{ row.blobSha256 }}
      </details>
      <a :href="`/api/tenders/${tenderId}/intake/originals/${row.originalId}/download`">Скачать оригинал</a>
      <button type="button" class="secondary-action" :disabled="busy || readOnly" @click="edit(row)">
        Изменить тип
      </button>
      <button type="button" class="secondary-action" @click="showHistory(row)">История и источники</button>
      <div v-if="history && historyReceipt === row.receiptId">
        <p v-for="r in history.revisions" :key="r.id">
          Версия {{ r.revision }}: {{ types[r.type] }} ·
          {{ r.source === 'human' ? 'Решение пользователя' : 'Правила классификации' }} · {{ r.reason }} ·
          {{ r.actorId }} · {{ r.createdAt }}
        </p>
        <blockquote v-for="e in history.evidence" :key="e.id">
          Страница/лист {{ e.page }} {{ e.sheet ?? '' }} {{ e.cellRange ?? '' }}: {{ e.excerpt }}
        </blockquote>
      </div>
    </article>
    <form v-if="selected" @submit.prevent="save">
      <fieldset :disabled="busy || readOnly">
        <legend>Изменить тип: {{ selected.name }}</legend>
        <label
          >Категория<select v-model="newType" aria-label="Новая категория">
            <option v-for="(label, type) in types" :key="type" :value="type">{{ label }}</option>
          </select></label
        >
        <label
          >Основание<input v-model="note" required maxlength="1000" aria-label="Основание изменения типа"
        /></label>
        <button class="primary-action" :disabled="!note.trim()">Сохранить тип</button>
        <button type="button" @click="selected = undefined">Отмена</button>
      </fieldset>
    </form>
  </section>
</template>
<style scoped>
.intake-document {
  padding: 1rem 0;
  border-top: 1px solid var(--border-color, #ddd);
  overflow-wrap: anywhere;
}
fieldset {
  display: grid;
  gap: 0.7rem;
}
button,
a {
  margin: 0.3rem;
}
blockquote {
  overflow-wrap: anywhere;
}
</style>
