<script setup lang="ts">
import type { CommercialFields } from './verification-api';
const fields = defineModel<CommercialFields>({ required: true });
defineProps<{ label: string; readonly?: boolean; itemsMode?: boolean }>();
</script>
<template>
  <fieldset :disabled="readonly" class="commercial-fields">
    <legend>{{ label }}</legend>
    <label v-if="!itemsMode"
      >{{ label }}: цена<input v-model="fields.amount" inputmode="decimal" maxlength="21"
    /></label>
    <p v-else>Итог рассчитывается сервером по всем обязательным позициям.</p>
    <label
      >{{ label }}: валюта<select v-model="fields.currency" :aria-label="`${label}: валюта`">
        <option :value="null">Не указана</option>
        <option value="RUB">RUB</option>
        <option value="USD">USD</option>
        <option value="EUR">EUR</option>
        <option value="CNY">CNY</option>
      </select></label
    >
    <label
      >{{ label }}: НДС<select v-model="fields.vatMode" :aria-label="`${label}: НДС`">
        <option value="unknown">Не уточнён</option>
        <option value="included">Включён</option>
        <option value="excluded">Без НДС</option>
      </select></label
    >
    <label>{{ label }}: оплата<input v-model="fields.paymentTerms" maxlength="1000" /></label>
    <label>{{ label }}: срок поставки<input v-model="fields.deliveryTerms" maxlength="1000" /></label>
    <label
      >{{ label }}: соответствие ТЗ<select
        v-model="fields.compliance"
        :aria-label="`${label}: соответствие ТЗ`"
      >
        <option value="unknown">Не уточнено</option>
        <option value="matches">Соответствует</option>
        <option value="partial">Частично</option>
      </select></label
    >
  </fieldset>
</template>
<style scoped>
.commercial-fields {
  display: grid;
  gap: 0.75rem;
}
label {
  display: grid;
  gap: 0.35rem;
}
</style>
