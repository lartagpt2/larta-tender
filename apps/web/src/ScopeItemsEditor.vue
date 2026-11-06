<script setup lang="ts">
import type { ScopeItem } from './tender-api';
const props = defineProps<{ modelValue: ScopeItem[] }>();
const emit = defineEmits<{ 'update:modelValue': [ScopeItem[]] }>();
function update(index: number, key: keyof ScopeItem, event: Event) {
  emit(
    'update:modelValue',
    props.modelValue.map((item, i) =>
      i === index ? { ...item, [key]: (event.target as HTMLInputElement).value } : item,
    ),
  );
}
</script>
<template>
  <div class="scope-editor">
    <div v-for="(item, index) in modelValue" :key="index" class="position-row">
      <label
        >Позиция {{ index + 1
        }}<input
          :value="item.name"
          :aria-label="`Позиция ${index + 1}`"
          maxlength="500"
          @input="update(index, 'name', $event)"
      /></label>
      <label
        >Количество<input
          :value="item.quantity"
          :aria-label="`Количество ${index + 1}`"
          inputmode="decimal"
          @input="update(index, 'quantity', $event)"
      /></label>
      <label
        >Единица<input
          :value="item.unit"
          :aria-label="`Единица ${index + 1}`"
          maxlength="40"
          @input="update(index, 'unit', $event)"
      /></label>
      <button
        type="button"
        class="secondary-action"
        :aria-label="`Удалить позицию ${index + 1}`"
        @click="
          emit(
            'update:modelValue',
            modelValue.filter((_, i) => i !== index),
          )
        "
      >
        Удалить
      </button>
    </div>
    <button
      type="button"
      class="secondary-action"
      :disabled="modelValue.length >= 100"
      @click="emit('update:modelValue', [...modelValue, { name: '', quantity: '1', unit: 'шт.' }])"
    >
      Добавить позицию
    </button>
  </div>
</template>
