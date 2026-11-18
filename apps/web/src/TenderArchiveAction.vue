<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import type { Tender } from './tender-api';
import { ApiError } from './tender-api';
import type { LifecyclePreview } from './lifecycle-api';
import { archiveBlock, archiveError, archiveTender, loadArchivePreview } from './archive-api';
const props = defineProps<{ tender: Tender }>();
const emit = defineEmits<{ archived: [title: string] }>();
const client = useQueryClient();
const key = computed(() => ['tender-lifecycle', props.tender.id]);
const status = useQuery({
  queryKey: key,
  queryFn: () => loadArchivePreview(props.tender.id),
  retry: false,
  refetchOnWindowFocus: false,
});
const mutation = useMutation({ mutationFn: archiveTender, retry: false });
const dialog = ref<HTMLDialogElement>();
const cancelButton = ref<HTMLButtonElement>();
const confirmation = ref<LifecyclePreview>();
const preparing = ref(false),
  error = ref(''),
  uncertain = ref(false);
const pending = computed(() => preparing.value || mutation.isPending.value);
const blocked = computed(() =>
  status.data.value ? archiveBlock(status.data.value, props.tender) : 'Проверяем возможность архивирования…',
);
const canConfirm = computed(
  () => !!confirmation.value && !archiveBlock(confirmation.value, props.tender) && !uncertain.value,
);
async function fresh() {
  const preview = await loadArchivePreview(props.tender.id);
  client.setQueryData(key.value, preview);
  return preview;
}
function close() {
  if (pending.value) return;
  dialog.value?.close();
  confirmation.value = undefined;
  // Reconcile a conflict or an uncertain result only by reading the registry.
  if (error.value) void client.invalidateQueries({ queryKey: ['tenders'] });
}
async function open() {
  if (pending.value) return;
  preparing.value = true;
  error.value = '';
  uncertain.value = false;
  try {
    const preview = await fresh();
    const problem = archiveBlock(preview, props.tender);
    if (problem) {
      error.value = problem;
      return;
    }
    confirmation.value = preview;
    await nextTick();
    preparing.value = false;
    await nextTick();
    dialog.value?.showModal();
    cancelButton.value?.focus();
  } catch (e) {
    error.value = archiveError(e);
  } finally {
    preparing.value = false;
  }
}
async function refresh() {
  if (pending.value) return;
  preparing.value = true;
  try {
    confirmation.value = await fresh();
    uncertain.value = false;
    error.value = archiveBlock(confirmation.value, props.tender);
  } catch (e) {
    error.value = archiveError(e);
  } finally {
    preparing.value = false;
  }
}
async function confirm() {
  if (pending.value || !canConfirm.value || !confirmation.value) return;
  preparing.value = true;
  error.value = '';
  try {
    const previous = confirmation.value;
    const preview = await fresh();
    confirmation.value = preview;
    const problem = archiveBlock(preview, props.tender);
    if (problem) {
      error.value = problem;
      return;
    }
    if (preview.previewHash !== previous.previewHash) {
      error.value = 'Состояние тендера изменилось. Обновите информацию';
      return;
    }
    const result = await mutation.mutateAsync(preview);
    if (result.id !== preview.id || result.state !== 'archived') {
      uncertain.value = true;
      error.value = 'Не удалось получить ответ сервера. Проверьте состояние тендера перед повтором';
      return;
    }
    client.setQueryData(key.value, result);
    dialog.value?.close();
    confirmation.value = undefined;
    emit('archived', preview.title);
    await Promise.all([
      client.invalidateQueries({ queryKey: ['tenders'] }),
      client.invalidateQueries({ queryKey: ['tender-lifecycle'] }),
      client.invalidateQueries({ queryKey: ['tender'] }),
    ]);
  } catch (e) {
    error.value = archiveError(e);
    uncertain.value = true;
    if (e instanceof ApiError && e.status === 409) {
      try {
        confirmation.value = await fresh();
        uncertain.value = false;
      } catch {
        /* Keep the conflict visible; closing remains available. */
      }
    }
  } finally {
    preparing.value = false;
  }
}
</script>
<template>
  <div class="archive-action">
    <button
      v-if="!status.data.value || status.data.value.state === 'active'"
      class="secondary-action"
      :disabled="pending || !!blocked || status.isFetching.value"
      :aria-describedby="`archive-help-${tender.id}`"
      @click="open"
    >
      В архив
    </button>
    <p :id="`archive-help-${tender.id}`" class="archive-help">
      {{ status.isError.value ? archiveError(status.error.value) : blocked }}
    </p>
    <button
      v-if="status.isError.value || (status.data.value && blocked)"
      class="secondary-action"
      :disabled="pending || status.isFetching.value"
      @click="status.refetch()"
    >
      Проверить доступность
    </button>
    <p v-if="error && !dialog?.open" role="alert">{{ error }}</p>
    <dialog
      ref="dialog"
      :aria-labelledby="`archive-title-${tender.id}`"
      :aria-describedby="`archive-description-${tender.id}`"
      @cancel.prevent="close"
    >
      <h2 :id="`archive-title-${tender.id}`">Переместить тендер в архив?</h2>
      <p class="archive-name">Тендер: «{{ confirmation?.title }}»</p>
      <p :id="`archive-description-${tender.id}`">
        После архивирования тендер исчезнет из рабочего списка. Его документы и история сохранятся. При
        необходимости тендер можно будет восстановить из архива.
      </p>
      <p v-if="error" role="alert">{{ error }}</p>
      <p v-if="error && confirmation" role="status">
        Текущее состояние:
        {{
          confirmation.state === 'active'
            ? 'Активный'
            : confirmation.state === 'archived'
              ? 'Архив'
              : 'Корзина'
        }}.
        {{ archiveBlock(confirmation, tender) }}
      </p>
      <p v-if="pending" role="status">Проверяем и сохраняем состояние…</p>
      <div class="archive-buttons">
        <button ref="cancelButton" class="secondary-action" autofocus :disabled="pending" @click="close">
          Отмена
        </button>
        <button v-if="uncertain" class="secondary-action" :disabled="pending" @click="refresh">
          Проверить состояние
        </button>
        <button class="primary-action" :disabled="pending || !canConfirm" @click="confirm">
          Да, в архив
        </button>
      </div>
    </dialog>
  </div>
</template>
<style scoped>
.archive-action {
  margin-block: 0.5rem;
}
.archive-help {
  margin-block: 0.35rem;
  font-size: 0.9rem;
}
.archive-help:empty {
  display: none;
}
dialog {
  box-sizing: border-box;
  width: min(30rem, calc(100vw - 2rem));
  max-height: calc(100dvh - 2rem);
  overflow: auto;
  border: 1px solid #8c94a3;
  border-radius: 0.8rem;
  padding: 1.25rem;
  color: CanvasText;
  background: Canvas;
}
dialog::backdrop {
  background: rgb(0 0 0 / 45%);
}
dialog h2 {
  margin-top: 0;
  font-size: 1.3rem;
}
.archive-name {
  overflow-wrap: anywhere;
}
.archive-buttons {
  display: flex;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 0.65rem;
  margin-top: 1rem;
}
button:focus-visible {
  outline: 3px solid #3977bd;
  outline-offset: 3px;
}
</style>
