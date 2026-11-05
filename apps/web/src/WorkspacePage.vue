<script setup lang="ts">
import { RouterLink } from 'vue-router';
import type { Screen } from './navigation';
defineProps<{ screen: Screen }>();
</script>
<template>
  <section class="page-heading">
    <div>
      <p class="eyebrow">
        РАБОЧАЯ ОБЛАСТЬ <span>/ {{ screen.code }}</span>
      </p>
      <h1>{{ screen.title }}</h1>
      <p class="subtitle">{{ screen.subtitle }}</p>
    </div>
    <RouterLink v-if="screen.next" :to="screen.next" class="primary-action"
      ><i class="pi pi-plus" aria-hidden="true" />{{ screen.action }}</RouterLink
    >
  </section>
  <div v-if="screen.code === 'S01'" class="summary-grid" aria-label="Сводка тендеров">
    <div><span>Тендеры в работе</span><strong>—</strong><small>Новые закупки появятся здесь</small></div>
    <div><span>Предложения поставщиков</span><strong>—</strong><small>КП ещё не загружены</small></div>
    <div><span>Требуют внимания</span><strong>—</strong><small>Открытых вопросов пока нет</small></div>
  </div>
  <section class="content-card" :aria-label="screen.title">
    <div class="card-heading">
      <h2>{{ screen.code === 'S01' ? 'Все тендеры' : screen.title }}</h2>
      <span class="subtle-tag">{{ screen.code === '404' ? '404' : 'Нет данных' }}</span>
    </div>
    <div class="empty-state">
      <div class="empty-icon"><i :class="['pi', screen.icon]" aria-hidden="true" /></div>
      <h3>{{ screen.empty }}</h3>
      <p>{{ screen.description }}</p>
      <RouterLink v-if="screen.next" :to="screen.next" class="text-action"
        >{{ screen.action }} <i class="pi pi-arrow-right" aria-hidden="true" /></RouterLink
      ><span v-else class="stage-note">Функциональность готовится к следующему этапу</span>
    </div>
  </section>
</template>
