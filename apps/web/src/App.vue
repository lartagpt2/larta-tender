<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query';
import Button from 'primevue/button';
const health = useQuery({
  queryKey: ['health'],
  queryFn: async () => {
    const response = await fetch('/api/health');
    if (!response.ok) throw new Error('API недоступен');
    return response.json() as Promise<{ status: string }>;
  },
});
</script>
<template>
  <main>
    <p class="eyebrow">ЗАКУПКИ · РАБОЧАЯ ОБЛАСТЬ</p>
    <h1>Тендерная платформа</h1>
    <p>Окружение готово. Приём коммерческих предложений — следующий этап.</p>
    <p role="status">
      API:
      {{
        health.isPending.value ? 'проверка…' : health.isError.value ? 'недоступен' : health.data.value?.status
      }}
    </p>
    <Button label="Проверить соединение" icon="pi pi-refresh" @click="health.refetch()" />
  </main>
</template>
