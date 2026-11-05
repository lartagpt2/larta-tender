# Проверки и активация CI

TASK-002 сохраняет существующий npm lockfile и не устанавливает новые Actions, MCP или scanners.

Локальные команды после загрузки tools/enter-workspace.ps1 из корня рабочей области:

```powershell
npm.cmd ci --ignore-scripts
npm.cmd run check
npm.cmd run format:check
npm.cmd run test:e2e
npm.cmd audit --omit=dev
```

`npm ci` нужен только при восстановлении зависимостей; во время TASK-002 он не выполнялся. Браузер Chromium уже установлен в локальном cache/playwright. Для E2E нужны свободные порты 3000 и 5173. Тестовый API не обращается к БД, хранилищу документов или Ollama. Playwright запускает серверы и завершает их после прогона.

Предлагаемый GitHub Actions workflow хранится как неактивный шаблон [ci.github-actions.yml](./ci.github-actions.yml). После согласования ИТ следует закрепить checkout/setup-node по проверенным полным commit SHA, выбрать runner, скопировать шаблон в .github/workflows/ci.yml и включить его отдельным PR. Секреты production/test БД, реальные КП и сетевой адрес корпоративной Ollama не передаются. Только permissions contents:read; pull_request_target не используется. Security audit передаёт npm сведения о пакетах, не исходники. Подключение CodeQL/SAST/secret scanner требует отдельного решения ИТ; их запуск не заявляется выполненным.

При корпоративной сборке требуется разбор имеющихся dev-зависимостей и повторный актуальный CVE audit; прежний отчёт безопасности не является текущей гарантией.
