<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { RouterLink, RouterView, useRoute } from 'vue-router';
import { useQuery } from '@tanstack/vue-query';
import Button from 'primevue/button';
import { screens } from './navigation';
const route = useRoute();
const menuOpen = ref(false);
const menuButton = ref<HTMLButtonElement>();
const sidebar = ref<HTMLElement>();
const theme = ref<'current' | 'larta'>('larta');
const activeTitle = computed(() => screens.find((item) => item.path === route.path)?.title || 'Навигация');
const health = useQuery({
  queryKey: ['health'],
  retry: 1,
  refetchInterval: 60000,
  queryFn: async () => {
    const response = await fetch('/api/health');
    if (!response.ok) throw new Error('API недоступен');
    return response.json() as Promise<{ status: string }>;
  },
});
const connectionLabel = computed(() =>
  health.isPending.value ? 'Проверка соединения' : health.isError.value ? 'API недоступен' : 'API подключён',
);
function closeMenu(restoreFocus = false) {
  menuOpen.value = false;
  if (restoreFocus) void nextTick(() => menuButton.value?.focus());
}
function keydown(event: KeyboardEvent) {
  if (!menuOpen.value) return;
  if (event.key === 'Escape') {
    closeMenu(true);
    return;
  }
  if (event.key === 'Tab') {
    const elements = sidebar.value?.querySelectorAll<HTMLElement>('a, button');
    if (!elements?.length) return;
    const first = elements[0],
      last = elements[elements.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
}
let touchStartX = 0;
function touchStart(event: TouchEvent) {
  touchStartX = event.changedTouches[0].clientX;
}
function touchEnd(event: TouchEvent) {
  if (touchStartX - event.changedTouches[0].clientX > 60) closeMenu(true);
}
watch(menuOpen, async (open) => {
  document.body.style.overflow = open ? 'hidden' : '';
  if (open) {
    await nextTick();
    sidebar.value?.querySelector<HTMLElement>('button')?.focus();
  }
});
watch(
  () => route.path,
  () => {
    if (menuOpen.value) closeMenu(true);
  },
);
onMounted(() => {
  try {
    const saved = localStorage.getItem('larta-theme');
    if (saved === 'current' || saved === 'larta') theme.value = saved;
  } catch {
    /* Browser may deny storage. */
  }
  document.addEventListener('keydown', keydown);
});
watch(theme, (value) => {
  try {
    localStorage.setItem('larta-theme', value);
  } catch {
    /* Theme remains usable in memory. */
  }
});
onBeforeUnmount(() => {
  document.removeEventListener('keydown', keydown);
  document.body.style.overflow = '';
});
</script>
<template>
  <div class="app-shell" :data-theme="theme">
    <a class="skip-link" href="#main">Перейти к содержимому</a>
    <button v-if="menuOpen" class="menu-overlay" aria-label="Закрыть меню по фону" @click="closeMenu(true)" />
    <aside
      id="navigation"
      ref="sidebar"
      class="sidebar"
      :class="{ 'is-open': menuOpen }"
      :role="menuOpen ? 'dialog' : undefined"
      :aria-modal="menuOpen ? true : undefined"
      aria-label="Меню Larta Tender"
      @touchstart="touchStart"
      @touchend="touchEnd"
    >
      <RouterLink to="/tenders" class="brand" aria-label="Larta Tender — тендеры"
        ><span class="brand-mark">L<span>.</span></span
        ><span>LARTA<strong>TENDER</strong></span></RouterLink
      >
      <button class="mobile-close" aria-label="Закрыть меню" @click="closeMenu(true)">
        <i class="pi pi-times" aria-hidden="true" />
      </button>
      <p class="nav-caption">ЗАКУПОЧНЫЙ ЦИКЛ</p>
      <nav aria-label="Основная навигация">
        <RouterLink
          v-for="item in screens"
          :key="item.code"
          :to="item.path"
          class="nav-item"
          exact-active-class="active"
          ><i :class="['pi', item.icon]" aria-hidden="true" /><span>{{ item.title }}</span
          ><small>{{ item.code }}</small></RouterLink
        >
      </nav>
      <div class="sidebar-bottom">
        <div class="workspace-badge">
          <span class="workspace-avatar">LT</span>
          <div><strong>Рабочая среда</strong><small>Локальный контур</small></div>
        </div>
        <p>Основа платформы · 0.1</p>
      </div>
    </aside>
    <div class="workspace" :inert="menuOpen ? true : undefined">
      <header class="topbar">
        <div class="breadcrumbs">
          <button
            ref="menuButton"
            class="menu-toggle"
            aria-label="Открыть меню"
            aria-controls="navigation"
            :aria-expanded="menuOpen"
            @click="menuOpen = true"
          >
            <i class="pi pi-bars" aria-hidden="true" /></button
          ><span>Закупки</span><i class="pi pi-angle-right" aria-hidden="true" /><strong>{{
            activeTitle
          }}</strong>
        </div>
        <div class="topbar-actions">
          <label class="theme-control"
            >Тема<select v-model="theme" aria-label="Тема оформления">
              <option value="larta">Larta</option>
              <option value="current">Current</option>
            </select></label
          ><span class="user-badge" title="Тестовая рабочая область">LT</span>
        </div>
      </header>
      <main id="main" tabindex="-1"><RouterView /></main>
      <footer>
        <span>Решения принимают люди. Платформа помогает сравнивать.</span>
        <div class="connection" :class="{ offline: health.isError.value }">
          <span class="status-dot" /><span role="status">{{ connectionLabel }}</span
          ><Button
            icon="pi pi-refresh"
            text
            rounded
            aria-label="Проверить соединение"
            :loading="health.isFetching.value"
            @click="health.refetch()"
          />
        </div>
      </footer>
    </div>
  </div>
</template>
