<script setup lang="ts">
import { computed, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { useQuery } from '@tanstack/vue-query';
import { api, type Tender } from './tender-api';
const search = ref('');
const query = useQuery({ queryKey: ['tenders'], queryFn: () => api<Tender[]>('/tenders') });
const tenders = computed(() =>
  (query.data.value ?? []).filter((t) =>
    t.title.toLocaleLowerCase().includes(search.value.toLocaleLowerCase()),
  ),
);
</script>
<template>
  <section class="page-heading">
    <div>
      <p class="eyebrow">РАБОЧАЯ ОБЛАСТЬ / S01</p>
      <h1>Тендеры</h1>
      <p class="subtitle">Все закупки в одном рабочем пространстве</p>
    </div>
    <RouterLink to="/tenders/new" class="primary-action">Создать тендер</RouterLink>
  </section>
  <section class="content-card purchase-card">
    <div class="card-heading">
      <h2>Все тендеры</h2>
      <span class="subtle-tag">Последние 100</span>
    </div>
    <label class="search-field"
      >Найти тендер<input v-model="search" type="search" placeholder="Поиск по названию"
    /></label>
    <p v-if="query.isPending.value" role="status">Загружаем тендеры…</p>
    <div v-else-if="query.isError.value" role="alert" class="form-error">
      {{ query.error.value?.message }}
      <button class="secondary-action" @click="query.refetch()">Повторить</button>
    </div>
    <div v-else-if="!tenders.length" class="empty-state">
      <h3>{{ search ? 'Ничего не найдено' : 'Здесь появятся ваши тендеры' }}</h3>
      <p>
        {{
          search ? 'Попробуйте другое название.' : 'Создайте закупку по названию, вручную или загрузите ТЗ.'
        }}
      </p>
    </div>
    <ul v-else class="tender-list">
      <li v-for="tender in tenders" :key="tender.id">
        <RouterLink :to="`/tenders/${tender.id}`"
          ><strong>{{ tender.title }}</strong
          ><span>Открыть закупку →</span></RouterLink
        >
      </li>
    </ul>
  </section>
</template>
