<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { api } from './tender-api';
import {
  classificationLabels,
  dependencyLabels,
  confirmationValid,
  lifecycleLabels,
  type LifecyclePreview,
} from './lifecycle-api';
const emit = defineEmits<{ readOnly: [value: boolean] }>();
const props = defineProps<{ tenderId: string }>(),
  client = useQueryClient();
const config = useQuery({
  queryKey: ['lifecycle-config'],
  queryFn: () => api<{ enabled: boolean }>('/tenders/lifecycle/config'),
});
const preview = ref<LifecyclePreview>(),
  title = ref(''),
  id = ref(''),
  reason = ref(''),
  evidence = ref(''),
  action = ref(''),
  error = ref(''),
  pending = ref(false),
  success = ref('');
const status = useQuery({
  queryKey: computed(() => ['tender-lifecycle', props.tenderId]),
  enabled: computed(() => !!config.data.value?.enabled),
  queryFn: () => api<LifecyclePreview>(`/tenders/${props.tenderId}/lifecycle`),
});
watch(
  [() => config.data.value?.enabled, () => status.data.value, () => status.isError.value],
  () =>
    emit(
      'readOnly',
      !!config.data.value?.enabled &&
        (!status.data.value || status.data.value.state !== 'active' || status.isError.value),
    ),
  { immediate: true },
);
const valid = computed(
  () =>
    !!preview.value &&
    confirmationValid(preview.value, title.value, id.value, reason.value, action.value, evidence.value),
);
watch(
  () => props.tenderId,
  () => {
    preview.value = undefined;
    error.value = '';
    success.value = '';
  },
);
async function inspect() {
  pending.value = true;
  error.value = '';
  success.value = '';
  preview.value = undefined;
  try {
    preview.value = await api<LifecyclePreview>(`/tenders/${props.tenderId}/lifecycle`);
    title.value = '';
    id.value = '';
    reason.value = '';
    evidence.value = '';
    action.value = '';
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    pending.value = false;
  }
}
async function apply() {
  if (!valid.value || !preview.value || pending.value) return;
  const snapshot = preview.value;
  pending.value = true;
  error.value = '';
  try {
    await api(`/tenders/${snapshot.id}/lifecycle`, {
      method: 'POST',
      body: JSON.stringify({
        action: action.value,
        confirmationTitle: title.value,
        confirmationId: id.value,
        previewHash: snapshot.previewHash,
        reason: reason.value,
        evidence: evidence.value,
      }),
    });
    preview.value = undefined;
    success.value = 'Состояние сохранено. Документы, цены и история сохранены.';
    await client.invalidateQueries({ queryKey: ['tenders'] });
    await client.invalidateQueries({ queryKey: ['tender-lifecycle'] });
    await client.invalidateQueries({ queryKey: ['tender'] });
  } catch (e) {
    error.value = (e as Error).message;
    preview.value = undefined;
  } finally {
    pending.value = false;
  }
}
</script>
<template>
  <section v-if="config.data.value?.enabled" class="content-card lifecycle-panel">
    <h2>Архив и корзина</h2>
    <p v-if="status.data.value && status.data.value.state !== 'active'" role="status">
      Архив или корзина: тендер доступен для чтения. Для изменений восстановите его.
    </p>
    <p v-if="status.isError.value" role="alert">
      Не удалось проверить состояние. Изменения временно недоступны.
    </p>
    <button class="secondary-action" :disabled="pending" @click="inspect">
      Проверить состояние и зависимости
    </button>
    <p v-if="error" role="alert">{{ error }} Получите новый предварительный просмотр.</p>
    <p v-if="success" role="status">{{ success }}</p>
    <div v-if="preview">
      <p>
        <strong>{{ preview.title }}</strong> · {{ preview.id }}
      </p>
      <p>
        Состояние:
        {{ preview.state === 'active' ? 'Активный' : preview.state === 'archived' ? 'Архив' : 'Корзина' }}.
        Классификация: {{ classificationLabels[preview.classification] }}.
      </p>
      <p v-if="preview.held" role="status">
        Защитное исключение: исследовательские данные, демо или legacy fixture. Операции заблокированы.
      </p>
      <p v-if="preview.busy" role="status">Есть незавершённое распознавание. Дождитесь завершения.</p>
      <p
        v-if="
          preview.classification === 'synthetic' &&
          (preview.classified_content_revision !== preview.contentRevision ||
            preview.classified_ocr_hash !== preview.ocrHash)
        "
      >
        Данные изменились после классификации: требуется повторная проверка синтетики.
      </p>
      <details>
        <summary>Связанные записи и OCR</summary>
        <dl>
          <template v-for="(count, table) in preview.counts" :key="table"
            ><dt>{{ dependencyLabels[table] ?? 'Связанные записи' }}</dt>
            <dd>{{ count }}</dd></template
          >
        </dl>
        <p>
          Общие бинарные файлы: {{ preview.sharedBlobs }}. Файловые задания OCR:
          {{ preview.ocr.jobs.length }}. Все оригиналы и история сохраняются.
        </p>
      </details>
      <form @submit.prevent="apply">
        <label
          >Действие<select v-model="action" :disabled="pending">
            <option value="">Выберите действие</option>
            <template v-for="(label, key) in lifecycleLabels" :key="key"
              ><option v-if="preview.allowed[key]" :value="key">{{ label }}</option></template
            >
          </select></label
        >
        <label
          >Введите точное название<input
            v-model="title"
            autocomplete="off"
            :disabled="pending"
            maxlength="300"
        /></label>
        <label>Введите ID тендера<input v-model="id" autocomplete="off" :disabled="pending" /></label>
        <label
          >Причина (от 10 символов)<textarea v-model="reason" :disabled="pending" maxlength="2000" />
        </label>
        <label v-if="action === 'classify_synthetic'"
          >Подтверждение происхождения: тест, запуск, ссылка на синтетический источник<textarea
            v-model="evidence"
            :disabled="pending"
            maxlength="4000"
          />
        </label>
        <p>
          Автоматическая классификация по названию не применяется. Помещение в корзину обратимо; файлы и
          связанные записи сохраняются.
        </p>
        <button class="primary-action" :disabled="!valid || pending">Подтвердить операцию</button>
      </form>
    </div>
  </section>
</template>
<style scoped>
.lifecycle-panel {
  margin-block: 1rem;
}
form,
label {
  display: grid;
  gap: 0.5rem;
}
form {
  max-width: 50rem;
  margin-top: 1rem;
}
input,
textarea,
select {
  font: inherit;
  padding: 0.6rem;
}
dl {
  display: grid;
  grid-template-columns: 1fr auto;
  max-width: 40rem;
}
dd {
  margin: 0;
}
</style>
