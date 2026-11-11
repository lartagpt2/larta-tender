import { suggestArticles } from '@tender/shared';
import { decimalInput } from './verification-api';
type AIField = { value: string | null };
export function aiLineIssue(
  item: Record<string, AIField>,
  row: { unitPrice: string | null; quantity: string; unit: string } | undefined,
  target: { id: string; name: string } | undefined,
  formCurrency: string | null,
  confirmedMatch: boolean,
): string | null {
  if (!row || !target || row.unitPrice !== null)
    return 'Строка уже заполнена или не относится к выбранному лоту.';
  if (
    decimalInput(item.quantity?.value ?? null) !== decimalInput(row.quantity) ||
    item.unit?.value?.trim().toLowerCase().replace(/\.$/, '') !==
      row.unit.trim().toLowerCase().replace(/\.$/, '')
  )
    return 'Количество или единица не совпадает с ТЗ. Уточните вручную; цена не перенесена.';
  if ((item.description?.value ?? '').trim().toLowerCase() !== target.name.trim().toLowerCase()) {
    const candidate = suggestArticles(item.description?.value ?? null, item.sku?.value ?? null, [
      target,
    ]).candidates.some((c) => c.id === target.id);
    if (!confirmedMatch || !candidate)
      return 'Описание отличается от ТЗ. Выберите предложенный артикул и явно подтвердите сопоставление; исходное написание сохраняется.';
  }
  const currency = item.currency?.value;
  if (!currency || !['RUB', 'USD', 'EUR', 'CNY'].includes(currency) || currency !== formCurrency)
    return 'Валюта строки не определена или отличается от валюты формы. Проверьте пару цена + валюта; цена не перенесена.';
  if (!item.unitPrice?.value) return 'Цена не определена.';
  return null;
}
