import { api, ApiError, type Tender } from './tender-api';
import type { LifecyclePreview } from './lifecycle-api';
export const ARCHIVE_REASON = 'Архивирование по решению пользователя';
export function archiveBlock(preview: LifecyclePreview, tender: Tender): string {
  if (preview.id !== tender.id || preview.title !== tender.title)
    return 'Состояние тендера изменилось. Обновите информацию';
  if (!preview.canWrite) return 'У вас нет прав на архивирование этого тендера';
  if (preview.held) return 'Архивирование запрещено: тендер защищён';
  if (preview.busy) return 'Тендер сейчас обрабатывается';
  if (preview.state !== 'active') return 'Тендер больше не находится в активном списке';
  if (!preview.allowed.archive) return 'Архивирование этого тендера сейчас недоступно';
  return '';
}
export function archiveError(error: unknown): string {
  const status = error instanceof ApiError ? error.status : undefined;
  if (status === 403 || status === 401) return 'У вас нет прав на архивирование этого тендера';
  if (status === 404) return 'Тендер не найден или недоступен';
  if (status === 409) return 'Состояние тендера изменилось. Обновите информацию';
  if (status !== undefined) return 'Не удалось архивировать тендер. Попробуйте позже';
  return 'Не удалось получить ответ сервера. Проверьте состояние тендера перед повтором';
}
export function loadArchivePreview(id: string) {
  return api<LifecyclePreview>(`/tenders/${id}/lifecycle`, { signal: AbortSignal.timeout(15000) });
}
export function archiveTender(preview: LifecyclePreview) {
  return api<LifecyclePreview>(`/tenders/${preview.id}/lifecycle`, {
    method: 'POST',
    signal: AbortSignal.timeout(15000),
    body: JSON.stringify({
      action: 'archive',
      confirmationId: preview.id,
      confirmationTitle: preview.title,
      previewHash: preview.previewHash,
      reason: ARCHIVE_REASON,
    }),
  });
}
