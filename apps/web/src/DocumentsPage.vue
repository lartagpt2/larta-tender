<script setup lang="ts">
import { useRoute } from 'vue-router';
import TenderDetail from './TenderDetail.vue';
import WorkspacePage from './WorkspacePage.vue';
import { screens } from './navigation';
const route = useRoute();
const screen = screens.find((s) => s.code === 'S03')!;
</script>
<template>
  <TenderDetail v-if="route.query.tenderId" :key="String(route.query.tenderId)" /><WorkspacePage
    v-else
    :screen="screen"
  />
</template>
