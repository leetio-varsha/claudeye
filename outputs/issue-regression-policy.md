## Контекст

73 issues закрыты, но рецидивы повторялись классами: scheduler-runner ломался 4 раза, data-quality 3 раза, schema/migration 4 раза. Причина — фиксы не приходят с regression-тестом, который ломается на исходном баге.

Параллельно с #99 (invariants-mode) хочу зафиксировать политику: **каждый закрытый bug-issue должен иметь регрессионный тест.**

**Категория:** Тестирование / Процесс
**Приоритет:** P1

## Tasks

- [ ] Добавить в CLAUDE.md секцию "Regression policy":
  - PR с фиксом не мерджится без `test/issue-N.test.js` (или дополнения существующего теста), который failed бы на baseline-коде
  - Исключения: docs-only, README, чисто рефакторинг — помечать `regression: skip` в PR title
- [ ] Шаблон тест-файла `test/_template-regression.test.js` с импортами и `describe`/`it`-skeleton
- [ ] Smoke-test для каждой топ-категории рецидивов:
  - `test/regression-schedulers.test.js` — проверяет что все standalone-скрипты в `~/.claudeye/` соответствуют исходникам в `scripts/` (mtime/size diff alert)
  - `test/regression-schema.test.js` — applyMigrations() идемпотентна (запускается дважды без error)
  - `test/regression-tracking.test.js` — после фейк-сессии model/duration/token_input заполняются
  - `test/regression-data-quality.test.js` — git-import не пишет observation с git-commit раз в час по проекту
- [ ] CI gate: если в PR title есть `closes #N` (issue с лейблом `bug`) — required check `regression test referenced` через GH Action
- [ ] Backfill: для каждой из топ-10 закрытых issues проверить наличие регрессионного теста, добавить если нет (отдельный sub-issue)

## Readiness criteria

- ⛔ blocked by: ничего
- 🔓 starts: после #99 начат
- ⏳ blocks: Beta MVP gate (полностью без регрессий 14 дней)

## Definition of done

- [ ] Шаблон + 4 smoke-test файла в `test/`
- [ ] CLAUDE.md и CONTRIBUTING (или README) описывают правило
- [ ] CI Action проверяет правило в PR
- [ ] Backfill открыт как sub-issue
