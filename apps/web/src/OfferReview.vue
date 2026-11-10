<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from 'vue';
import { useRoute, RouterLink } from 'vue-router';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { api } from './tender-api';
import TenderSelector from './TenderSelector.vue';
import CommercialFieldsEditor from './CommercialFieldsEditor.vue';
import {
  emptyFields,
  normalizedFields,
  decimalInput,
  sourceLabels,
  fieldLabels,
  type VerificationContext,
  type VerifiedItem,
  type VerifiedCost,
} from './verification-api';
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const route = useRoute(),
  client = useQueryClient(),
  id = computed(() => String(route.query.tenderId ?? ''));
const query = useQuery({
  queryKey: computed(() => ['verification', id.value]),
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
  queryFn: () => api<VerificationContext>(`/tenders/${id.value}/verification`),
  enabled: computed(() => !!id.value),
});
const supplierId = ref(''),
  lotId = ref(''),
  documentId = ref(''),
  receiptId = ref(''),
  expectedVersion = ref(0),
  fields = ref(emptyFields()),
  original = ref(emptyFields());
const items = ref<VerifiedItem[]>([]),
  costs = ref<VerifiedCost[]>([]),
  costsEnabled = ref(false),
  sourceType = ref('document'),
  sourceNote = ref(''),
  newQuestion = ref(''),
  resolveIds = ref<string[]>([]),
  contextConfirmed = ref(false),
  busy = ref(false),
  error = ref(''),
  saved = ref(''),
  previewUrl = ref('');
const required = computed(() => query.data.value?.lotItems[lotId.value] ?? []),
  document = computed(() => query.data.value?.documents.find((d) => d.id === documentId.value));
const offer = computed(() =>
  query.data.value?.offers.find((o) => o.supplierId === supplierId.value && o.lotId === lotId.value),
);
const latest = computed(() => offer.value?.versions.filter((v) => v.metadata).at(-1));
let previewGeneration = 0;
function closePreview() {
  previewGeneration++;
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value);
  previewUrl.value = '';
}
onBeforeUnmount(closePreview);
function load() {
  closePreview();
  error.value = '';
  saved.value = '';
  contextConfirmed.value = false;
  sourceNote.value = '';
  sourceType.value = 'document';
  newQuestion.value = '';
  resolveIds.value = [];
  const value = latest.value?.metadata;
  expectedVersion.value = latest.value?.version ?? 0;
  original.value = value ? clone(value.original) : emptyFields();
  fields.value = value ? clone(value.fields) : emptyFields();
  items.value = required.value.map((r) => {
    const old = value?.items.find((i) => i.lotItemId === r.id);
    return old ? { ...old } : { lotItemId: r.id, quantity: r.quantity, unit: r.unit, unitPrice: null };
  });
  costs.value = value ? clone(value.costs) : [];
  costsEnabled.value = value?.costsEnabled ?? false;
  documentId.value = value?.documentId ?? '';
  receiptId.value =
    value && document.value?.receipts.some((r) => r.id === value.receiptId) ? value.receiptId : '';
}
watch([supplierId, lotId], load);
watch(query.data, () => {
  if (!query.data.value) return;
  if (!query.data.value.lots.some((l) => l.id === lotId.value))
    lotId.value = query.data.value.lots[0]?.id ?? '';
  load();
});
watch(id, () => {
  supplierId.value = '';
  lotId.value = '';
  load();
});
function changeDocument() {
  closePreview();
  receiptId.value = document.value?.receipts.length === 1 ? document.value.receipts[0].id : '';
  contextConfirmed.value = false;
}
async function preview() {
  closePreview();
  const generation = previewGeneration;
  try {
    const response = await fetch(`/api/tenders/${id.value}/offers/${documentId.value}/original`);
    if (!response.ok) throw new Error('Не удалось открыть оригинал');
    const content = await response.arrayBuffer();
    if (generation !== previewGeneration) return;
    previewUrl.value = URL.createObjectURL(new Blob([content], { type: 'application/pdf' }));
  } catch (e) {
    error.value = (e as Error).message;
  }
}
async function createLot() {
  if (!query.data.value) return;
  error.value = '';
  busy.value = true;
  try {
    await api(`/tenders/${id.value}/verification/lot`, {
      method: 'POST',
      body: JSON.stringify({ expectedRevision: query.data.value.scope.revision }),
    });
    await client.invalidateQueries({ queryKey: ['verification', id.value] });
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
async function save(intent: 'draft' | 'confirm') {
  error.value = '';
  saved.value = '';
  if (
    !supplierId.value ||
    !lotId.value ||
    !documentId.value ||
    !receiptId.value ||
    !contextConfirmed.value ||
    !sourceNote.value.trim()
  ) {
    error.value = 'Выберите поставщика, лот и поступление, подтвердите контекст и укажите основание.';
    return;
  }
  const current = normalizedFields(fields.value);
  if (
    intent === 'confirm' &&
    (!current.currency ||
      !current.paymentTerms ||
      !current.deliveryTerms ||
      (!required.value.length && !current.amount))
  ) {
    error.value = 'Для подтверждения укажите цену (или позиции), валюту, оплату и срок поставки.';
    return;
  }
  busy.value = true;
  try {
    const result = await api<{ status: string; warnings: { message: string }[] }>(
      `/tenders/${id.value}/verification`,
      {
        method: 'POST',
        body: JSON.stringify({
          supplierId: supplierId.value,
          lotId: lotId.value,
          documentId: documentId.value,
          receiptId: receiptId.value,
          expectedVersion: expectedVersion.value,
          contextConfirmed: true,
          intent,
          fields: current,
          ...(!expectedVersion.value ? { original: normalizedFields(original.value) } : {}),
          items: items.value.map((i) => ({
            ...i,
            quantity: decimalInput(i.quantity) ?? '',
            unitPrice: decimalInput(i.unitPrice),
          })),
          costs: costs.value.map((c) => ({
            ...c,
            amount: decimalInput(c.amount),
            currency: c.currency || null,
          })),
          costsEnabled: costsEnabled.value,
          sourceType: sourceType.value,
          sourceNote: sourceNote.value.trim(),
          newQuestions: newQuestion.value.trim() ? [newQuestion.value.trim()] : [],
          resolveQuestionIds: resolveIds.value,
        }),
      },
    );
    await Promise.all([
      client.invalidateQueries({ queryKey: ['verification', id.value] }),
      client.invalidateQueries({ queryKey: ['comparison', id.value] }),
      client.invalidateQueries({ queryKey: ['tender', id.value] }),
    ]);
    saved.value = result.status === 'confirmed' ? 'Проверено' : 'Есть вопросы / Требует проверки';
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <section class="page-heading">
    <div>
      <p class="eyebrow">ПРОВЕРКА КП / S04</p>
      <h1>Проверка КП</h1>
      <p>Данные подтверждаются отдельно для каждого поставщика и поступления.</p>
    </div>
    <RouterLink v-if="id" :to="`/comparison?tenderId=${id}`" class="secondary-action">К сравнению</RouterLink>
  </section>
  <TenderSelector :tender-id="id" />
  <p v-if="!id">Выберите тендер для проверки КП.</p>
  <p v-else-if="query.isPending.value">Загружаем данные…</p>
  <p v-else-if="query.isError.value" role="alert">{{ query.error.value?.message }}</p>
  <template v-else-if="query.data.value">
    <div v-if="!query.data.value.lots.length" class="content-card purchase-card">
      <p>Для сравнения общей цены КП можно создать лот без позиций. ТЗ не требуется.</p>
      <button type="button" class="secondary-action" :disabled="busy" @click="createLot">
        Создать лот без позиций
      </button>
    </div>
    <p v-if="!query.data.value.suppliers.length" class="content-card purchase-card">
      Сначала создайте поставщика через «Уточнить» в
      <RouterLink :to="`/tenders/${id}`">реестре КП</RouterLink>.
    </p>
    <p v-if="error && !(supplierId && lotId)" role="alert">{{ error }}</p>
    <div class="content-card purchase-card context-form">
      <label
        >Поставщик КП<select v-model="supplierId" aria-label="Поставщик КП" :disabled="busy">
          <option value="">Выберите поставщика</option>
          <option v-for="s in query.data.value.suppliers" :key="s.id" :value="s.id">{{ s.name }}</option>
        </select></label
      ><label
        >Лот КП<select v-model="lotId" aria-label="Лот КП" :disabled="busy">
          <option value="">Выберите лот</option>
          <option v-for="lot in query.data.value.lots" :key="lot.id" :value="lot.id">{{ lot.name }}</option>
        </select></label
      >
    </div>
    <form v-if="supplierId && lotId" @submit.prevent="save('confirm')">
      <fieldset :disabled="busy" class="review-layout">
        <section class="content-card purchase-card">
          <h2>Оригинал и поступление</h2>
          <label
            >Оригинал КП<select v-model="documentId" aria-label="Оригинал КП" @change="changeDocument">
              <option value="">Выберите документ</option>
              <option v-for="d in query.data.value.documents" :key="d.id" :value="d.id">{{ d.name }}</option>
            </select></label
          >
          <label
            >Поступление КП<select
              v-model="receiptId"
              aria-label="Поступление КП"
              @change="contextConfirmed = false"
            >
              <option value="">Выберите поступление</option>
              <option v-for="r in document?.receipts" :key="r.id" :value="r.id">
                {{ r.receivedAt }} · {{ r.supplierName ?? 'Поставщик не определён' }} ·
                {{ r.stage ?? 'Этап не назначен' }} · {{ r.senderEmail ?? 'From не указан' }}
              </option>
            </select></label
          >
          <p>
            Заявленный From не доказывает личность отправителя. Один файл может относиться к разным
            контрагентам.
          </p>
          <label class="check-label"
            ><input v-model="contextConfirmed" type="checkbox" />Подтверждаю поставщика и поступление для этих
            значений</label
          >
          <template v-if="documentId"
            ><a :href="`/api/tenders/${id}/offers/${documentId}/original`">Скачать оригинал КП</a
            ><button
              v-if="document?.name.toLowerCase().endsWith('.pdf')"
              class="secondary-action"
              type="button"
              @click="preview"
            >
              Показать оригинал PDF
            </button></template
          >
          <iframe
            v-if="previewUrl"
            :src="previewUrl"
            title="Оригинал проверяемого КП"
            class="original-preview"
          />
          <p>
            Исходные значения ниже переносятся вручную из документа. Они фиксируются при первом сохранении;
            автоматического распознавания нет.
          </p>
          <CommercialFieldsEditor
            v-model="original"
            label="Исходные значения"
            :readonly="expectedVersion > 0"
          />
        </section>
        <section class="content-card purchase-card">
          <h2>Подтверждаемые значения</h2>
          <p v-if="offer">
            {{ offer.status === 'confirmed' ? 'Проверено' : 'Есть вопросы / Требует проверки' }} · версия
            {{ expectedVersion }}
          </p>
          <CommercialFieldsEditor
            v-model="fields"
            label="Подтверждаемые значения"
            :items-mode="required.length > 0"
          />
          <fieldset v-for="(item, index) in items" :key="item.lotItemId" class="item-review">
            <legend>{{ required[index]?.name }}</legend>
            <label>Количество {{ index + 1 }}<input v-model="item.quantity" inputmode="decimal" /></label
            ><label>Единица {{ index + 1 }}<input v-model="item.unit" maxlength="40" /></label
            ><label
              >Цена за единицу {{ index + 1 }}<input v-model="item.unitPrice" inputmode="decimal"
            /></label>
          </fieldset>
          <label class="check-label"
            ><input v-model="costsEnabled" type="checkbox" />Учитывать дополнительные расходы</label
          >
          <div v-if="costsEnabled">
            <fieldset v-for="(cost, index) in costs" :key="index" class="cost-review">
              <legend>Расход {{ index + 1 }}</legend>
              <label>Вид расхода {{ index + 1 }}<input v-model="cost.name" maxlength="300" /></label
              ><label>Сумма расхода {{ index + 1 }}<input v-model="cost.amount" inputmode="decimal" /></label
              ><label
                >Валюта расхода {{ index + 1
                }}<select v-model="cost.currency" :aria-label="`Валюта расхода ${index + 1}`">
                  <option :value="null">Не указана</option>
                  <option v-for="currency in ['RUB', 'USD', 'EUR', 'CNY']" :key="currency">
                    {{ currency }}
                  </option>
                </select></label
              ><label
                >Учёт расхода {{ index + 1
                }}<select v-model="cost.treatment" :aria-label="`Учёт расхода ${index + 1}`">
                  <option value="unknown">Не уточнено</option>
                  <option value="add">Добавить</option>
                  <option value="included">Включено в цену</option>
                </select></label
              ><button type="button" class="secondary-action" @click="costs.splice(index, 1)">
                Убрать расход {{ index + 1 }}
              </button>
            </fieldset>
            <button
              type="button"
              class="secondary-action"
              :disabled="costs.length >= 20"
              @click="costs.push({ name: '', amount: null, currency: fields.currency, treatment: 'unknown' })"
            >
              Добавить расход
            </button>
          </div>
          <p v-else-if="costs.length">
            Расходы сохранены в версии, учёт выключен. Неизвестные расходы всё равно требуют уточнения.
          </p>
          <ul v-if="offer?.warnings.length" aria-label="Открытые вопросы КП">
            <li v-for="warning in offer.warnings" :key="warning.code">{{ warning.message }}</li>
          </ul>
          <label
            v-for="q in latest?.metadata?.questions.filter((q) => !q.resolved)"
            :key="q.id"
            class="check-label"
            ><input v-model="resolveIds" type="checkbox" :value="q.id" />Разрешить замечание:
            {{ q.text }}</label
          >
          <label>Дополнительный вопрос<input v-model="newQuestion" maxlength="500" /></label>
          <label
            >Источник изменения<select v-model="sourceType" aria-label="Источник изменения">
              <option v-for="(label, value) in sourceLabels" :key="value" :value="value">{{ label }}</option>
            </select></label
          ><label>Комментарий к изменению<input v-model="sourceNote" maxlength="1000" /></label>
          <details v-if="latest?.metadata">
            <summary>Источники подтверждённых полей</summary>
            <dl>
              <template v-for="(source, field) in latest.metadata.sources" :key="field"
                ><dt>{{ fieldLabels[field] ?? field }}</dt>
                <dd>
                  {{ sourceLabels[source.type] }} · {{ source.note }} · {{ source.actorId }} · {{ source.at }}
                </dd></template
              >
            </dl>
          </details>
          <div class="form-actions">
            <button type="button" class="secondary-action" @click="save('draft')">Сохранить черновик</button
            ><button class="primary-action" type="submit">
              {{ busy ? 'Сохраняем…' : 'Сохранить и подтвердить' }}
            </button>
          </div>
          <p v-if="saved" role="status">{{ saved }}</p>
          <p v-if="error" role="alert" class="form-error">{{ error }}</p>
        </section>
      </fieldset>
    </form>
  </template>
</template>
<style scoped>
:deep(fieldset) {
  min-width: 0;
}
:deep(input:not([type='checkbox'])),
:deep(select) {
  font: inherit;
  min-width: 0;
  width: 100%;
  box-sizing: border-box;
  padding: 0.5rem 0.65rem;
  border: 1px solid #b8c8d2;
  border-radius: 0.4rem;
  background: var(--surface-card, #fff);
  color: inherit;
}
:deep(input:disabled),
:deep(select:disabled) {
  background: #f6f8fa;
  color: #667885;
}
.item-review,
.cost-review {
  border: 1px solid #cbd5e1;
  border-radius: 0.5rem;
  padding: 0.75rem;
}
.context-form {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
}
.context-form > label {
  flex: 1;
  min-width: 12rem;
}
.review-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  align-items: start;
  gap: 1.25rem;
  border: 0;
  padding: 0;
  min-width: 0;
}
.purchase-card {
  min-width: 0;
}
.purchase-card > label,
.item-review > label,
.cost-review > label {
  display: grid;
  gap: 0.35rem;
  margin-block: 0.8rem;
}
.purchase-card > .check-label {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.item-review,
.cost-review {
  margin-block: 1rem;
}
.original-preview {
  width: 100%;
  height: 32rem;
  border: 1px solid #cbd5e1;
}
dd {
  overflow-wrap: anywhere;
  margin-left: 0;
  font-size: 0.85rem;
}
input,
select {
  max-width: 100%;
}
@media (max-width: 900px) {
  .review-layout {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
