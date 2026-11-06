<script setup lang="ts">
import { computed, ref } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import { useForm } from 'vee-validate';
import { useMutation, useQueryClient } from '@tanstack/vue-query';
import { z } from 'zod';
import ScopeItemsEditor from './ScopeItemsEditor.vue';
import {
  api,
  checkSpecification,
  itemSchema,
  titleSchema,
  uploadSpecification,
  type ScopeItem,
  type Tender,
} from './tender-api';
const router = useRouter(),
  client = useQueryClient();
const { defineField, errors, handleSubmit } = useForm<{ title: string }>({
  initialValues: { title: '' },
  validationSchema: {
    title: (value: string) => {
      const r = titleSchema.safeParse(value);
      return r.success || r.error.issues[0].message;
    },
  },
});
const [title, titleAttrs] = defineField('title');
const mode = ref<'title' | 'manual' | 'specification'>('title');
const items = ref<ScopeItem[]>([{ name: '', quantity: '1', unit: 'шт.' }]);
const file = ref<File>();
const uploadKey = ref(crypto.randomUUID());
const problem = ref('');
const createdId = ref<string>();
const mutation = useMutation({
  mutationFn: async () => {
    const parsed = titleSchema.parse(title.value);
    let positions: ScopeItem[] | undefined;
    if (mode.value === 'manual')
      positions = z.array(itemSchema).min(1, 'Добавьте хотя бы одну позицию').max(100).parse(items.value);
    if (mode.value === 'specification') {
      if (!file.value) throw new Error('Выберите файл ТЗ.');
      const error = checkSpecification(file.value);
      if (error) throw new Error(error);
    }
    if (!createdId.value) {
      const tender = await api<Tender>('/tenders', {
        method: 'POST',
        body: JSON.stringify({
          title: parsed,
          creationMode: mode.value,
          ...(positions ? { items: positions } : {}),
        }),
      });
      createdId.value = tender.id;
    }
    if (mode.value === 'specification')
      await uploadSpecification(createdId.value, file.value!, uploadKey.value);
    return createdId.value;
  },
  onSuccess: async (id) => {
    await client.invalidateQueries({ queryKey: ['tenders'] });
    await router.push({ path: '/documents', query: { tenderId: id } });
  },
});
const submit = handleSubmit(() => {
  problem.value = '';
  mutation.mutate();
});
const message = computed(() => {
  const error = mutation.error.value;
  return error instanceof z.ZodError ? error.issues[0].message : error?.message;
});
function pick(event: Event) {
  file.value = (event.target as HTMLInputElement).files?.[0];
  uploadKey.value = crypto.randomUUID();
}
</script>
<template>
  <section class="page-heading">
    <div>
      <p class="eyebrow">СОЗДАНИЕ ЗАКУПКИ / S02</p>
      <h1>Новый тендер</h1>
      <p class="subtitle">Начните с названия, состава или технического задания</p>
    </div>
  </section>
  <form class="content-card tender-form" @submit="submit">
    <fieldset :disabled="mutation.isPending.value">
      <legend>Параметры тендера</legend>
      <label
        >Название тендера<input
          v-model="title"
          :readonly="!!createdId"
          v-bind="titleAttrs"
          maxlength="300"
          :aria-invalid="!!errors.title"
          aria-describedby="title-error"
      /></label>
      <p id="title-error" class="form-error">{{ errors.title }}</p>
      <div class="mode-choices" role="group" aria-label="Способ создания">
        <label
          ><input v-model="mode" type="radio" value="title" :disabled="!!createdId" />Только название</label
        >
        <label><input v-model="mode" type="radio" value="manual" :disabled="!!createdId" />Вручную</label>
        <label
          ><input v-model="mode" type="radio" value="specification" :disabled="!!createdId" />Через ТЗ</label
        >
      </div>
      <div v-if="mode === 'manual'">
        <h2>Состав закупки</h2>
        <p>Количество и единицу измерения укажите для каждой позиции.</p>
        <ScopeItemsEditor v-model="items" />
      </div>
      <div v-if="mode === 'specification'" class="upload-panel">
        <label>Файл ТЗ<input type="file" accept=".pdf,.txt" @change="pick" /></label>
        <p>
          PDF или TXT, до 20 МБ. Из текстового PDF подготовим черновик состава. Для сканов потребуется OCR или
          ручной ввод. Позиции подтверждает закупщик.
        </p>
      </div>
      <p v-if="mode === 'title'" class="subtitle">
        Состав и ТЗ можно добавить позже. Отсутствие ТЗ не блокирует работу с КП.
      </p>
      <p v-if="message || problem" role="alert" class="form-error">{{ message || problem }}</p>
      <p v-if="createdId && mutation.isError.value">
        Тендер сохранён, файл пока не загружен.
        <RouterLink :to="`/tenders/${createdId}`" class="text-action">Открыть карточку</RouterLink>
      </p>
      <div class="form-actions">
        <button class="primary-action" type="submit">
          {{
            mutation.isPending.value ? 'Сохраняем…' : createdId ? 'Повторить загрузку ТЗ' : 'Создать тендер'
          }}</button
        ><RouterLink to="/tenders" class="secondary-action">К списку</RouterLink>
      </div>
    </fieldset>
  </form>
</template>
