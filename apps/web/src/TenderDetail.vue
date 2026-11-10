<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import { z } from 'zod';
import PdfDraftPanel from './PdfDraftPanel.vue';
import OfferRegistry from './OfferRegistry.vue';
import ScopeItemsEditor from './ScopeItemsEditor.vue';
import {
  api,
  itemSchema,
  uploadSpecification,
  type ScopeItem,
  type TenderScope,
  type Specification,
} from './tender-api';
const route = useRoute(),
  client = useQueryClient();
const id = computed(() => String(route.params.id ?? route.query.tenderId ?? ''));
const query = useQuery({
  queryKey: computed(() => ['tender', id.value]),
  queryFn: () => api<TenderScope>(`/tenders/${id.value}/scope`),
});
const documents = useQuery({
  queryKey: computed(() => ['specifications', id.value]),
  queryFn: () => api<Specification[]>(`/tenders/${id.value}/tz`),
});
const scope = computed(() => query.data.value);
const reopened = ref(false),
  editing = ref(false),
  editError = ref('');
const editItems = ref<ScopeItem[]>([]);
const fileInput = ref<HTMLInputElement>();
function chooseOther() {
  reopened.value = true;
  void nextTick(() => {
    fileInput.value?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    fileInput.value?.focus();
  });
}
function statusLabel(status: string) {
  return (
    (
      {
        uploaded: 'Ожидает обработки',
        processing: 'Извлечение текста',
        needs_review: 'Требуется проверка',
        confirmed: 'Состав подтверждён',
        failed: 'Ошибка обработки',
      } as Record<string, string>
    )[status] ?? 'Ожидает обработки'
  );
}
const file = ref<File>();
const uploadKey = ref(crypto.randomUUID());
const patch = useMutation({
  mutationFn: (change: Record<string, unknown>) =>
    api<TenderScope>(`/tenders/${id.value}/scope`, {
      method: 'PATCH',
      body: JSON.stringify({ revision: scope.value!.revision, ...change }),
    }),
  onSuccess: async (value) => {
    client.setQueryData(['tender', id.value], value);
    editing.value = false;
    await client.invalidateQueries({ queryKey: ['tenders'] });
  },
});
const upload = useMutation({
  mutationFn: () => {
    if (!file.value) throw new Error('Выберите файл ТЗ.');
    return uploadSpecification(id.value, file.value, uploadKey.value);
  },
  onSuccess: async () => {
    file.value = undefined;
    await Promise.all([
      client.invalidateQueries({ queryKey: ['tender', id.value] }),
      client.invalidateQueries({ queryKey: ['specifications', id.value] }),
    ]);
    reopened.value = true;
  },
});
function pick(event: Event) {
  file.value = (event.target as HTMLInputElement).files?.[0];
  uploadKey.value = crypto.randomUUID();
}
function edit() {
  editItems.value = scope.value!.items.map((i) => ({
    name: i.name,
    quantity: i.quantity,
    unit: i.unit,
    technicalRequirements: i.technicalRequirements ?? undefined,
  }));
  editing.value = true;
  editError.value = '';
}
function saveItems() {
  const r = z.array(itemSchema).max(100).safeParse(editItems.value);
  if (!r.success) {
    editError.value = r.error.issues[0].message;
    return;
  }
  editError.value = '';
  patch.mutate({ items: r.data, ...(!r.data.length ? { selectionMode: 'lot' } : {}) });
}
function chooseMode(event: Event) {
  patch.mutate({ selectionMode: (event.target as HTMLSelectElement).value });
}
</script>
<template>
  <p v-if="query.isPending.value" role="status">Загружаем тендер…</p>
  <div v-else-if="query.isError.value" role="alert" class="content-card purchase-card form-error">
    {{ query.error.value?.message }}
    <button class="secondary-action" @click="query.refetch()">Обновить карточку</button>
  </div>
  <template v-else-if="scope">
    <section class="page-heading">
      <div>
        <p class="eyebrow">КАРТОЧКА ЗАКУПКИ / S03</p>
        <h1>{{ scope.title }}</h1>
        <p class="subtitle">Состав, техническое задание и документы</p>
      </div>
      <RouterLink to="/tenders" class="secondary-action">К списку тендеров</RouterLink>
    </section>
    <div v-if="patch.isError.value" role="alert" class="content-card purchase-card form-error">
      {{ patch.error.value?.message }}
      <button class="secondary-action" @click="query.refetch()">Обновить карточку</button>
    </div>
    <section class="content-card purchase-card">
      <div class="card-heading">
        <h2>Состав закупки</h2>
        <button class="secondary-action" :disabled="patch.isPending.value" @click="edit">
          Изменить состав
        </button>
      </div>
      <form v-if="editing" @submit.prevent="saveItems">
        <fieldset :disabled="patch.isPending.value">
          <legend>Позиции закупки</legend>
          <ScopeItemsEditor v-model="editItems" />
          <p v-if="editError" role="alert" class="form-error">{{ editError }}</p>
          <div class="form-actions">
            <button type="submit" class="primary-action">Сохранить состав</button
            ><button type="button" class="secondary-action" @click="editing = false">Отмена</button>
          </div>
        </fieldset>
      </form>
      <div v-else-if="scope.items.length" class="scope-table">
        <table>
          <thead>
            <tr>
              <th>Позиция</th>
              <th>Количество</th>
              <th>Единица</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in scope.items" :key="item.id">
              <td>
                {{ item.name }}
                <details v-if="item.technicalRequirements">
                  <summary>Технические условия</summary>
                  <p class="preserve-text">{{ item.technicalRequirements }}</p>
                </details>
              </td>
              <td>{{ item.quantity }}</td>
              <td>{{ item.unit }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else>Состав пока не задан. Добавьте позиции вручную или загрузите ТЗ.</p>
      <label class="selection-mode"
        >Способ сравнения<select
          :value="scope.selectionMode"
          :disabled="patch.isPending.value"
          @change="chooseMode"
        >
          <option value="lot">По лоту</option>
          <option value="items" :disabled="!scope.items.length">По позициям</option>
        </select></label
      >
      <p v-if="!scope.items.length" class="subtitle">
        Сравнение по позициям недоступно: состав закупки ещё не задан.
      </p>
    </section>
    <section class="content-card purchase-card">
      <div class="card-heading">
        <h2>Техническое задание</h2>
        <span v-if="documents.data.value?.length" class="subtle-tag">ТЗ загружено</span>
      </div>
      <div v-if="scope.specificationSkipped && !reopened" class="compact-specification">
        <p>Загрузка ТЗ пропущена. Работа с КП доступна независимо от ТЗ.</p>
        <button class="secondary-action" @click="reopened = true">Загрузить ТЗ позже</button>
      </div>
      <template v-else>
        <p>
          Загрузите оригинал ТЗ. Из текстового PDF подготовим черновик состава. Для скана потребуется OCR или
          ручной ввод. Подтвердите состав после проверки.
        </p>
        <form class="upload-panel" @submit.prevent="upload.mutate()">
          <fieldset :disabled="upload.isPending.value || patch.isPending.value">
            <legend>Загрузка ТЗ</legend>
            <label>Файл ТЗ<input ref="fileInput" type="file" accept=".pdf,.txt" @change="pick" /></label>
            <p>PDF или TXT, до 20 МБ.</p>
            <div class="form-actions">
              <button class="primary-action" type="submit" :disabled="!file">
                {{ upload.isPending.value ? 'Загружаем…' : 'Загрузить ТЗ' }}</button
              ><button
                class="secondary-action"
                type="button"
                @click="
                  reopened = false;
                  patch.mutate({ specificationSkipped: true });
                "
              >
                Пропустить и свернуть
              </button>
            </div>
          </fieldset>
        </form>
      </template>
      <p v-if="upload.isError.value" role="alert" class="form-error">{{ upload.error.value?.message }}</p>
      <p v-if="documents.isPending.value">Загружаем реестр ТЗ…</p>
      <p v-else-if="documents.isError.value" role="alert" class="form-error">
        {{ documents.error.value?.message }}
      </p>
      <ul v-else class="document-list">
        <li v-for="doc in documents.data.value" :key="doc.id">
          <a
            :href="`/api/tenders/${id}/tz/${doc.id}/original`"
            class="text-action"
            :aria-label="`Скачать оригинал ${doc.name}`"
            >{{ doc.name }}</a
          ><span>{{ statusLabel(doc.status) }}</span>
        </li>
      </ul>
      <template v-for="doc in documents.data.value" :key="`draft-${doc.id}`">
        <PdfDraftPanel
          v-if="/\.pdf$/i.test(doc.name)"
          v-show="!scope.specificationSkipped || reopened"
          :tender-id="id"
          :document-id="doc.id"
          :revision="scope.revision"
          :composition-confirmed="scope.scopeStatus === 'confirmed'"
          @replace="chooseOther"
        />
      </template>
    </section>
    <div class="form-actions">
      <RouterLink :to="`/review?tenderId=${id}`" class="secondary-action">Проверить КП</RouterLink
      ><RouterLink :to="`/comparison?tenderId=${id}`" class="secondary-action"
        >Сравнить предложения</RouterLink
      >
    </div>
    <OfferRegistry :key="id" :tender-id="id" />
  </template>
</template>
