<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter, RouterLink } from 'vue-router';
import { useQuery } from '@tanstack/vue-query';
import { api } from './tender-api';
import TenderSelector from './TenderSelector.vue';
interface Model {
  title: string;
  revision: number;
  lots: { id: string; name: string }[];
  lotId: string | null;
  mode: 'lot' | 'items';
  itemId: string | null;
  items: { id: string; name: string }[];
  columns: { offerId: string; supplierId: string; name: string }[];
  rows: { key: string; label: string; values: string[]; tone?: string }[];
  warnings: string[];
}
const route = useRoute(),
  router = useRouter(),
  id = computed(() => String(route.query.tenderId ?? ''));
const params = computed(() => {
  const p = new URLSearchParams();
  for (const key of ['lotId', 'mode', 'itemId'])
    if (typeof route.query[key] === 'string') p.set(key, route.query[key] as string);
  return p.toString();
});
const query = useQuery({
  queryKey: computed(() => ['comparison', id.value, params.value]),
  queryFn: () => api<Model>(`/tenders/${id.value}/comparison?${params.value}`),
  enabled: computed(() => !!id.value),
});
function choose(key: string, event: Event) {
  const next = { ...route.query, [key]: (event.target as HTMLSelectElement).value };
  if (key !== 'itemId') delete next.itemId;
  if (key === 'lotId') next.mode = 'lot';
  void router.replace({ path: route.path, query: next });
}
</script>
<template>
  <section class="page-heading">
    <div>
      <p class="eyebrow">СРАВНЕНИЕ / S05</p>
      <h1>Сравнение</h1>
      <p>Расчёт на сервере. Данные и источники каждого поставщика показаны отдельно.</p>
    </div>
    <RouterLink v-if="id" :to="`/review?tenderId=${id}`" class="secondary-action">К проверке КП</RouterLink>
  </section>
  <TenderSelector :tender-id="id" />
  <nav v-if="id" class="comparison-controls">
    <RouterLink :to="`/stages?tenderId=${id}`">Коммерческие этапы</RouterLink
    ><RouterLink :to="`/accreditation?tenderId=${id}`">Аккредитация</RouterLink>
  </nav>
  <p v-if="!id">Выберите тендер для сравнения.</p>
  <p v-else-if="query.isPending.value">Рассчитываем сравнение…</p>
  <p v-else-if="query.isError.value" role="alert">{{ query.error.value?.message }}</p>
  <section v-else-if="query.data.value" class="content-card purchase-card">
    <div class="comparison-controls">
      <label
        >Лот сравнения<select
          aria-label="Лот сравнения"
          :value="query.data.value.lotId ?? ''"
          @change="choose('lotId', $event)"
        >
          <option v-for="lot in query.data.value.lots" :key="lot.id" :value="lot.id">{{ lot.name }}</option>
        </select></label
      ><label
        >Режим сравнения<select
          aria-label="Режим сравнения"
          :value="query.data.value.mode"
          @change="choose('mode', $event)"
        >
          <option value="lot">По лоту</option>
          <option value="items" :disabled="!query.data.value.items.length">По позициям</option>
        </select></label
      ><label v-if="query.data.value.mode === 'items'"
        >Позиция сравнения<select
          aria-label="Позиция сравнения"
          :value="query.data.value.itemId ?? ''"
          @change="choose('itemId', $event)"
        >
          <option v-for="item in query.data.value.items" :key="item.id" :value="item.id">
            {{ item.name }}
          </option>
        </select></label
      ><a class="secondary-action" :href="`/api/tenders/${id}/comparison.csv?${params}`">Скачать CSV</a>
    </div>
    <p v-for="warning in query.data.value.warnings" :key="warning" role="alert">{{ warning }}</p>
    <p v-if="!query.data.value.columns.length">
      Нет предложений для сравнения. Сохраните данные в проверке КП.
    </p>
    <div v-else class="comparison-scroll" role="region" aria-label="Сравнительная таблица" tabindex="0">
      <table>
        <caption>
          {{
            query.data.value.title
          }}
          ·
          {{
            query.data.value.mode === 'lot' ? 'По лоту' : 'По позиции'
          }}
          · редакция
          {{
            query.data.value.revision
          }}
        </caption>
        <thead>
          <tr>
            <th scope="col">Показатель</th>
            <th v-for="column in query.data.value.columns" :key="column.offerId" scope="col">
              {{ column.name }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in query.data.value.rows" :key="row.key">
            <th scope="row">{{ row.label }}</th>
            <td
              v-for="(value, index) in row.values"
              :key="index"
              :class="{
                'no-check': row.key === 'accreditation' && value === 'Нет проверки',
                'price-emphasis': ['original', 'current', 'comparable'].includes(row.key),
                'best-price': row.key === 'rank' && value === '1',
              }"
            >
              <details v-if="['source', 'context', 'document'].includes(row.key)">
                <summary>Показать сведения</summary>
                <p>{{ value }}</p>
              </details>
              <template v-else>{{ value }}</template>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <p>
      Технические сохранения КП не являются коммерческими этапами. Строки этапов показывают отдельно
      зафиксированные ответы поставщиков. Исходная цена и история сохранений относятся к лоту; в режиме
      позиций актуальная стоимость относится к выбранной позиции. Неизвестные суммы не считаются нулём. Разные
      валюты и базы НДС не объединяются в общий рейтинг. Расходы лота не распределяются по позициям
      автоматически.
    </p>
  </section>
</template>
<style scoped>
select {
  font: inherit;
  min-width: 0;
  max-width: 100%;
  padding: 0.5rem 0.65rem;
  border: 1px solid #b8c8d2;
  border-radius: 0.4rem;
}
.comparison-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: end;
  gap: 1rem;
  margin-bottom: 1rem;
}
.comparison-controls label {
  display: grid;
  gap: 0.4rem;
  min-width: 10rem;
}
.comparison-scroll {
  max-width: 100%;
  overflow: auto;
}
table {
  border-collapse: collapse;
  width: 100%;
  font-size: 0.9rem;
}
caption {
  text-align: left;
  padding: 0.75rem;
  font-weight: 600;
}
th,
td {
  border: 1px solid #cbd5e1;
  padding: 0.8rem;
  min-width: 13rem;
  vertical-align: top;
  text-align: left;
  overflow-wrap: anywhere;
}
thead th {
  background: var(--surface-100, #e7f3f4);
  color: #15313a;
}
tbody th {
  min-width: 12rem;
  background: var(--surface-50, #f5f8fa);
  color: #15313a;
}
.no-check {
  color: #b91c1c;
  font-weight: 700;
}
.price-emphasis {
  font-weight: 700;
}
.best-price {
  color: #137a5e;
  font-weight: 700;
}
td p {
  white-space: pre-wrap;
  max-width: 32rem;
}
summary {
  cursor: pointer;
}
</style>
