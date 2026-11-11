# TASK-008F: воспроизводимость

- [Протокол до запуска](../../tasks/TASK-008F.md).
- [Первоначальная фиксация](../../docs/evaluations/TASK-008F-preregistration.json).
- [Поправка upload до первого inference](../../docs/evaluations/TASK-008F-preregistration-addendum.md).
- [Handoff](../../handoffs/TASK-008F.md).

Из workspace сначала загрузить `tools/enter-workspace.ps1`, затем перейти в репозиторий.

```powershell
node scripts/task008f/metrics.test.mjs --frozen
node --test scripts/task008-gate-d/scoring.test.mjs
node scripts/task008f/verify.mjs
```

Последняя команда пересчитывает все значения из сохранённых jobs, проверяет seal,
исходники, PDF и независимые эталоны; не вызывает модель и не подключается к БД.
Необходимы сохранённые внутри workspace бинарные PDF и jobs. Они намеренно вне Git
согласно AGENTS.md; пути и SHA находятся в manifest/seal. Семантически повторить
генерацию можно исходным генератором в новой согласованной рабочей области, но
метаданные PDF меняют байтовый SHA: нельзя подменять ими зафиксированные PDF.

Команда единственного первичного запуска (уже выполнена; повтор заблокирован claim):

```powershell
$env:PGDATABASE = 'larta_test_task003'
node scripts/task008f/run-v2.mjs --run-synthetic
```

`run.mjs` сохранён как изначально зафиксированный стенд: его первая попытка
остановилась до inference на лимите multipart. Использованный `run-v2.mjs`
загружает 8+5 файлов и проверяет SHA своей доинференсной поправки.
Не удалять claim и не перезаписывать primary/seal ради более удачных метрик.

`analyze.mjs` создаёт отдельную интерпретацию уже sealed primary (также wx).
Новые скрипты анализа/verify не меняют основной оценщик или результаты.
Все документы маркированы синтетическими; все успешные jobs — needs_review.
