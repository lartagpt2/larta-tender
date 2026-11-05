# Тендерная платформа

Локальное окружение и каркас готовы: Vue 3/PrimeVue 4, NestJS 11/Fastify 5, TypeScript, npm workspaces, OpenAPI, Vitest, Jest и Playwright. Бизнес-приложение обработки тендеров ещё не реализовано. PostgreSQL и 1С не подключены.

## Запуск

Откройте два терминала PowerShell в рабочей области.

API:

```powershell
. C:\Users\oalimova\ai_project\tools\enter-workspace.ps1
Set-Location C:\Users\oalimova\ai_project\tender-platform
npm.cmd run dev:api
```

Интерфейс во втором терминале:

```powershell
. C:\Users\oalimova\ai_project\tools\enter-workspace.ps1
Set-Location C:\Users\oalimova\ai_project\tender-platform
npm.cmd run dev:web
```

Интерфейс: http://127.0.0.1:5173. Проверка API: http://127.0.0.1:3000/health. Спецификация OpenAPI: http://127.0.0.1:3000/docs-json. Серверы слушают только loopback. Остановка: Ctrl+C в соответствующем терминале.

Также можно запускать `tools/start-platform.ps1 -Component api` и `-Component web` из корня рабочей области. Скрипт меняет переменные только текущего процесса, системный PATH не меняется.

## Восстановление зависимостей и проверки

После загрузки окружения, внутри tender-platform:

```powershell
npm.cmd ci --ignore-scripts
npm.cmd run check
npm.cmd run test:e2e
npm.cmd run format:check
npm.cmd audit --omit=dev
```

Браузер для Playwright уже загружен в cache/playwright внутри рабочей области. При необходимости восстановить: `npx.cmd --no-install playwright install chromium`. Не выполнять install-deps или глобальные установки. Инструменты в tools не требуют системного установщика. Версии npm-пакетов зафиксированы package-lock.json, хеши архивов — tools/artifacts.json в корне рабочей области.

Graphify запускается из корня рабочей области:

```powershell
. .\tools\enter-workspace.ps1
python .\tools\graphify-local.py
```

Обёртка анализирует только код tender-platform, пропускает документы и запрещает сетевые обращения в процессе. Автоустановщик интеграции, глобальный граф и отдельный MCP не используются.

## Что готово и что остаётся

- Этапы 0–2: пути, инструменты, локальный анализ кода, каркас приложений, сборка и проверки окружения.
- Этап 3: подготовлены черновик SQL и файловый адаптер с тестами. Миграция не применялась; PostgreSQL-репозитории не реализованы и не проверены.
- Этапы 4–8: бизнес-сценарии, реальные извлекатели, интерфейс тендеров, корпоративная авторизация и выпуск остаются впереди. Подключения требуют параметров; PDF/DOCX/XLSX — реальных согласованных примеров; расширение интерфейса — согласования макетов.

Все этапы разрешены пользователем, техническая изоляция отложена. Существующий Codex за пределами корня не изменялся. Это локальная среда разработки, не готовое корпоративное развёртывание.

Отчёты: [этап 1](docs/stage-1-status.md), [этап 2](docs/stage-2-status.md), [данные и хранилище](docs/architecture/data-and-storage.md), [аудит окружения](docs/environment-audit.md).
