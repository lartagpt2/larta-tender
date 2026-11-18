import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { repo, save } from '../task008-gate-d/io.mjs';
const d = JSON.parse(await readFile(resolve(repo, 'docs/inventory/TASK-009A/inventory.json'), 'utf8'));
const esc = (s) =>
  String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('|', '\\|')
    .replaceAll('\n', ' ');
const short = {
  'confirmed-test-commercial-data': 'CONF',
  'research-evidence-retention': 'KEEP',
  'currently-shared-portal-tender': 'DEMO',
  'noncanonical-legacy-blob-key': 'LEGACY',
  'active-OCR': 'BUSY',
};
const intro = `# TASK-009A — полный перечень кандидатов на ручное согласование\n\nСнимок ${d.snapshot.at}, БД ${d.database}, транзакция READ ONLY. ${d.candidates.length} строк.\nНи один кандидат не разрешён к удалению. Название/шаблон теста не доказывают отсутствие рабочих данных.\n\nKEEP — сохранить доказательства исследования; DEMO — текущий открытый портал; CONF — подтверждённые тестовые предложения; LEGACY — старый fixture с некорректным storage_key; BUSY — активный OCR. Пустая пометка также требует отдельного согласования.\nДаты UTC (Москва +03:00). Документы и события поступлений считаются отдельно: один документ может иметь несколько поступлений. OCR — уникальные канонические FS jobs; DB extraction_run — отдельный столбец.\n\n[CSV](./candidates.csv) · [JSON с полными счётчиками связей](./inventory.json) · [Отчёт и план](../../../handoffs/TASK-009A.md)\n\n`;
const table = [
  '| ID | Название | Создан UTC | Док. | Поступл. | Offer | Версий | OCR FS | Extraction DB | Аудит | Общих док. | Ограничения |',
  '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
  ...d.candidates.map(
    (t) =>
      `| ${t.id} | ${esc(t.title)} | ${new Date(t.createdAt).toISOString()} | ${t.documents} | ${t.receivedEvents} | ${t.related.offer ?? 0} | ${t.related.offer_version ?? 0} | ${t.ocr.jobs} | ${t.related.extraction_run ?? 0} | ${t.related.audit_event ?? 0} | ${t.sharedDocumentRefs} | ${t.holds.map((h) => short[h] ?? h).join(', ')} |`,
  ),
].join('\n');
const extra =
  '\n\n## Не включены в разрешаемую группу\n\n' +
  d.suspected
    .map(
      (t) =>
        `- ${t.id}: ${esc(t.title)}, ${new Date(t.createdAt).toISOString()}, документов ${t.documents}. Только признак в названии, происхождение не доказано.`,
    )
    .join('\n') +
  '\n' +
  d.protected
    .map((t) => `- ${t.id}: происхождение не классифицировано, защищён; название не включено в экспорт.`)
    .join('\n') +
  '\n';
await save(resolve(repo, 'docs/inventory/TASK-009A/candidates.md'), intro + table + extra);
