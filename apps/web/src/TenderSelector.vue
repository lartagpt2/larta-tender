<script setup lang="ts">
import { useRoute, useRouter } from 'vue-router';
import { useQuery } from '@tanstack/vue-query';
import { api, type Tender } from './tender-api';
const route = useRoute(),
  router = useRouter();
defineProps<{ tenderId: string }>();
const tenders = useQuery({ queryKey: ['tenders'], queryFn: () => api<Tender[]>('/tenders') });
function select(event: Event) {
  void router.push({ path: route.path, query: { tenderId: (event.target as HTMLSelectElement).value } });
}
</script>
<template>
  <label class="tender-picker"
    >Тендер<select :value="tenderId" @change="select">
      <option value="">Выберите тендер</option>
      <option v-for="tender in tenders.data.value" :key="tender.id" :value="tender.id">
        {{ tender.title }}
      </option>
    </select></label
  >
  <p v-if="tenders.isError.value" role="alert">{{ tenders.error.value?.message }}</p>
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
.tender-picker {
  display: grid;
  gap: 0.5rem;
  margin-block: 1rem;
  max-width: 48rem;
}
</style>
