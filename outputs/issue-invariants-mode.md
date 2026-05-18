## Контекст

Ежедневный аналайзер сейчас работает в open-ended режиме: «найди проблемы в Claudeye». На дистанции 6 недель это дало хорошую очистку (W13: 25 issues → W18: 1), но шум на дневном масштабе остаётся: каждая прогонка изобретает новые баги, а **рецидивные категории** (data quality 18, scheduler/runner 14, schema/migration 4, tracking gap 4) повторялись по 3–4 раза каждая.

**Идея:** сменить режим аналайзера с «найди что-нибудь» на «проверь конечный список инвариантов». Когда все green N дней подряд — Claudeye стабилен и готов к Beta MVP.

**Категория:** Архитектура / Тестирование
**Приоритет:** P0 (это путь к стабильности)

## Чеклист инвариантов

Каждый инвариант должен быть автоматически проверяемым через SQL/grep over `~/.claudeye/`. При нарушении аналайзер создаёт issue по шаблону `observation → why → proposal → code_draft`.

### Schedulers / runners

- [ ] **SCHED-1** Все scheduled tasks отметились в heartbeat в последние 24 часа
  - check: `grep "$(date -u +%Y-%m-%d)" ~/.claudeye/logs/insights-heartbeat.log` содержит `[insights]` finish
  - rationale: #82, #65, #79 — все сломались молча

- [ ] **SCHED-2** Behavioral advisor отрабатывал в последний понедельник
  - check: `MAX(advises.created_at)` ≥ last Monday 00:00
  - rationale: #87 — exit=1 12 дней не замечали

- [ ] **SCHED-3** Weekly digest не старше 7 дней
  - check: `MAX(digests.created_at)` ≥ now - 7d
  - rationale: #65, #79

### Data quality

- [ ] **DATA-1** ≤10% observations git-commit в последние 7 дней
  - check: `git-commit / total < 0.1`
  - rationale: #67 (50%), #51 (80%) — заглушает hook-данные

- [ ] **DATA-2** ≥80% sessions последних 7d имеют friction_score > 0
  - check: `sessions WHERE friction_score > 0 / total >= 0.8`
  - rationale: #68, #78

- [ ] **DATA-3** Embedding coverage эффективная ≥95%
  - check: `claudeye health` → effective coverage
  - rationale: #75, #98

- [ ] **DATA-4** Cowork import noise filter активен — `tags LIKE '%cowork-noise%'` ≤5% от cowork imports
  - rationale: #93

### Tracking gaps

- [ ] **TRACK-1** ≥99% sessions последних 7d имеют `model IS NOT NULL`
  - rationale: #81 — model был NULL для 2297/2300

- [ ] **TRACK-2** ≥99% sessions имеют `duration_ms > 0` и `token_input > 0`
  - rationale: #81

- [ ] **TRACK-3** Decision rationale пишется хотя бы для одной сессии в неделю
  - check: `COUNT(*) FROM observations WHERE decision_rationale IS NOT NULL AND created_at >= now - 7d` ≥ 1
  - rationale: #80

### Schema / migration

- [ ] **SCHEMA-1** Все таблицы из migrate() существуют после ALTER без повторной ошибки
  - check: на старте `claudeye health` миграции применяются без error log
  - rationale: #45, #54

- [ ] **SCHEMA-2** `analytics-cli` подключён в cli.js (smoke-test: `claudeye advise --help` exit=0)
  - rationale: #43

### Infra / perf

- [ ] **INFRA-1** mem.db ≤ 150MB
  - rationale: #74, #76; auto-compact threshold = 150MB

- [ ] **INFRA-2** hook_errors последних 7 дней ≤ 20
  - rationale: #89; уже работает

- [ ] **INFRA-3** Session closure ≥99%
  - rationale: #60

- [ ] **INFRA-4** Injection p95 ≤ 1500 tokens
  - rationale: #90, #91

### Security

- [ ] **SEC-1** `claudeye viewer` слушает только при ручном запуске; нет постоянно открытого порта
  - rationale: vs claude-mem positioning, README

- [ ] **SEC-2** settings.json mode 0600
  - rationale: уже есть, держим в инвариантах

## Новый промпт claudeye-analyzer (Cowork scheduled task)

Заменить open-ended формулировку на:

```
Ты — invariants-mode advisor для Claudeye. Тебе передан JSON со статусом инвариантов из чеклиста выше.

Для КАЖДОГО нарушенного инварианта верни ровно один объект:
{
  "invariant_id": "SCHED-1",
  "observation": "1-2 предложения: что наблюдается в данных",
  "why":         "1-2 предложения: какое влияние на пользователя/систему",
  "proposal":    "Конкретный hook/script/CLI-команда/файл",
  "code_draft":  "Минимальный рабочий патч или CLI",
  "confidence":  "low|medium|high"
}

ЕСЛИ все green — верни {"all_green": true, "checked": N}.
НЕ выдумывай находки сверх чеклиста. НЕ создавай issues для категорий, не входящих в инварианты.
```

## Tasks

- [ ] Добавить `claudeye invariants` CLI: проходит чеклист, возвращает JSON со статусом каждого инварианта (green/red + supporting numbers)
- [ ] `scripts/invariants-runner.mjs` — standalone версия для launchd (паттерн как в #82, #65, #87)
- [ ] Вызвать из claudeye-analyzer Cowork task с новым промптом
- [ ] Метрика стабильности: новый view `claudeye stability` показывает streak дней с all-green
- [ ] При всех green 14 дней подряд — выводить «MVP gate ready» в health
- [ ] Документация в CLAUDE.md: invariants-mode + список ID

## Readiness criteria

- ⛔ blocked by: ничего (можно начинать сейчас)
- 🔓 starts: фикс #87 завершён ✅, archive прогнан ✅
- ⏳ blocks: Beta MVP gate, регрессионная политика (parent-issue)

## Definition of done

- [ ] `claudeye invariants` запускается и возвращает структурированный JSON для всех ID выше
- [ ] Cowork analyzer task переключён на новый промпт
- [ ] 7 дней подряд all-green в `claudeye stability`
- [ ] CLAUDE.md обновлён с описанием режима
