<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import { z } from 'zod';
import { api, itemSchema } from './tender-api';
interface Item {
  sourceIndex: number;
  number: number;
  name: string;
  quantity: string | null;
  unit: string | null;
  page: number;
  excerpt: string;
  technicalRequirements: string;
}
interface Group {
  id: string;
  numbers: number[];
  text: string;
  pages: number[];
}
interface Draft {
  runId: string;
  documentId: string;
  status: 'draft' | 'needs_review' | 'needs_ocr' | 'failed' | 'confirmed';
  items: Item[];
  groups: Group[];
  diagnostics: string[];
}
const props = defineProps<{
  tenderId: string;
  documentId: string;
  revision: number;
  compositionConfirmed: boolean;
}>();
const emit = defineEmits<{ replace: [] }>();
const client = useQueryClient();
const base = computed(() => `/tenders/${props.tenderId}/tz/${props.documentId}`);
const query = useQuery({
  queryKey: ['tz-draft', props.documentId],
  queryFn: () => api<Draft | null>(base.value + '/draft'),
  refetchOnWindowFocus: false,
});
const draft = computed(() => query.data.value);
const rows = ref<(Omit<Item, 'quantity' | 'unit'> & { quantity: string; unit: string })[]>([]),
  groups = ref<Group[]>([]);
const editing = ref(false),
  validation = ref(''),
  attempted = ref(false),
  sourcePage = ref<number>(),
  sourceText = ref(''),
  sourceError = ref(''),
  pdfUrl = ref('');
const extraction = useMutation({
  mutationFn: () => api<Draft>(base.value + '/extractions', { method: 'POST' }),
  onSuccess: async (value) => {
    client.setQueryData(['tz-draft', props.documentId], value);
    await client.invalidateQueries({ queryKey: ['specifications', props.tenderId] });
  },
});
watch(
  () => query.data.value,
  (value) => {
    if (value) {
      rows.value = value.items.map((i) => ({ ...i, quantity: i.quantity ?? '', unit: i.unit ?? '' }));
      groups.value = value.groups.map((g) => ({ ...g, numbers: [...g.numbers] }));
      editing.value = false;
    }
    if (value === null && !attempted.value && !props.compositionConfirmed) {
      attempted.value = true;
      extraction.mutate();
    }
  },
  { immediate: true },
);
const confirmation = useMutation({
  mutationFn: (items: unknown[]) =>
    api(base.value + `/extractions/${draft.value!.runId}/confirm`, {
      method: 'POST',
      body: JSON.stringify({ revision: props.revision, items }),
    }),
  onSuccess: async () => {
    client.setQueryData(['tz-draft', props.documentId], { ...draft.value!, status: 'confirmed' });
    await Promise.all([
      client.invalidateQueries({ queryKey: ['tender', props.tenderId] }),
      client.invalidateQueries({ queryKey: ['specifications', props.tenderId] }),
    ]);
  },
});
function confirm() {
  validation.value = '';
  try {
    const items = rows.value.map((row) => ({
      ...itemSchema.parse({
        name: row.name,
        quantity: row.quantity,
        unit: row.unit,
        technicalRequirements: groups.value
          .filter((g) => g.numbers.includes(row.number))
          .map((g) => g.text)
          .join('\n\n'),
      }),
      sourceIndex: row.sourceIndex,
    }));
    if (!items.length) throw new Error('В черновике нет позиций. Введите состав вручную.');
    confirmation.mutate(items);
  } catch (error) {
    validation.value = error instanceof z.ZodError ? error.issues[0].message : (error as Error).message;
    editing.value = true;
  }
}
async function showSource(item: Item) {
  sourceError.value = '';
  sourcePage.value = item.page;
  try {
    const page = await api<{ page: number; text: string }>(base.value + `/source/${item.page}`);
    sourceText.value = page.text;
    if (!pdfUrl.value) {
      const response = await fetch('/api' + base.value + '/original');
      if (!response.ok) throw new Error();
      pdfUrl.value = URL.createObjectURL(
        new Blob([await response.arrayBuffer()], { type: 'application/pdf' }),
      );
    }
  } catch {
    sourceError.value = 'Не удалось открыть источник. Попробуйте скачать оригинал.';
  }
}
onBeforeUnmount(() => {
  if (pdfUrl.value) URL.revokeObjectURL(pdfUrl.value);
});
const diagnosticLabels: Record<string, string> = {
  timeout: 'Превышено время обработки.',
  page_limit: 'PDF содержит больше 30 страниц.',
  text_limit: 'Извлечённый текст превышает лимит.',
  invalid_pdf: 'PDF повреждён или не поддерживается.',
  encrypted_pdf: 'PDF защищён паролем.',
  worker_failed: 'Обработчик PDF завершился с ошибкой.',
  extraction_unavailable: 'Обработка временно недоступна.',
  quantity_requires_review: 'Уточните количество в отмеченных строках.',
  duplicate_number: 'Проверьте повторяющиеся номера позиций.',
  no_recognized_items: 'В тексте не найден поддерживаемый перечень позиций.',
  item_limit_or_empty_name: 'Проверьте число и наименования позиций.',
};
</script>
<template>
  <section class="pdf-draft" aria-label="Черновик ТЗ">
    <p v-if="query.isPending.value">Проверяем черновик ТЗ…</p>
    <p v-if="extraction.isPending.value" role="status">Файл загружен → извлечение текста…</p>
    <p v-if="query.isError.value || extraction.isError.value" role="alert" class="form-error">
      {{ query.error.value?.message || extraction.error.value?.message }}
    </p>
    <template v-if="draft && !extraction.isPending.value">
      <h3>
        {{
          draft.status === 'confirmed'
            ? 'Состав из ТЗ подтверждён'
            : draft.status === 'needs_ocr'
              ? 'Требуется OCR или ручной ввод'
              : draft.status === 'failed'
                ? 'Не удалось обработать PDF'
                : 'Черновик ТЗ готов'
        }}
      </h3>
      <p v-if="draft.status === 'needs_ocr'">
        Извлекаемый текст не найден. Позиции не созданы. Добавьте их вручную или загрузите текстовый PDF.
      </p>
      <p v-else-if="draft.status === 'confirmed'">
        Подтверждённый состав сохранён. Повторная загрузка этого оригинала не меняет позиции.
      </p>
      <template v-else-if="draft.items.length">
        <p>
          Проверьте наименования, количества и технические условия. До подтверждения позиции не входят в
          состав закупки.
        </p>
        <fieldset :disabled="confirmation.isPending.value || compositionConfirmed">
          <legend>Позиции из ТЗ</legend>
          <div v-for="row in rows" :key="row.sourceIndex" class="draft-item">
            <p>
              <strong>№ {{ row.number }}</strong> · Страница {{ row.page }}
            </p>
            <label
              >Наименование<input
                v-model="row.name"
                :readonly="!editing"
                :aria-label="`Черновик позиция ${row.sourceIndex}`"
                maxlength="500"
            /></label>
            <div class="draft-amount">
              <label
                >Количество<input
                  v-model="row.quantity"
                  :readonly="!editing"
                  :aria-label="`Количество из ТЗ ${row.sourceIndex}`"
                  inputmode="decimal"
                  :aria-invalid="!row.quantity" /></label
              ><label
                >Единица<input
                  v-model="row.unit"
                  :readonly="!editing"
                  :aria-label="`Единица из ТЗ ${row.sourceIndex}`"
                  maxlength="40"
              /></label>
            </div>
            <p v-if="!row.quantity || !row.unit" class="form-error">
              Требуется ручное уточнение количества и единицы.
            </p>
            <button type="button" class="text-action source-action" @click="showSource(row)">
              Показать фрагмент PDF · стр. {{ row.page }}
            </button>
          </div>
          <div v-if="groups.length" class="technical-groups">
            <h4>Технические условия по группам</h4>
            <label v-for="group in groups" :key="group.id"
              >Позиции {{ group.numbers.join(', ') }} · страницы {{ group.pages.join(', ')
              }}<textarea
                v-model="group.text"
                :readonly="!editing"
                maxlength="8000"
                :aria-label="`Технические условия ${group.id}`"
                rows="5"
              />
            </label>
          </div>
          <p v-if="validation" role="alert" class="form-error">{{ validation }}</p>
          <div class="form-actions">
            <button type="button" class="secondary-action" @click="editing = true">Исправить</button
            ><button type="button" class="primary-action" @click="confirm">
              {{ confirmation.isPending.value ? 'Сохраняем состав…' : 'Подтвердить состав' }}
            </button>
          </div>
        </fieldset>
      </template>
      <p v-for="code in draft.diagnostics" :key="code" class="form-error">
        {{ diagnosticLabels[code] ?? 'Проверьте результат извлечения вручную.' }}
      </p>
    </template>
    <p v-if="compositionConfirmed && draft?.status !== 'confirmed'">
      Состав закупки уже подтверждён. Новое извлечение не заменяет его.
    </p>
    <p v-if="confirmation.isError.value" role="alert" class="form-error">
      {{ confirmation.error.value?.message }}
    </p>
    <div v-if="!extraction.isPending.value" class="form-actions">
      <button
        v-if="!compositionConfirmed && draft?.status !== 'confirmed'"
        type="button"
        class="secondary-action"
        @click="
          attempted = true;
          extraction.mutate();
        "
      >
        {{ draft ? 'Повторить извлечение' : 'Извлечь текст PDF' }}</button
      ><button type="button" class="secondary-action" @click="emit('replace')">Загрузить другое ТЗ</button>
    </div>
    <aside v-if="sourcePage" class="source-preview" aria-label="Источник PDF">
      <div class="card-heading">
        <h4>Источник · страница {{ sourcePage }}</h4>
        <button class="secondary-action" @click="sourcePage = undefined">Закрыть источник</button>
      </div>
      <p v-if="sourceError" role="alert">{{ sourceError }}</p>
      <iframe
        v-if="pdfUrl"
        :src="`${pdfUrl}#page=${sourcePage}`"
        :title="`Оригинальный PDF, страница ${sourcePage}`"
      />
      <details>
        <summary>Извлечённый текст страницы</summary>
        <pre>{{ sourceText }}</pre>
      </details>
    </aside>
  </section>
</template>
