<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import { useQuery } from '@tanstack/vue-query';
import { api, type Tender } from './tender-api';
import TenderLifecycle from './TenderLifecycle.vue';
import { loadLifecyclePage, type LifecycleState } from './lifecycle-api';
const search = ref(''),
  state = ref<LifecycleState>('active'),
  page = ref(1),
  selected = ref('');
const config = useQuery({
  queryKey: ['lifecycle-config'],
  queryFn: () => api<{ enabled: boolean }>('/tenders/lifecycle/config'),
});
const enabled = computed(() => !!config.data.value?.enabled);
watch([search, state], () => {
  page.value = 1;
  selected.value = '';
});
const query = useQuery({
  queryKey: computed(() => ['tenders', 'lifecycle', enabled.value, state.value, page.value, search.value]),
  enabled: computed(() => config.isSuccess.value),
  queryFn: async () =>
    enabled.value
      ? loadLifecyclePage(state.value, page.value, search.value)
      : { items: await api<Tender[]>('/tenders'), total: 0, page: 1, pageSize: 100 },
});
const tenders = computed(() =>
  enabled.value
    ? (query.data.value?.items ?? [])
    : (query.data.value?.items ?? []).filter((t) =>
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
      <span v-if="enabled" class="subtle-tag">Всего: {{ query.data.value?.total ?? 0 }}</span>
    </div>
    <label v-if="enabled"
      >Состояние<select v-model="state">
        <option value="active">Активные</option>
        <option value="archived">Архив</option>
        <option value="trash">Корзина</option>
      </select></label
    >
    <label class="search-field"
      >Найти тендер<input v-model="search" type="search" placeholder="Поиск по названию"
    /></label>
    <p v-if="config.isPending.value || (config.isSuccess.value && query.isPending.value)" role="status">
      Загружаем тендеры…
    </p>
    <div v-else-if="query.isError.value || config.isError.value" role="alert" class="form-error">
      {{ query.error.value?.message ?? config.error.value?.message
      }}<button
        class="secondary-action"
        @click="
          config.refetch();
          query.refetch();
        "
      >
        Повторить
      </button>
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
        ><button
          v-if="enabled"
          class="secondary-action"
          @click="selected = selected === tender.id ? '' : tender.id"
        >
          Архив / восстановление / корзина</button
        ><TenderLifecycle v-if="selected === tender.id" :tender-id="tender.id" />
      </li>
    </ul>
    <nav v-if="enabled" aria-label="Страницы тендеров">
      <button :disabled="page === 1 || query.isFetching.value" @click="page--">Назад</button
      ><span> Страница {{ page }} </span
      ><button
        :disabled="page * 25 >= (query.data.value?.total ?? 0) || query.isFetching.value"
        @click="page++"
      >
        Далее
      </button>
    </nav>
  </section>
</template>
