# Модель данных и API — проект контрактов

Это проект схемы для обсуждения, **не применённая миграция**. Идентификаторы — UUID/ULID согласно выбранным соглашениям репозитория; везде `created_at`, `updated_at`, `created_by`, где применимо `tenant_id`/организация. Финальный DDL — отдельный PR.

## Объекты

| Объект                | Ключевые поля                                                                                                                                                                 | Инвариант                                         |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `Tender`              | id, title, category, owner_id, stage, scope_status, selection_mode                                                                                                            | Может существовать только с названием             |
| `Lot`                 | id, tender_id, name, ordinal                                                                                                                                                  | Один или несколько лотов                          |
| `LotItem`             | id, lot_id, item_name, quantity decimal, unit, tech_requirements                                                                                                              | Ручной ввод или подтверждённый разбор ТЗ          |
| `Supplier`            | id, legal_name, inn nullable, country                                                                                                                                         | Слияние дублей — только управляемо                |
| `TenderSupplier`      | tender_id, supplier_id, contact_status                                                                                                                                        | Одна компания в нескольких тендерах               |
| `Document`            | id, tender_id, supplier_id nullable, filename, media_type, sha256, blob_key, kind, channel, sender_email, status, received_at, stage_id nullable, parent_document_id nullable | Неизменяемое содержимое, хранить оригинал         |
| `DocumentRelation`    | id, from_document_id, to_document_id, relation_type                                                                                                                           | Архив/письмо/приложение/дополнение                |
| `Contact`             | id, supplier_id nullable, tender_id, email, source_document_id, verified                                                                                                      | Email и источник раздельно                        |
| `ExtractionRun`       | id, document_id, model_tag, prompt_version, parser_version, status, timings, error_code                                                                                       | Повторный разбор не затирает результаты           |
| `ExtractedField`      | id, run_id, field_key, raw_value, normalized_value, unit, confidence nullable, evidence_id, status                                                                            | Пропуски и неоднозначность явны                   |
| `EvidenceReference`   | id, document_id, page, bbox nullable, sheet nullable, cell_range nullable, excerpt, sha256                                                                                    | Проверяемый источник каждого значения             |
| `FieldDecision`       | id, extracted_field_id nullable, document_id, field_key, value, source_type, source_note, decided_by, decided_at                                                              | История ручных дополнений (телефон/письмо/другое) |
| `Offer`               | id, tender_id, supplier_id, lot_id, verification_status                                                                                                                       | Идентичность предложения без цены                 |
| `OfferVersion`        | id, offer_id, stage_id nullable, source_document_id, response_status, is_initial, submitted_at, currency, vat_mode                                                            | Первоначальная версия **неизменна**               |
| `OfferItem`           | id, offer_version_id, lot_item_id, unit_price decimal, quantity decimal, currency                                                                                             | Могут быть пропуски и частичные предложения       |
| `CostComponent`       | id, offer_version_id, name, amount decimal, currency, treatment, source                                                                                                       | `add` / `included` / `unknown`                    |
| `TenderStage`         | id, tender_id, kind, ordinal, label, comment, opened_at, closed_at                                                                                                            | Уточнение/этап/переторжка                         |
| `AccreditationReport` | id, tender_supplier_id, document_id, assessed_at, status, source, note                                                                                                        | Без файла нельзя считать проверенным              |
| `DraftMessage`        | id, tender_id, stage_id, supplier_id, to_addresses, subject, body, approval_status                                                                                            | До интеграции — черновик без отправки             |
| `CalculationRun`      | id, tender_id, mode, rules_version, input_revision, produced_at, warnings                                                                                                     | Воспроизводимый расчёт                            |
| `AuditEvent`          | id, actor_id, entity, entity_id, action, at, safe_delta                                                                                                                       | Append-only, без содержимого файлов и секретов    |

## Загрузка и связь документов

Входная операция создаёт `UploadBatch` (id, tender_id, stage_id nullable, total, completed, failed). Каждый файл внутри получает отдельную запись `Document`. Пользователь может загрузить пакет сегодня и второй завтра. Результат связывания с поставщиком имеет статус `candidate / confirmed / unresolved` и причину; уникальный email или имя файла — **кандидат**, а не бесспорная идентичность. Архив — отдельный оригинал + связанные дочерние файлы с контролем безопасности; нельзя бесконтрольно распаковывать пути и вложенные архивы.

Для файлов, распознанных как приложения одного КП, хранить `DocumentRelation`; пользователю показывать одну раскрываемую группу поставщика со всеми документами. Удаление связи/смена поставщика требует аудита, физический оригинал не меняется. Адрес отправителя сохранять только если есть достоверный источник (например, EML From), иначе `null`.

## Состояния проверки

- Документ: `uploaded`, `queued`, `processing`, `extracted`, `needs_review`, `confirmed`, `failed`.
- Поле: `found`, `missing`, `ambiguous`, `manual`, `verified`, `rejected`.
- Аккредитация: `passed`, `conditional`, `pending`, `failed`, `no_conclusion`; отсутствие `AccreditationReport.document_id` → **«Нет проверки»**, красный.
- Новый ответ этапа: `received`, `no_reply`, `withdrawn`; `no_reply` не создаёт новую цену и использует последнее подтверждённое значение для отображения.

## Формулы и проверки

**Позиция:** `price_per_unit × quantity` после нормализации единиц. Использовать Decimal/NUMERIC, не float.

**База лота:** сумма _всех необходимых_ позиций; отсутствие хотя бы одной обязательной цены → `null`/«Неполный лот», а не ноль.

**Сопоставимая стоимость:** базовая сумма + сумма `CostComponent` с `treatment=add`; `included` повторно не добавлять; `unknown` помечать как неуточнённую затрату.

**Скидка этапа:** `(предыдущая подтверждённая сопоставимая база − новая база) / предыдущая база × 100%`, только если обе суммы сопоставимы и знаменатель больше нуля. При отсутствии ответа скидка `0%` как отсутствие изменения, но статус ответа отдельный. При повышении цена скидка отрицательная (не обнулять). **Общая скидка:** относительно первоначальной подтверждённой цены.

**Валюта, НДС, курс:** до утверждения корпоративной методики не объединять сравнение рублёвых/валютных КП и разные НДС-базы в один автоматический рейтинг; курс и дата должны быть явными источниками правил.

## Черновик маршрутов REST (подтвердить в OpenAPI)

| Метод | Маршрут                                     | Результат                                   |
| ----- | ------------------------------------------- | ------------------------------------------- |
| POST  | `/api/tenders`                              | Тендер по названию/ручному составу          |
| GET   | `/api/tenders`, `/api/tenders/:id`          | Список, карточка, права                     |
| PATCH | `/api/tenders/:id/scope`                    | Состав и выбор режима                       |
| POST  | `/api/tenders/:id/tz`                       | Зарегистрировать ТЗ                         |
| POST  | `/api/tenders/:id/uploads`                  | Мультифайловая загрузка пакета с stageId    |
| GET   | `/api/tenders/:id/documents?group=supplier` | Группы, неразобранные документы, приложения |
| PATCH | `/api/documents/:id/association`            | Подтвердить поставщика/канал/email/связь    |
| POST  | `/api/documents/:id/extractions`            | Поставить локальную обработку в очередь     |
| POST  | `/api/offers/:id/field-decisions`           | Подтвердить/дополнить поле с источником     |
| POST  | `/api/offers/:id/cost-components`           | Добавить затраты                            |
| POST  | `/api/tenders/:id/accreditations`           | Отчёт и статус                              |
| POST  | `/api/tenders/:id/stages`                   | Новый этап переписки                        |
| POST  | `/api/stages/:id/responses`                 | Зафиксировать новую версию КП / нет ответа  |
| GET   | `/api/tenders/:id/comparison?mode=lot       | items`                                      | Транспонированная модель, скидки, статусы |
| POST  | `/api/stages/:id/drafts`                    | Сгенерировать **черновик**, без отправки    |

Минимум: авторизация и RBAC на каждой записи; валидация MIME/размера и content-type, пагинация и лимиты, OpenAPI, идемпотентность для пакетов и версий, корреляционные ID; ошибки не должны содержать содержимое документов.
