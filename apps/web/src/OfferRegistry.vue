<script setup lang="ts">
import { computed, ref, watch } from 'vue';
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
  receipts: {
    id: string;
    batchId: string;
    receivedAt: string;
    actorName: string;
    actorId: string;
    source: string;
    stage: string | null;
    supplierName: string | null;
    senderEmail: string | null;
    originalName: string;
    legacy: boolean;
  }[];
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
      archive_handler_not_approved: 'Приём ZIP ожидает согласования ИТ/ИБ',
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
const stages = useQuery({
  queryKey: computed(() => ['offer-stages', props.tenderId]),
  queryFn: () => api<{ id: string; label: string }[]>(`/tenders/${props.tenderId}/offer-stages`),
});
const stageId = ref('');
watch(stageId, () => {
  key.value = crypto.randomUUID();
  outcomes.value = [];
});
const suppliers = useQuery({
  queryKey: computed(() => ['suppliers', props.tenderId]),
  queryFn: () =>
    api<{ id: string; name: string; email: string | null; registrationNumber: string | null }[]>(
      `/tenders/${props.tenderId}/suppliers`,
    ),
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
const creating = ref(false),
  newName = ref(''),
  newRegistration = ref(''),
  newEmail = ref(''),
  newComment = ref('');
const duplicates = computed(() =>
  (suppliers.data.value ?? []).filter(
    (s) =>
      (newName.value.trim() &&
        s.name.trim().toLocaleLowerCase() === newName.value.trim().toLocaleLowerCase()) ||
      (newEmail.value.trim() && s.email?.toLowerCase() === newEmail.value.trim().toLowerCase()) ||
      (newRegistration.value.trim() && s.registrationNumber === newRegistration.value.trim()),
  ),
);
const duplicateAcknowledged = ref(false);
watch([newName, newEmail, newRegistration], () => {
  duplicateAcknowledged.value = false;
});
function createSupplier() {
  creating.value = true;
  newName.value = '';
  newRegistration.value = '';
  newEmail.value = '';
  newComment.value = '';
}
function pick(event: Event) {
  if (busy.value) return;
  files.value = Array.from((event.target as HTMLInputElement).files ?? []);
  key.value = crypto.randomUUID();
  outcomes.value = [];
}
function newIntake() {
  key.value = crypto.randomUUID();
  void upload();
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
      headers: {
        'Idempotency-Key': key.value,
        ...(stageId.value ? { 'X-Tender-Stage-Id': stageId.value } : {}),
      },
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
  creating.value = false;
  supplier.value = doc.supplierId ?? '';
  note.value = '';
  error.value = '';
}
async function save() {
  if (!selected.value || !note.value.trim()) return;
  if (
    creating.value &&
    (!newName.value.trim() || (duplicates.value.length > 0 && !duplicateAcknowledged.value))
  )
    return;
  if (creating.value && (suppliers.isPending.value || suppliers.isError.value)) {
    error.value = 'Дождитесь загрузки списка поставщиков для проверки совпадений.';
    return;
  }
  busy.value = true;
  error.value = '';
  try {
    await api(`/tenders/${props.tenderId}/offers/${selected.value.id}/association`, {
      method: 'PATCH',
      body: JSON.stringify({
        revision: selected.value.revision,
        ...(creating.value
          ? {
              newSupplier: {
                name: newName.value.trim(),
                ...(newRegistration.value.trim() ? { registrationNumber: newRegistration.value.trim() } : {}),
                ...(newEmail.value.trim() ? { email: newEmail.value.trim() } : {}),
                ...(newComment.value.trim() ? { comment: newComment.value.trim() } : {}),
              },
            }
          : { supplierId: supplier.value || null }),
        note: note.value.trim(),
      }),
    });
    selected.value = undefined;
    await Promise.all([
      client.invalidateQueries({ queryKey: ['offers', props.tenderId] }),
      client.invalidateQueries({ queryKey: ['suppliers', props.tenderId] }),
    ]);
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
          До 10 файлов, 20 МБ на файл и 40 МБ на пакет. Приём ZIP ожидает согласования ИТ/ИБ. EML: простой
          MIME с вложениями base64.
        </p>
        <label v-if="stages.data.value?.length"
          >Этап поступления<select v-model="stageId">
            <option value="">Не назначен</option>
            <option v-for="st in stages.data.value" :key="st.id" :value="st.id">{{ st.label }}</option>
          </select></label
        >
        <p v-if="stages.isError.value" role="alert">
          Не удалось загрузить этапы. Можно загрузить файлы без назначения этапа.
        </p>
        <button class="primary-action" :disabled="!files.length">
          {{ busy ? 'Загружаем…' : 'Загрузить КП' }}
        </button>
        <button
          v-if="outcomes.some((o) => o.status === 'stored')"
          type="button"
          class="secondary-action"
          @click="newIntake"
        >
          Новое поступление этих файлов
        </button>
        <p v-if="outcomes.some((o) => o.status === 'stored')">
          «Загрузить КП» повторяет текущую операцию без нового поступления. Для новой отправки тех же файлов
          используйте «Новое поступление этих файлов».
        </p>
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
              {{ doc.parentId ? 'Приложение · ' : '' }}{{ doc.stage ?? 'Этап не назначен' }} · Ожидает
              обработки
            </p>
            <p>
              Заявленный From (личность не проверена): {{ doc.email ?? 'Не указан' }} ·
              {{
                doc.associationStatus === 'confirmed'
                  ? 'Связь подтверждена'
                  : doc.associationStatus === 'candidate'
                    ? 'Предварительная связь — проверьте'
                    : 'Связь не определена'
              }}
            </p>
            <details :aria-label="`История поступлений ${doc.name}`" class="receipt-history">
              <summary>Поступления: {{ doc.receipts.length }}</summary>
              <ul>
                <li v-for="receipt in doc.receipts" :key="receipt.id">
                  <time :datetime="receipt.receivedAt">{{
                    new Date(receipt.receivedAt).toLocaleString('ru-RU')
                  }}</time>
                  · {{ receipt.actorName }}
                  <p>
                    {{ receipt.source === 'email' ? 'Письмо (заявленный From)' : 'Ручная загрузка' }} ·
                    {{ receipt.stage ?? 'Этап не назначен' }} ·
                    {{ receipt.supplierName ?? 'Поставщик при поступлении не определён' }}
                  </p>
                  <p>{{ receipt.originalName }} · From: {{ receipt.senderEmail ?? 'Не указан' }}</p>
                  <p v-if="receipt.legacy">
                    Известное первоначальное поступление; история ранних повторов недоступна.
                  </p>
                </li>
              </ul>
            </details>
          </div>
          <button class="secondary-action" :disabled="busy" @click="edit(doc)">Уточнить</button>
        </li>
      </ul>
    </details>
    <form v-if="selected" @submit.prevent="save">
      <fieldset :disabled="busy">
        <legend>Уточнить поставщика: {{ selected.name }}</legend>
        <label v-if="!creating"
          >Поставщик<select v-model="supplier">
            <option value="">Поставщик не определён</option>
            <option v-for="s in suppliers.data.value" :key="s.id" :value="s.id">{{ s.name }}</option>
          </select></label
        >
        <p v-if="suppliers.isError.value" role="alert">{{ suppliers.error.value?.message }}</p>
        <button v-if="!creating" class="secondary-action" type="button" @click="createSupplier">
          Создать нового поставщика
        </button>
        <template v-else>
          <label>Наименование нового поставщика<input v-model="newName" required maxlength="300" /></label>
          <label>ИНН / регистрационный номер<input v-model="newRegistration" maxlength="64" /></label>
          <label
            >Email нового поставщика (необязательно)<input v-model="newEmail" type="email" maxlength="254"
          /></label>
          <label>Комментарий к поставщику<input v-model="newComment" maxlength="1000" /></label>
          <div v-if="duplicates.length" role="status">
            <p>
              Возможные дубликаты среди поставщиков тендера: {{ duplicates.map((s) => s.name).join(', ') }}.
              Автоматического объединения не будет.
            </p>
            <label
              ><input v-model="duplicateAcknowledged" type="checkbox" />Создать отдельного поставщика,
              несмотря на совпадение</label
            >
          </div>
          <button type="button" class="secondary-action" @click="creating = false">
            Выбрать существующего поставщика
          </button>
        </template>
        <p>Подтверждение изменит связь только этого документа. Оригинал и заявленный From сохранятся.</p>
        <label>Основание<input v-model="note" required maxlength="1000" /></label>
        <button
          class="primary-action"
          :disabled="
            !note.trim() ||
            (creating &&
              (suppliers.isPending.value ||
                suppliers.isError.value ||
                !newName.trim() ||
                (duplicates.length > 0 && !duplicateAcknowledged)))
          "
        >
          {{ creating ? 'Создать и привязать' : 'Подтвердить связь' }}
        </button>
        <button class="secondary-action" type="button" @click="selected = undefined">Отмена</button>
      </fieldset>
    </form>
  </section>
</template>
<style scoped>
.document-list > li {
  align-items: flex-start;
}
.document-list > li > button {
  align-self: flex-start;
}
.receipt-history {
  margin-block: 0.6rem;
}
.receipt-history ul {
  display: block;
  padding-left: 1rem;
}
.receipt-history li {
  display: block;
  border: 0;
}
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
