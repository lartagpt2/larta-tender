<script setup lang="ts">
import { computed, ref } from 'vue';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { api } from './tender-api';
const props = defineProps<{ tenderId: string }>();
interface Doc {
  id: string;
  name: string;
  status: string;
  supplierId: string | null;
  supplierName: string | null;
  email: string | null;
  associationStatus: string;
  revision: number;
  parentId: string | null;
  stage: string | null;
}
interface Outcome {
  name: string;
  status: string;
  code?: string;
  documents: string[];
}
const rejectionMessage = (code?: string) =>
  (
    ({
      archive_handler_not_approved: 'Распаковка ZIP пока недоступна',
      file_size: 'Недопустимый размер файла',
      invalid_filename: 'Недопустимое имя файла',
      type_mismatch: 'Содержимое не соответствует типу файла',
      unsupported_type: 'Тип файла не поддерживается',
      invalid_email: 'Не удалось прочитать EML',
      unsupported_email_headers: 'Заголовки EML не поддерживаются',
      unsupported_email_structure: 'Структура EML пока не поддерживается',
      unsupported_email_attachment: 'Вложение EML пока не поддерживается',
      invalid_base64: 'Вложение EML повреждено',
      nested_container_not_supported: 'Вложенные архивы и письма пока не поддерживаются',
      email_header_limit: 'Слишком большие заголовки письма',
      email_part_limit: 'Превышен лимит частей письма',
      invalid_xlsx_container: 'Структура XLSX повреждена',
      xlsx_container_limit: 'Превышены ограничения XLSX',
      unsafe_xlsx_container: 'XLSX не прошёл проверку безопасности',
    }) as Record<string, string>
  )[code ?? ''] ?? 'Файл не прошёл проверку';
const client = useQueryClient();
const query = useQuery({
  queryKey: computed(() => ['offers', props.tenderId]),
  queryFn: () => api<Doc[]>(`/tenders/${props.tenderId}/offers`),
});
const suppliers = useQuery({
  queryKey: computed(() => ['suppliers', props.tenderId]),
  queryFn: () => api<{ id: string; name: string }[]>(`/tenders/${props.tenderId}/suppliers`),
});
const groups = computed(() => {
  const map = new Map<string, { name: string; docs: Doc[] }>();
  for (const d of query.data.value ?? []) {
    const key = d.supplierId ?? 'unknown';
    if (!map.has(key)) map.set(key, { name: d.supplierName ?? 'Поставщик не определён', docs: [] });
    map.get(key)!.docs.push(d);
  }
  return [...map.entries()];
});
const files = ref<File[]>([]),
  key = ref(crypto.randomUUID()),
  busy = ref(false),
  error = ref(''),
  outcomes = ref<Outcome[]>([]);
const selected = ref<Doc>(),
  supplier = ref(''),
  note = ref('');
function pick(event: Event) {
  if (busy.value) return;
  files.value = Array.from((event.target as HTMLInputElement).files ?? []);
  key.value = crypto.randomUUID();
  outcomes.value = [];
}
async function upload() {
  error.value = '';
  if (!files.value.length) return;
  if (
    files.value.length > 10 ||
    files.value.reduce((a, f) => a + f.size, 0) > 40 * 1024 * 1024 ||
    files.value.some((f) => f.size > 20 * 1024 * 1024)
  ) {
    error.value = 'До 10 файлов, 20 МБ на файл и 40 МБ на пакет.';
    return;
  }
  busy.value = true;
  try {
    const form = new FormData();
    for (const f of files.value) form.append('files', f);
    const r = await api<{ outcomes: Outcome[] }>(`/tenders/${props.tenderId}/offers/batches`, {
      method: 'POST',
      headers: { 'Idempotency-Key': key.value },
      body: form,
    });
    outcomes.value = r.outcomes;
    await client.invalidateQueries({ queryKey: ['offers', props.tenderId] });
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
function edit(doc: Doc) {
  selected.value = doc;
  supplier.value = doc.supplierId ?? '';
  note.value = '';
  error.value = '';
}
async function save() {
  if (!selected.value || !note.value.trim()) return;
  busy.value = true;
  error.value = '';
  try {
    await api(`/tenders/${props.tenderId}/offers/${selected.value.id}/association`, {
      method: 'PATCH',
      body: JSON.stringify({
        revision: selected.value.revision,
        supplierId: supplier.value || null,
        note: note.value.trim(),
      }),
    });
    selected.value = undefined;
    await client.invalidateQueries({ queryKey: ['offers', props.tenderId] });
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <section class="content-card purchase-card" aria-label="Коммерческие предложения">
    <h2>Коммерческие предложения</h2>
    <p>Загрузите КП и приложения вместе. Поставщика можно уточнить после загрузки; ТЗ не обязательно.</p>
    <form class="upload-panel" @submit.prevent="upload">
      <fieldset :disabled="busy">
        <legend>Пакетная загрузка КП</legend>
        <label
          >Файлы КП<input type="file" multiple accept=".pdf,.txt,.xlsx,.eml,.zip" @change="pick"
        /></label>
        <p>
          До 10 файлов, 20 МБ на файл и 40 МБ на пакет. ZIP отклоняется: обработчик не утверждён. EML: простой
          MIME с вложениями base64.
        </p>
        <button class="primary-action" :disabled="!files.length">
          {{ busy ? 'Загружаем…' : 'Загрузить КП' }}
        </button>
      </fieldset>
    </form>
    <p v-if="error" role="alert" class="form-error">{{ error }}</p>
    <ul aria-label="Результаты загрузки">
      <li v-for="(o, i) in outcomes" :key="i">
        {{ o.name }} — {{ o.status === 'stored' ? 'Сохранено' : 'Отклонено'
        }}<span v-if="o.code"> ({{ rejectionMessage(o.code) }})</span>
      </li>
    </ul>
    <p v-if="query.isPending.value">Загружаем реестр…</p>
    <p v-else-if="query.isError.value" role="alert">{{ query.error.value?.message }}</p>
    <p v-else-if="!groups.length">Пока нет загруженных КП.</p>
    <details v-for="[groupId, group] in groups" :key="groupId" open class="offer-group">
      <summary>{{ group.name }} · {{ group.docs.length }} файлов</summary>
      <ul class="document-list">
        <li v-for="doc in group.docs" :key="doc.id">
          <div>
            <a :href="`/api/tenders/${tenderId}/offers/${doc.id}/original`">{{ doc.name }}</a>
            <p>
              {{ doc.parentId ? 'Приложение · ' : '' }}{{ doc.stage ?? 'Первичная загрузка' }} · Ожидает
              обработки
            </p>
            <p>
              Email: {{ doc.email ?? 'Не указан' }} ·
              {{
                doc.associationStatus === 'confirmed'
                  ? 'Связь подтверждена'
                  : doc.associationStatus === 'candidate'
                    ? 'Предварительная связь — проверьте'
                    : 'Связь не определена'
              }}
            </p>
          </div>
          <button class="secondary-action" :disabled="busy" @click="edit(doc)">Уточнить</button>
        </li>
      </ul>
    </details>
    <form v-if="selected" @submit.prevent="save">
      <fieldset :disabled="busy">
        <legend>Уточнить поставщика: {{ selected.name }}</legend>
        <label
          >Поставщик<select v-model="supplier">
            <option value="">Поставщик не определён</option>
            <option v-for="s in suppliers.data.value" :key="s.id" :value="s.id">{{ s.name }}</option>
          </select></label
        >
        <p v-if="suppliers.isError.value" role="alert">{{ suppliers.error.value?.message }}</p>
        <label>Основание<input v-model="note" required maxlength="1000" /></label>
        <button class="primary-action" :disabled="!note.trim()">Подтвердить связь</button>
        <button class="secondary-action" type="button" @click="selected = undefined">Отмена</button>
      </fieldset>
    </form>
  </section>
</template>
<style scoped>
.offer-group {
  padding: 1rem 0;
  border-top: 1px solid var(--border-color, #ddd);
}
summary {
  cursor: pointer;
  font-weight: 600;
}
fieldset {
  display: grid;
  gap: 1rem;
}
label {
  display: grid;
  gap: 0.4rem;
}
p {
  overflow-wrap: anywhere;
}
</style>
