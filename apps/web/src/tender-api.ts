import { z } from 'zod';
export const itemSchema = z.object({
  name: z.string().trim().min(1, 'Укажите наименование').max(500),
  quantity: z
    .string()
    .transform((v) => v.replace(',', '.'))
    .refine(
      (v) => /^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/.test(v) && /[1-9]/.test(v),
      'Количество должно быть положительным, до 6 знаков после запятой',
    ),
  unit: z.string().trim().min(1, 'Укажите единицу').max(40),
});
export const titleSchema = z
  .string()
  .trim()
  .min(1, 'Введите название тендера')
  .max(300, 'Не более 300 символов');
export type ScopeItem = z.input<typeof itemSchema>;
export interface Tender {
  id: string;
  title: string;
  revision: number;
}
export interface TenderScope extends Tender {
  selectionMode: 'lot' | 'items';
  specificationSkipped: boolean;
  scopeStatus: string;
  items: (ScopeItem & { id: string })[];
}
export interface Specification {
  id: string;
  name: string;
  status: string;
}
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch('/api' + path, {
    ...options,
    headers: {
      ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...options.headers,
    },
  });
  if (!response.ok) {
    const messages: Record<number, string> = {
      400: 'Проверьте поля и формат файла.',
      401: 'Доступ к рабочей среде не настроен.',
      403: 'Недостаточно прав для изменения.',
      404: 'Тендер не найден или недоступен.',
      409: 'Данные изменились. Обновите карточку перед повторным сохранением.',
      413: 'Размер файла превышает 20 МБ.',
      503: 'Доступ к данным пока не настроен.',
    };
    throw new Error(messages[response.status] ?? 'Не удалось выполнить запрос. Попробуйте ещё раз.');
  }
  return response.json() as Promise<T>;
}
export function checkSpecification(file: File): string | undefined {
  if (!/\.(pdf|txt)$/i.test(file.name)) return 'Выберите PDF или TXT.';
  if (file.size === 0 || file.size > 20 * 1024 * 1024) return 'Размер файла должен быть от 1 байта до 20 МБ.';
}
export async function uploadSpecification(id: string, file: File, key: string) {
  const problem = checkSpecification(file);
  if (problem) throw new Error(problem);
  const form = new FormData();
  form.append('file', file);
  return api<Specification>(`/tenders/${id}/tz`, {
    method: 'POST',
    headers: { 'Idempotency-Key': key },
    body: form,
  });
}
