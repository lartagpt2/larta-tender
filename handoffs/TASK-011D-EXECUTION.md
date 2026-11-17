# TASK-011D — EXECUTION

Статус: **PASS — функциональная реализация D в отдельной физической копии; перенос не выполнен.**
Дата: 2026-11-17T13:20:37.258Z. Этап E не начат.

## 1. Проверенная база C

Использована принятая физическая копия C: [source](../../temp/task011c-ce02106a-91ce-4e55-aa02-9aef06591f73/source), а не рабочий портал. Проверены все 225 исходных файлов C, существующий synchronous pipeline, B classifier, C Organizations extractor/resolver, disabled LocalAI adapter, Lifecycle busy и TASK-014 bootstrap. Несовместимости foundation не выявлены. Старый unsupported остаётся читаемым terminal state; новые runs используют предусмотренные шесть состояний.

Основание Git: 71dc375786516602d86a06f3ca1f7a144ea9d3e1; ветка основного проекта: feat/UX-LIFECYCLE-001-archive-dialog. Унаследованные незакоммиченные изменения сохранены. Патч C SHA-256: 90e15521e9857adf2731d60559ce056caf6bfb40d21df0941527b083ecfcba0b. Миграция 005 SHA-256: 600ef2c38c5457685e0dbd57af5f8d4feedefc7094e0c3843c8ec80823972a73.

## 2. Manifest и SHA-256

- [base-manifest.json](../../temp/task011d-74959e1f-318b-4d56-a158-08304a26b7c6/base-manifest.json): SHA-256 4cdfe1f82be1176c3c64725fe24e35847b3ff47d034565df9572fc7805f1644d.
- [final-manifest.json](../../temp/task011d-74959e1f-318b-4d56-a158-08304a26b7c6/final-manifest.json): SHA-256 0499d97938b5d9f05c833c5f625fb37ce19a72ecd9e33529a27e54bd88644e55; полный список 237 файлов и SHA, 18 изменений относительно C, миграции, тестовые БД, provenance и контроль сохранности.
- [TASK-011D.patch](../../temp/task011d-74959e1f-318b-4d56-a158-08304a26b7c6/TASK-011D.patch): SHA-256 **16f9da8279de98ea81d8d8ce0cc1d576ec3f66053bd56695e63d9490bc6332ab**.
- Проверка git apply --check относительно исходной физической базы C: **PASS**. Патч не применялся.

Перед созданием копии и записями проверялись абсолютные пути и существующие компоненты на reparse points. Физическая копия не содержит секретов, реальных документов или исходного storage. Локальные npm workspace links api/web/shared разрешаются внутрь новой копии. Это проверенная изоляция файлов/БД по протоколу TASK-014, не утверждение о системной песочнице ОС.

## 3. Состав изменений

Изменены intake repository/controllers/DTO и точка запуска только новой копии; добавлены policy, SQL queue, worker, contextual proposals, runtime/API/worker scripts, fixtures и integration suite. C resolver переиспользуется, дополнен отдельной worker identity. Bootstrap принимает явные process credentials, проверяет SHA 006 и включает новые таблицы в provenance. Frontend не менялся.

Файлы:
- [apps/api/src/main.ts](../../temp/task011d-74959e1f-318b-4d56-a158-08304a26b7c6/source/apps/api/src/main.ts)
- [apps/api/src/tenders.module.ts](../../temp/task011d-74959e1f-318b-4d56-a158-08304a26b7c6/source/apps/api/src/tenders.module.ts)
- [apps/api/src/unified-intake/context-associations.ts](../../temp/task011d-74959e1f-318b-4d56-a158-08304a26b7c6/source/apps/api/src/unified-intake/context-associations.ts)
- [apps/api/src/unified-intake/intake-repository.ts](../../temp/task011d-74959e1f-318b-4d56-a158-08304a26b7c6/source/apps/api/src/unified-intake/intake-repository.ts)
- [apps/api/src/unified-intake/intake-worker.ts](../../temp/task011d-74959e1f-318b-4d56-a158-08304a26b7c6/source/apps/api/src/unified-intake/intake-worker.ts)
- [apps/api/src/unified-intake/intake.dto.ts](../../temp/task011d-74959e1f-318b-4d56-a158-08304a26b7c6/source/apps/api/src/unified-intake/intake.dto.ts)
- [apps/api/src/unified-intake/organization-resolver.ts](../../temp/task011d-74959e1f-318b-4d56-a158-08304a26b7c6/source/apps/api/src/unified-intake/organization-resolver.ts)
- [apps/api/src/unified-intake/processing-policy.spec.ts](../../temp/task011d-74959e1f-318b-4d56-a158-08304a26b7c6/source/apps/api/src/unified-intake/processing-policy.spec.ts)
- [apps/api/src/unified-intake/processing-policy.ts](../../temp/task011d-74959e1f-318b-4d56-a158-08304a26b7c6/source/apps/api/src/unified-intake/processing-policy.ts)
- [apps/api/src/unified-intake/processing-queue.ts](../../temp/task011d-74959e1f-318b-4d56-a158-08304a26b7c6/source/apps/api/src/unified-intake/processing-queue.ts)
- [docs/TASK-011D-ORCHESTRATION.md](../../temp/task011d-74959e1f-318b-4d56-a158-08304a26b7c6/source/docs/TASK-011D-ORCHESTRATION.md)
- [infra/migrations/006_intake_orchestration.sql](../../temp/task011d-74959e1f-318b-4d56-a158-08304a26b7c6/source/infra/migrations/006_intake_orchestration.sql)
- [scripts/intake-api.mjs](../../temp/task011d-74959e1f-318b-4d56-a158-08304a26b7c6/source/scripts/intake-api.mjs)
- [scripts/intake-worker.mjs](../../temp/task011d-74959e1f-318b-4d56-a158-08304a26b7c6/source/scripts/intake-worker.mjs)
- [scripts/task011d/fixtures.mjs](../../temp/task011d-74959e1f-318b-4d56-a158-08304a26b7c6/source/scripts/task011d/fixtures.mjs)
- [scripts/task011d/integration.mjs](../../temp/task011d-74959e1f-318b-4d56-a158-08304a26b7c6/source/scripts/task011d/integration.mjs)
- [scripts/task011d/runtime.mjs](../../temp/task011d-74959e1f-318b-4d56-a158-08304a26b7c6/source/scripts/task011d/runtime.mjs)
- [scripts/testing/disposable-database.mjs](../../temp/task011d-74959e1f-318b-4d56-a158-08304a26b7c6/source/scripts/testing/disposable-database.mjs)

## 4. Архитектура Worker

HTTP атомарно создаёт accepted receipts/runs/events и возвращает индивидуальные результаты. Отдельный Node Worker опрашивает PostgreSQL, без frontend и без обработки внутри upload request. Изолированный API автоматически запускает отдельный worker; самостоятельный запуск также поддержан. Порядок: eligibility → original SHA/FileStore → B native classification → C native Organizations → C identity resolver → contextual proposals → atomic completed. PostgreSQL является источником состояния.

Явный INTAKE_RUNTIME_CONFIG/путь config обязателен, защищённые порты запрещены. Runtime проверяет UUID DB name/OID/owner/run marker, собственный storage и process PGDATABASE/PGHOST. Main .env fallback отсутствует. Внешний локальный тестовый launcher получает точный credentials-file аргумент и передаёт credentials через окружение, не копируя их в исходники/JSON/логи. Модели не вызываются; model=false.

## 5. SQL

Новая миграция 006: 1293e77a300323aebff5c1d80ed2f28ba6e979548d4a3d260e3510e1123d7310. Номер был свободен. Миграции 001–005 неизменны. Две новые таблицы: intake_processing_operation и intake_processing_checkpoint; всего 55 application tables включая schema_migrations. Существующая очередь расширена полями worker/stage/coverage/retry scheduling/FIFO. Human actor и worker executor разделены. Deferred constraint требует matching event для каждой run revision. Checkpoints/operations append-only; FK/context/UNIQUE/CHECK и archived guards сохранены. C association foundation дополнен отдельной проверкой доказательств document relations; supplier proof guards сохранены. document.purpose и его триггеры не менялись.

## 6. Состояния и coverage

blocked / queued / running / retry_wait / completed / failed. Каждая смена состояния, heartbeat и checkpoint увеличивают state_revision, имеют timestamp/reason/event. GET/list/history/batch показывают processing state/stage/attempts/coverage/update/revision без записи. Classification/organization checkpoint payload имеет schema и canonical SHA. Финальные результаты и resolver promotion публикуются одной транзакцией только после обязательных этапов.

## 7. Lease и heartbeat

Production lease 180 секунд, heartbeat 15 секунд, concurrency 1 по умолчанию, безопасный диапазон 1–2. Короткие интервалы разрешены только NODE_ENV=test. В чтении/парсинге не удерживается SQL transaction. File read 30 секунд, classification native timeout 20 секунд, Organizations 35 секунд, SQL statement/query 15/20 секунд; общий processing deadline 120 секунд прекращает heartbeat и финализацию.

## 8. Fencing

Проверяются worker_id, lease_token, state_revision, актуальная lease expiry, активность тендера, права initiating actor, policy version, source SHA/processing versions и отсутствие final result. Перед commit повторно проверяются policy и срок lease. Потеря heartbeat запрещает promotion. Rejected writes сохраняют безопасную audit diagnostic; archived guard не обходится ради run_event. Постоянный отказ проверки прав переводит job в failed без parsing и без изменения ACL.

## 9. Retry и reprocess

Максимум 3 total attempts. Backoff 2/10/30 секунд; при трёх total attempts используются первые два ожидания. Transient I/O/SQL/timeout повторяются; corrupt/unsupported/permanent не зацикливаются. Исчерпание попыток → failed. История сохраняется. Reprocess требует Idempotency-Key, expectedRunRevision и reason; создаёт generation/retry_of, сохраняя receipt/original/company identity. Same key/body replay возвращает существующую operation; changed payload/stale revision/active job → 409. Blocked job отменяется отдельной авторизованной операцией; оригинал не удаляется.

## 10. Основной сценарий десяти документов

{"documents":10,"runs":10,"completed":9,"failed":1,"preliminaryCompanies":3,"confirmedSuppliers":0}.

Три КП + три паспорта качества + две спецификации + supporting document + один corrupt PDF, реальные synthetic native fixtures. 10 receipts и независимых runs; 9 completed, 1 failed после одной попытки; 3 preliminary companies и 3 quality_for proposals. Buyer/manufacturer не назначаются supplier без supplier proof. supplier/tender_supplier/offer_version/document остаются пустыми. Исходные SHA проверены. Seed результатов/компаний/наблюдений/связей отсутствует — они получены pipeline.

## 11. Crash/restart

Принудительно завершены реальные worker processes после claim, read, classification, Organizations, resolver и commit. SQL checkpoints восстановлены. Незакоммиченный resolver полностью откатывается. После commit нет повторного run/result. Подтверждены отсутствие дублей original/receipt/company/claim/observation. Реальный HTTP API остановлен после enqueue commit до ответа: повтор upload возвращает существующий batch и не создаёт второй run. Дополнительно настоящий HTTP upload обработан worker, автоматически запущенным самим API.

## 12. Stale Worker

Истёкший lease передан Worker B с новым token/revision. Worker A не смог выполнить ни heartbeat, ни финальную запись с действительно подготовленным результатом. Здоровый heartbeat удерживает ownership после начального срока lease; остановленный worker восстанавливается другим. Реальный SQLSTATE 40001 в heartbeat вызывает отказ от финализации; recovered lease даёт один result/company. Policy отозвана после реального parsing/extraction: результат не записан, expired run становится blocked.

## 13. Конкурентная обработка

Два claimers/worker конкурируют за SQL locks; активный lease не присваивается повторно. Параллельный reprocess с одним operation key создаёт ровно одну generation. Реальный SQLSTATE 40001 при resolver promotion откатывает транзакцию и повторяет обработку из checkpoints, без дублей. Retry_wait проверен как busy, max attempts и permanent failures проверены отдельно. Отказ authorization port проверен явным test fault без изменения ACL/capabilities.

## 14. Contextual associations

Поддержаны proposed supplier_of, supports, quality_for, relates_to_specification, contained_in и supersedes на существующей C foundation. Supplier links используют собственное strong evidence receipt. MIME containment физический и сам по себе не даёт supplier proof. Два MIME parents с одинаковым attachment SHA дают один binary original, два самостоятельных receipts и собственные contained_in. Manufacturer-only quality остаётся unassigned. Явные in-tender receipt references дают specification/supersedes proposals; противоречивый non-spec target не используется. Файл/название/email/SHA сами по себе не объединяют компании.

## 15. Lifecycle

Существующий inventory учитывает intake jobs. queued/running/retry_wait/blocked участвуют в busy/allowed/previewHash. Реальные stale preview Archive и Trash запросы возвращают 409. GET не меняет counts/events. Активный job запрещает archive/trash; завершённые/failed не держат busy. Архивный тендер не принимает worker results. Старые AI jobs и protected tenders не изменялись.

## 16. TASK-009D в disposable окружении

Проверены настоящие HTTP Archive → Restore для нового завершённого synthetic tender и restore allowed=false при busy. Существующая C реализация TASK-009D совместима; отдельной правки Lifecycle не потребовалось. Тесты ограничены новыми disposable данными. Дополнительно direct SQL synthetic fault fixture создал состояние archived+running, недостижимое штатным API: worker записал только safe rejection audit, 0 результатов, Restore запрещён до разрешения busy. Эта fault fixture сохранена в тестовой БД, не является штатным workflow. Main/существующие тендеры не архивировались, hold не снимался, ACL/capabilities не переопределялись; reviewer membership создана только как новая disposable fixture.

## 17. TASK-014 и проверки качества

8 isolation tests PASS; fresh UUID name/OID/owner/run marker; SHA всех 6 миграций; provenance реальных записей обеих новых таблиц; guarded parent/child runtime connections. В функциональных тестах main connections=0, model calls=0. Контроль основной БД выполнен отдельно read-only до/после тестов.

- Backend: 214/214, 24 suites.
- Frontend regression: 49/49, 8 files.
- SQL/API/worker/restart/fault/Lifecycle: 12 групп PASS, чистый exit 0; [полные результаты](../../temp/task011d-74959e1f-318b-4d56-a158-08304a26b7c6/temp/integration-runs/010eeff4-5d2a-4261-ae55-56d55c907e8b/task011d-api-results.json).
- TypeScript shared/API/web, build shared/API/web: PASS.
- Changed-file ESLint и Prettier: PASS.
- Global lint: **FAIL — ровно 27 унаследованных no-unreachable**, не исправлялись; [global-eslint.log](../../temp/task011d-74959e1f-318b-4d56-a158-08304a26b7c6/global-eslint.log).
- [quality-results.json](../../temp/task011d-74959e1f-318b-4d56-a158-08304a26b7c6/quality-results.json) содержит exit codes; expected=1 у global-eslint означает ожидаемый известный FAIL, а не global lint PASS.

Промежуточные ошибки harness не скрыты: первый функциональный прогон завершился с ошибкой ожидания повторного exit уже остановленного процесса (READY manifest, не acceptance); следующий прогон отверг лишнее поле Lifecycle DTO (FAILED_RETAINED). Исправлены harness/request; свежие следующие БД прошли. В quality launcher первоначально Vite вызван из неправильного cwd/root (index.html не найден); исправлен явный apps/web root, build повторён. Исправлена также no-unsafe-finally в новом smoke test. Все итоговые обязательные проверки завершены; старые диагностические БД не удалены.

Созданные БД, все сохранены:

| Run ID | БД | OID | Manifest status |
|---|---|---|---|
| 010eeff4-5d2a-4261-ae55-56d55c907e8b | larta_test_run_010eeff45d2a4261ae5556d55c907e8b | 99071 | PASSED_RETAINED |
| 0be2d4af-147f-4e83-a8a8-32206b3e8036 | larta_test_run_0be2d4af147f4e83a8a832206b3e8036 | 96472 | PASSED_RETAINED |
| 4d80171f-f847-4e70-b811-3cc880c0a00b | larta_test_run_4d80171ff8474e70b8113cc880c0a00b | 89230 | READY |
| 60f7de41-d5e1-47dd-8c04-9d0b96e8d44c | larta_test_run_60f7de41d5e147dd8c049d0b96e8d44c | 93860 | PASSED_RETAINED |
| 7e6813a7-d243-4f7c-9ccb-8ddc1be254b7 | larta_test_run_7e6813a7d2434f7c9ccb8ddc1be254b7 | 91645 | FAILED_RETAINED |

Финальный acceptance run: 010eeff4-5d2a-4261-ae55-56d55c907e8b. [run manifest](../../temp/task011d-74959e1f-318b-4d56-a158-08304a26b7c6/temp/integration-runs/010eeff4-5d2a-4261-ae55-56d55c907e8b/manifest.json), [database manifest](../../temp/task011d-74959e1f-318b-4d56-a158-08304a26b7c6/temp/integration-runs/010eeff4-5d2a-4261-ae55-56d55c907e8b/database-manifest.json), [provenance](../../temp/task011d-74959e1f-318b-4d56-a158-08304a26b7c6/temp/integration-runs/010eeff4-5d2a-4261-ae55-56d55c907e8b/provenance.json).

## 18. Сохранность данных

342 исходных файлов main совпадают с начальным SHA, включая основной .env. Все 225 исходников C и patch C неизменны. Main protected snapshot идентичен: 35 таблиц, 700 storage files, Lifecycle 77 active / 133 archived, main API/frontend listeners отсутствуют до/после. Main migrations 001–003 не применялись и не редактировались. Отдельно сопоставлены [protected-before.json](../../temp/task011d-74959e1f-318b-4d56-a158-08304a26b7c6/protected-before.json) и [protected-after.json](../../temp/task011d-74959e1f-318b-4d56-a158-08304a26b7c6/protected-after.json); [main-source-before.json](../../temp/task011d-74959e1f-318b-4d56-a158-08304a26b7c6/main-source-before.json) фиксирует исходники.

В main создан только этот разрешённый handoff. Код, конфигурация, storage, основная PostgreSQL, старые БД B/C не изменялись. DROP DATABASE/physical storage cleanup/merge/publish не выполнялись.

Диагностика final isolated storage: 35 физических файлов, 35 blob rows, 0 файлов без blob row. Диагностических orphan files в финальном прогоне не найдено. Ни один файл не удалялся.

## 19. Известные ограничения

D разрешает только disabled/synthetic с явным SHA manifest; approved_corpus/Document AI/LLM отключены. Интерфейс этапа E не реализован. Specification association требует уже классифицированный target и явное receipt reference; если target ещё не классифицирован, потребуется explicit reprocess referencing receipt, deferred reconciliation пока нет. Автоматическое подтверждение business company/link/prices отсутствует. Blocked jobs требуют явного решения пользователя; invalid archived+busy fault fixture намеренно не ремонтируется автоматически. Blob write до SQL rollback потенциально оставляет диагностический orphan; cleanup не выполняется. Первый прерванный harness сохранил READY manifest без финального экспорта, поэтому не используется как acceptance. Global lint имеет указанный унаследованный FAIL. Установка службы/production deployment не выполнялись.

## 20. Итог

**PASS для изолированного TASK-011D**: durable enqueue, автоматический отдельный Worker, checkpoint recovery, lease/heartbeat/fencing, bounded retry, idempotent reprocess, contextual proposals, Lifecycle и сохранность основного контура подтверждены. Патч D однозначно применим к проверенной базе C. Перенос в рабочий портал и этап E не выполнялись. Остановка для приёмки владельцем.
