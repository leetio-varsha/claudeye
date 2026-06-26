# Claudeye — Project Context

> **See how you work. Work better.**
> This file is the source of truth for Claude Code.
> Read this before making any changes to the codebase.

---

## What this project is

Claudeye is a **personal behavioral layer for AI work**. It observes how the user works with AI (starting with Claude Code), finds patterns they don't see themselves, and proposes concrete automations with ready-to-apply implementations.

The product has four layers, ordered by where actual value lives:

**1. Behavioral Advisor (core)** — Claude-powered advisor that produces structured recommendations: _observation → why it matters → proposal → implementation draft → confidence_. Dedups via observation hash, respects dismiss/accept history, personalizes via feedback loop.
**2. Rule-based insights** — daily scheduler writes threshold-based alerts: friction, quota, hotspots, hook health.
**3. Memory (foundation, not product)** — hooks persist every tool event, compressed and embedded; injected back on relevant prompts. Anthropic will commoditize this — we don't rely on it as defensible value.
**4. Automation Advisor** — ROI-scored recommendations across the full dev workflow, not just Claude Code.

## Product vision (read IDEA.md for full version)

Product ladder: **observe → advise → act → learn → model**.

- Observe + Advise shipped (Phase 1 of #87 closed 2026-04-22).
- Act (#24) — advisor writes hooks/PRs/schedulers, user approves with one click.
- Learn (#21) — feedback loop makes advisor personalized per-user.
- **Endgame — Digital Twin (#29):** months of behavioral data become a model of the user. This model is an infrastructure layer any future AI assistant can plug into.

The bet: we're not building a tool for Claude Code. We're building the persistent behavioral layer the user carries across every AI assistant that comes next.

Surface will extend beyond Claude Code (writers, PMs, researchers — anyone using Claude for daily work) when Claude Desktop / Cowork opens an extensions API. Infrastructure is the same; vocabulary of patterns changes per role.

---

## Core principles (don't violate these)

- **Local agent daemon is opt-in** — install with `claudeye agent start`, default mode is `confirm` (dry_run only). Off by default.
- **No open ports by default** — viewer is opt-in (`claudeye viewer`), localhost only. Personal API routes are always localhost-only. `/shared/:token/*` routes accept remote connections but require a valid, non-expired share token.
- **Never block Claude Code** — all hooks exit 0 on failure. Memory failure = silent skip.
- **Claude CLI only** — use `claude --print` for AI calls. No Anthropic SDK, no API keys for compression/advice. Uses the user's existing Claude Code subscription.
- **Multi-provider embeddings (#41)** — pluggable provider abstraction (`src/embeddings.js`). Default: OpenAI `text-embedding-3-small` (1536 dims). Optional: Voyage AI (`voyage-3-lite` / `voyage-code-3` / `voyage-large-2`). Keyword-hash fallback (128 dims) when no key is configured. Selection via `settings.embedding_provider` or auto-detect from available keys.
- **Security first** — settings file mode 0600, no sensitive data in GET responses, localhost-only for viewer. Share tokens expose only aggregate analytics + sessions (no raw observations).

---

## Current status

**Runtime:** better-sqlite3 (native SQLite with FTS5). Fully operational.
**Unified scheduler (#87):** launchd agent `com.claudeye.daily-insights` запускается ежедневно. Wrapper `~/.claudeye/insights-runner.sh` — dispatcher: каждый день → `import-cowork-standalone.mjs` + `reindex-standalone.mjs` (embedding backfill #105) + `insights-standalone.mjs` (rule-based alerts) + `digest-standalone.mjs` (weekly digest, idempotent); по понедельникам → `behavioral-standalone.mjs --days 14`. Heartbeat `~/.claudeye/logs/insights-heartbeat.log` пишет breakdown по каждому подмодулю.

**TCC fix для behavioral advisor (2026-05-04):** ранее запускали `claudeye advises generate` напрямую, но launchd падал с EPERM на `cli.js` (TCC блокирует чтение `~/Documents` из launchd-процессов). Аналогично #82 (insights) и #65 (digest) сделан standalone: `scripts/behavioral-standalone.mjs` копируется в `~/.claudeye/` и обращается только к `~/.claudeye/mem.db`. Вызывает `claude --print` через `resolveClaude()`, пишет в таблицу `advises` с дедупом по `observation_hash`. Регрессионный тест: `test/regression-schedulers.test.js` ловит drift между источником и deployed копией.
**Cowork ingestion (#88):** Cowork desktop-app sessions не триггерят Claude Code hooks (другой runtime), поэтому `claudeye import cowork` читает транскрипты из `~/Library/Application Support/Claude/local-agent-mode-sessions/**/local_<uuid>.json` + `.claude/projects/.../<cliSessionId>.jsonl` и превращает каждый user prompt / assistant message / tool call в observation. Dedup — через таблицу `cowork_imports` (UNIQUE по `cli_session_id`). Project = `userSelectedFolders[0]` если есть, иначе synthetic `cowork://<name>`.
**Cowork noise filter (#93):** `import-cowork.js` при импорте отбрасывает систематический шум — пустые `TodoWrite {"todos":[]}`, `screenshot {}`, `list_scheduled_tasks {}`, односложные user prompts (`Да`/`ok`/`No response requested.`), assistant replies ≤20 chars. Внутрисессионный dedup по `(tool, raw_input)` — одинаковые tool calls пишутся один раз. Assistant text blocks одной реплики объединяются в один observation (вместо 3-5 фрагментов). Уже ингестированный шум чистится через `claudeye cleanup --cowork-noise [--dry-run]`. Service tools (`ToolSearch`, `TaskList`, `TaskGet`) — importance 0.15 (опускаются в RAG). Force re-import (`claudeye import cowork --force`) очищает existing observations сессии перед перезаписью.
**Cowork embedding pass (#98):** после транзакции импорта `import-cowork.js` делает best-effort embedding для obs с importance ≥ 0.5 (порог совпадает с effective-coverage definition в `getDbMetrics` / #75 — низкоимпортанс retention пруняет). Гейт `isEmbeddingEnabled()` — fallback-провайдер пропускается. Опция `skipEmbeddings` для тестов. До фикса 740 high-importance Cowork obs (Edit/Write/CoworkUserPrompt) лежали без векторов и портили search recall.
**Cowork model/token recovery (#81 follow-up, 2026-06-15):** live Stop-hook (`summary-hook.js`) для импортированных Cowork-сессий не срабатывает, поэтому `closeSession` вызывался без model/token данных → каждая `cowork-*` сессия писалась с `model/token_input/token_output = NULL`. Когда вся свежая активность ушла в Cowork, `with_model/with_tokens` замёрзли (377/362, 4 прогона analyzer). Фикс: `parseUsage(transcriptPath)` извлекает model + usage-токены из транскрипта (та же логика, что в Stop-hook: `input_tokens` + `cache_creation` + `cache_read`, `output_tokens`), `import-cowork.js` передаёт их в `closeSession`. Модель берётся из транскрипта (чистое имя), фоллбэк — `meta.model` со снятым суффиксом контекста (`[1m]`). Применяется к новым импортам и force re-import; существующие NULL-сессии не бэкфилятся. **Backfill (2026-06-16):** фикс выше не сдвинул `with_model` (замёрз 377, 5 прогонов) — корень в том, что Cowork-транскрипты **эфемерны**: живут в per-session `local_<uuid>/.claude/projects/…` рабочих папках, которые удаляются вскоре после сессии. К моменту повторного чтения `parseUsage(transcriptPath)` → ENOENT, поэтому и model, и tokens не извлекаются. `meta.model`, однако, попадает в `cowork_imports.meta` при импорте и **переживает** удаление транскрипта. `normalizeMetaModel(raw)` нормализует (`claude-opus-4-8[1m]` → `claude-opus-4-8`); `backfillCoworkModels({db})` детерминированно и идемпотентно (только `model IS NULL`) восстанавливает модель из `cowork_imports.meta` для всех `cowork-*` сессий. Вызывается в конце `importAllCoworkSessions` (self-heal на каждом импорте) и доступен напрямую. Разовый прогон 2026-06-16: восстановил 212/215 сессий, `with_model` 377→589. **Token persist + backfill (#117, 2026-06-17):** токены пост-фактум невосстановимы из транскрипта (он уже удалён), а `meta` исторически их не хранил → `with_tokens` замёрз на 362. Фикс переносит захват токенов на **момент импорта, пока транскрипт ещё жив**: `importCoworkSession` теперь пишет `token_input/token_output` (из `parseUsage`) не только в `sessions` через `closeSession`, но и в `cowork_imports.meta` — персистентно. При повторном/force re-import, когда транскрипт уже удалён (`parseUsage` → null), ранее сохранённые в `meta` токены **сохраняются**, а не затираются null'ами. `backfillCoworkTokens({db})` — компаньон `backfillCoworkModels`, детерминированный и идемпотентный (только `token_input IS NULL`, только при finite `meta.token_input`) — восстанавливает токены из `meta` на сессии, где они NULL. Вызывается в конце `importAllCoworkSessions` (`summary.tokensBackfilled`) и доступен напрямую. Ограничение: для исторических `cowork-*` сессий, импортированных **до** #117 (их `meta` без токенов, транскрипт удалён), токены безвозвратны → остаются NULL. Новые сессии, импортируемые пока транскрипт жив, наполняют `with_tokens`. **Host-сессии:** Stop-hook (`summary-hook.js`) уже захватывает токены из персистентного `~/.claude/projects/.../<id>.jsonl` на закрытии — путь рабочий; flat-метрика была следствием отсутствия свежих host-сессий (вся активность в Cowork), а не поломки. **Standalone parity (#117, 2026-06-18):** настоящая причина «`with_tokens` flat 362, #117 без эффекта» — ежедневный импорт идёт через `scripts/import-cowork-standalone.mjs` (launchd TCC-путь), а НЕ `src/import-cowork.js`; #117 и #81-recovery были добавлены только в cli-путь, поэтому production-импортер никогда не захватывал model/tokens. Фикс портирует `parseUsage`/`normalizeMetaModel`/COALESCE-`closeSession`/meta-persist/`backfillCowork{Models,Tokens}` в standalone (drift-guard `regression-schedulers` сравнивает только размер repo↔deployed, не logic-parity src↔standalone — поэтому и не поймал). Дополнительно: предположение «транскрипты эфемерны» оказалось неверным — 223/224 Cowork-транскриптов всё ещё на диске, поэтому разовый `node import-cowork-standalone.mjs --backfill-usage` (восстанавливает model+tokens из живых транскриптов БЕЗ churn observations, идемпотентно/COALESCE-safe) поднял `with_tokens` 362→582 на live-db. Правило: любой будущий фикс этой логики обязан затрагивать ОБА пути (src + standalone). **System-session filter parity (#118, 2026-06-19):** следующий рецидив того же класса — `import-cowork-standalone.mjs` не фильтровал собственные scheduled-task сессии Claudeye (dev-agent / analyzer / insights), тогда как `src/import-cowork.js` это делает (`isSystemSession` + `SYSTEM_SESSION_TITLE_PATTERNS`). Production-импортер ингестил эти сессии → self-observation loop: osascript-вызовы `gh` от scheduled tasks попадали в observations и раздували tool-distribution (osascript / CoworkAssistantText), что analyzer регулярно помечал как friction-шум. Фикс портирует `SYSTEM_SESSION_TITLE_PATTERNS` + `isSystemSession(meta)` в standalone с вызовом в начале `importSession` (skip + reason). **Drift-guard усилен:** `regression-schedulers.test.js` теперь помимо size-сверки делает logic-parity проверку — сверяет наличие ключевых маркеров (`isSystemSession`, `parseUsage`, `normalizeMetaModel`, `backfillCowork{Models,Tokens}`, `isNoiseEvent`, `dedupEvents`) в обоих путях, так что отсутствие портированной логики падает в CI, а не молча портит аналитику. Разовый cleanup уже заингесченных системных сессий не делался (деструктив над live-db) — фикс предотвращает loop going-forward. **Live-hook parity (#121, 2026-06-25):** тот же класс с другой стороны — фильтр был только на стадии **импорта** Cowork-сессий, но live-хуки (`inject-hook` на UserPromptSubmit, `save-hook` на PostToolUse) регистрировали сессию через `upsertSession` для собственных Cowork scheduled/agent-прогонов Claudeye (analyzer / dev-agent / digest). Эти прогоны исполняются без `CLAUDE_PROJECT_DIR`, поэтому `project` резолвится в `/` или `$TMPDIR` (`/private/var/folders/…/T`). Результат: observation-less, никогда не закрывающиеся junk-сессии, копящиеся в `sessions` (на 06-25 в live-db — 1 900 пустых uuid-сессий из 2 419). Это раздувало `sessions` total → analyzer 3 отчёта подряд видел `sessions↑ / obs flat` (`last_obs` frozen 06-22) и поднимал ложный «host-import lag». Фикс: `isDegenerateProject(project)` в `src/db.js` (null/`''`/`/`/`$TMPDIR`/`/tmp`) + guard в начале `upsertSession` (центральная точка) + ранний `process.exit(0)` в обоих хуках до `saveObservation` (чтобы не ловить FK-ошибку `observations.session_id` и не шуметь в `hook_errors`). Real-проекты (`/Users/...`, `/home/...`) не затрагиваются. Тест: `test/degenerate-project.test.js`. **Cleanup накопленного (#122, 2026-06-26):** `cleanupDegenerateSessions({dryRun})` в `src/db.js` сметает исторические ~1 900 пустых junk-сессий, оставшихся до guard'а #121. Удаляет только сессии, которые одновременно: 0 observations, degenerate по `isDegenerateProject()` (переиспользование логики #121 — single source of truth, фильтр в JS, не дублируется в SQL), вне namespace `import-%`/`cowork-%`. CLI: opt-in `claudeye cleanup --degenerate-sessions` (по умолчанию dry-run показывает count + примеры; удаление только без `--dry-run`), подключён к VACUUM-гейту. Пустые сессии не несут observations/embeddings → каскад не задействуется, уходят только bare-строки. Деструктивный разовый прогон на live-db — manual-only (не в авто-прогоне dev-agent). Тест: `test/cleanup-degenerate-sessions.test.js`.
**Search scaling (#96, CLOSED):** `getObservationsWithEmbeddings(project, 300)` грузит ≤350 строк per query (300 non-git + 50 git-commit cap) — время поиска не зависит от total embeddings. Benchmark (2026-05-08, 15k embeddings): <5ms per project (load+cosine). ADR: `docs/adr-search-scaling.md` — sqlite-vec не нужен до >20k emb в одном проекте или >20ms latency. Tiered embedding retention в `compact()`: `embedding_retention_days` (default 7, importance < 0.5) + `embedding_retention_days_high` (default 90, importance 0.5–0.8). Regression-тесты: `test/search.test.js` — 300 rows <50ms, 900 rows <150ms.
**Injection budget (#90):** `inject-hook` измеряет размер RAG-контекста в байтах и токенах, пишет в `injection_stats` (session_id, project, bytes, tokens_est, sections_json, budget_hit). Budget gate: `inject_budget_tokens` в `~/.claudeye/settings.json` (default 1000) — при превышении `buildContextWithMetrics` дропает секции от низкоприоритетных (cross → searched → recent), уважая floor. CLI: `claudeye injection-stats [-d 7] [-p project]`. Health check warns если p95 > 1500 tok.
**Error retention (#89):** `hook_errors` ротейтится через `claudeye cleanup` — rows старше 30 дней удаляются. Health check смотрит 24h window с trend-glyph (↑/↓/─), не 7d, чтобы исторические спайки от уже-зафикшенных багов не красили health в красное.
**Session handoff smart-truncate (#91):** `inject-hook.js:buildSessionHandoff` использует `truncateSmart()` по границе слова + per-section budget (`errors: 250`, `recent: 200`, `file: 200`) вместо хардкод `slice(0, 150)`. decisions никогда не обрезаются.
**Agent v1 (#20):** `src/agent.js` — два use-case: `crossRepoContext()` (hybridSearch по всем проектам, grouped by project) и `prReview()` (git diff → Claudeye context → decisions + cross-project experience). Все запросы логируются в таблицу `agent_actions` (feedback loop). CLI: `claudeye agent context <query>`, `claudeye agent pr-review [--dry-run]`, `claudeye agent history`.
**Feedback loop (#21):** `agent_actions` имеет колонки `feedback` ('accepted'|'rejected'|NULL=pending), `feedback_at`, `feedback_note`. Функции в `src/agent.js`: `setActionFeedback(id, feedback, note)`, `getPendingActions()`, `getAgentEffectiveness({sinceDays})` (accept/reject counts + rejection rate — >0.5 = сигнал снизить агрессивность), `getAgentDigest({days})` (weekly digest: per-agent counts, daily volume, rejected-notes «что было бесполезно», time-saved-vs-review, рекомендации), `getAgentTimeSavings({sinceDays})` (эвристика: accepted × мин/agent [cross-repo-context=8, pr-review=12, default=5] − reviewed × 1 мин = net; net<0 = агент тратит на ревью больше, чем экономит). Advisor-learning: `analyzeAgentActions({days,format})` в `src/advisor.js` — отправляет AUP-safe payload (counts/rates/notes, без query/result) в `claude --print` и возвращает рекомендации по тюнингу самого агента. CLI: `claudeye agent pending`, `claudeye agent review`, `claudeye agent accept <id> [note]`, `claudeye agent reject <id> [reason]`, `claudeye agent effectiveness [--since <days>]`, `claudeye agent digest [--days <n>]`, `claudeye agent savings [--since <days>]`, `claudeye agent learn [--days <n>] [--json]`. Даёт системе данные «принято vs отклонено» — без них feedback loop не на чём учиться (daemon-действия сами по себе dry_run, accept/reject не несут). Метрики `agent_actions` + feedback теперь в `analyzer-metrics.mjs` (чтобы analyzer не брал устаревшие числа из тел issue).
**Review surface (#115):** без разметки feedback loop мёртв (pending растёт, 0 accepted/0 rejected — analyzer фиксировал это 4 прогона). Три поверхности делают backlog видимым: (1) `claudeye agent review` — интерактивный batch-режим `y/n/s/q` (10–20 действий за заход вместо ручного `accept <id>`; в non-TTY печатает подсказку и выходит, не висит на stdin); (2) алерт в daily-insights когда pending ≥ 50 и 0 размечено за 7 дней (`THRESHOLDS.AGENT_REVIEW_PENDING_WARN`); (3) stderr-нотификация в inject-hook `🤖 Claudeye: N agent-действий ждут review`, throttle 1 раз в день через `~/.claudeye/state/nudge-review`. Helper `getReviewQueueStatus({reviewedWindowDays})` в `src/agent.js` → `{pending, reviewedRecent, windowDays}`. **No-op auto-resolve (2026-06-10):** очередь оказалась 100% шумом — 278 pending были hourly heartbeat'ами демона («0 новых сессий», «no anomaly»), человеку нечего в них размечать. `isNoopResult(action, result)` в `src/agent-daemon.js` определяет no-op (session-analysis 0/0, db-growth-alert без anomaly, auto-archive skipped); такие пишутся сразу с `feedback='auto'` и не попадают в pending. Ошибки и реальные находки остаются pending. Метрики не искажаются: все запросы используют явные `feedback='accepted'/'rejected'` и `IS NULL`. Существующие 278 забэкфилены. Вердикты теперь появятся только от содержательных действий (cross-repo-context, pr-review, аномалии).
**Local agent mode (#18, CLOSED 2026-05-23):** `src/agent-daemon.js` — фоновый демон на launchd (one-shot, запускается раз в час). Архитектура: launchd → `~/.claudeye/agent-daemon-standalone.mjs` → acquireLock → runDaemonCycle → releaseLock → exit. Action registry: `session-analysis` (считает новые сессии/observations за интервал), `db-growth-alert` (мониторит рост БД, >5 MB/h = anomaly), `auto-archive` (архивирует hot DB в archive.db когда >250MB, #30). Safety: `confirm` mode (default) — dry_run=1, только наблюдение; `auto` — выполняет действия; `off` — пропускает. Config: `~/.claudeye/agent-daemon.json`. Lock: `~/.claudeye/daemon.lock` (stale detection 2h). CLI: `claudeye agent start/stop/status/config`. Heartbeat: `~/.claudeye/logs/daemon-heartbeat.log`. Installer: `scripts/agent-daemon-scheduler.js` (`com.claudeye.agent-daemon` plist).
**Workflow Engine (#28, slice 1 — 2026-06-10):** `src/workflow.js` — time allocation analysis. `classifyObservation(tool, tags, summary)` относит observation к категории (`code|debug|review|docs|research|ops|other`; приоритет: tags → расширение файла → tool). `getTimeAllocation({days, project, db})` оценивает время gap-методом: интервал до следующей observation в той же сессии приписывается категории текущей, кап `GAP_CAP_MS` (15 мин — больше = перерыв), последняя в сессии получает `duration_ms || 60s`. Import-tools исключены (как в analytics.js). CLI: `claudeye workflow time [-d 30] [-p <path>] [--json]`; warning если debug/ops ≥ 30%. `db` инжектится для тестов (`test/workflow.test.js`). Известное ограничение v1: ~35% попадает в `other` (generic Bash, CoworkAssistantText) — уточнение классификатора в следующих slices. **Slice 2 (2026-06-11) — bottleneck detection:** `getBottlenecks({days, project, top, minObs, db})` в `src/workflow.js` — четыре сигнала: `slow_steps` (категории с avg сек/шаг и slowdown vs общий средний), `transitions` (стоимость переходов между категориями — gap последней obs категории A до первой B), `churn_files` (файлы с ≥ `CHURN_MIN_EDITS`=3 правками за одну сессию — edit-test-edit циклы; путь извлекается из summary regex'ом `FILE_RE`), `friction_sessions` (топ по `sessions.friction_score` с dominant-категорией). Плюс `hints` — человекочитаемые выводы. Запрос sessions обёрнут в try/catch — graceful degradation если таблицы нет (тесты). CLI: `claudeye workflow bottlenecks [-d 30] [-p <path>] [-t 5] [--json]`. **Slice 3 (2026-06-14) — personal benchmarks:** `getPersonalBenchmarks({weeks, project, db})` в `src/workflow.js` — бьёт окно на ISO-недели (`weekStart(date)` → понедельник UTC), активное время считает тем же gap-методом, по каждой неделе даёт `observations/sessions/active_hours/obs_per_hour/avg_session_obs`. Для последней недели — дельта к личному среднему (`vs_avg_pct`) и направление тренда (`trendOf(vals)` — least-squares slope, нормированный на среднее, порог 3% → `up|down|flat`). `BENCHMARK_METRICS` помечает throughput-метрики как `higher_is_better`. `hints` — выводы по throughput. CLI: `claudeye workflow benchmarks [-w 8] [-p <path>] [--json]`. **Slice 4 (2026-06-15) — workflow templates:** `getWorkflowTemplates({days, project, minSessions, db})` в `src/workflow.js` — «для задач типа X оптимальный порядок A→B→C». Сессии группируются по доминирующей (по времени) категории = тип задачи; категория входит в шаблон, если встречается минимум в `TEMPLATE_PRESENCE`=0.5 сессий типа; порядок шагов = среднее нормированное время первого появления категории внутри сессии (0=начало, 1=конец). `other` исключается как шум. Каждый шаблон даёт `sequence`, `steps` (presence + avg_position), `avg_friction` (опц., graceful degradation без таблицы sessions), `avg_hours`, плюс `hints`. CLI: `claudeye workflow templates [-d 30] [-p <path>] [-m 3] [--json]`. **Slice 5 (2026-06-15) — before/after comparison:** `getBeforeAfter({windowDays, pivot, project, db})` в `src/workflow.js` — делит активность на два окна одинаковой длины до/после `pivot` и сравнивает метрики, чтобы показать как изменился workflow «после рекомендации». Pivot по умолчанию — `created_at` последнего insight (= последней рекомендации, `latestInsightAt`, graceful если таблицы нет); можно задать через `--pivot`. `aggregateWindow` считает `active_hours/observations/sessions/obs_per_hour/avg_session_obs` тем же gap-методом + `avg_friction` (подзапросом по затронутым сессиям, try/catch) + `category_share` (доли времени по категориям). `COMPARE_METRICS` помечает throughput как `higher_is_better:true`, friction — `false`; `direction` = `improved|regressed|flat` для оценочных метрик, `up|down|flat` для нейтральных (порог ±5% от before). `category_shift` — сдвиг долей в п.п. CLI: `claudeye workflow compare [-w 14] [--pivot <datetime>] [-p <path>] [--json]`. **Slice 6/7 (2026-06-16) — proactive suggestions + inject-hook integration:** `getProactiveSuggestions({project, days, max, db})` в `src/workflow.js` агрегирует сильнейшие сигналы остальных слайсов (churn-файл → slow_step → costly transition → workflow-template → throughput-тренд) в короткий приоритизированный список «в прошлый раз на этом проекте помогло…». Каждый под-движок (`getBottlenecks/getWorkflowTemplates/getPersonalBenchmarks`) обёрнут в try/catch — частичные данные не роняют подсказки. Возвращает `suggestions` (kind/priority/text) + `hints` (только текст), отсортированные по убыванию priority, обрезанные до `max` (деф. 3). Интеграция в `inject-hook.js`: ровно на первом промпте новой сессии (`prompt_count === 0` сразу после первого `upsertSession`) инжектится блок `## 🧭 Claudeye — по опыту работы над <project>` + stderr-нотификация; длинная сессия (handoff) имеет `prompt_count > 0`, конфликта нет. CLI: `claudeye workflow suggest [-d 30] [-p <path>] [-m 3] [--json]`. **Все 7 tasks #28 закрыты.**
**Node ABI pin (2026-06-10):** в интерактивном шелле fnm даёт Node 25 (ABI 141), а better-sqlite3 собран под homebrew Node 26 (ABI 147) → `ERR_DLOPEN_FAILED` при запуске `claudeye` из терминала. Фикс: `/opt/homebrew/bin/claudeye` — не npm-симлинк, а sh-wrapper с `exec /opt/homebrew/bin/node .../cli.js "$@"`. ⚠️ `npm link` / `npm i -g` пересоздаст симлинк и сломает пин — после них восстановить wrapper. Все шедулеры и так используют /opt/homebrew/bin/node явно.
**Cowork scheduled tasks:** `claudeye-analyzer` runs daily at 13:05 — агрегирует метрики и сверяет readiness criteria. Issues создаёт отдельный `claudeye-dev-agent` (14:08).
**Invariants-mode (#99, CLOSED 2026-05-11):** `src/invariants.js` реализует 18 инвариантов (SCHED-1..3, DATA-1..4, TRACK-1..3, SCHEMA-1..2, INFRA-1..4, SEC-1..2) — каждый возвращает `{ id, status: green|red|skipped, value, threshold, detail }`. Таблица `invariant_checks` хранит ежедневные runs. CLI: `claudeye invariants [--json|--save]`, `claudeye stability` (streak + MVP gate). Standalone: `scripts/invariants-runner.mjs` деплоится в `~/.claudeye/` и запускается из unified scheduler ежедневно. **Beta MVP gate = 14 consecutive all-green days** (виден в `claudeye stability`). Регрессионная политика: каждый закрытый bug-issue приходит с тестом в `test/regression-<topic>.test.js`. Уже: `regression-schedulers.test.js`, `regression-schema.test.js`, `regression-tracking.test.js`, `regression-data-quality.test.js`. Шаблон: `test/_template-regression.test.js`.
**Heavy-session retention (#116, 2026-06-12):** quota-сессии 450+ turns давали +20–36 MB/день (auto-archive #30 не помогает: порог 250MB и «старше 14d»). Три слоя защиты: (1) `pruneHeavySessions()` в `src/db.js` — удаляет obs старше 7d с importance < 0.5 (не decisions, не git-commit) у сессий > 300 obs; пороги в `~/.claudeye/settings.json` (`heavy_session_obs_threshold`, `heavy_session_retention_days`); CLI `claudeye retention [--dry-run --days --threshold --no-vacuum]`. Coverage не проседает — затрагиваются только не-embeddable obs (< 0.5, #106). (2) Ingest dedup в save-hook: `isConsecutiveDuplicate()` скипает back-to-back одинаковые Bash/Read (tool + raw_input) ДО AI compress — экономит и место, и API-вызовы. (3) Decisions dedup: `hasDuplicateDecision()` — повторный идентичный `decision_rationale` внутри сессии обнуляется при записи (фикс всплеска decisions ×16). Метрика роста: таблица `db_size_log` + `recordDbSize()` → `db_growth_mb_per_day` в `analyzer-metrics.mjs` (null на первом прогоне). Первый прогон: −2,889 obs из 22 сессий, VACUUM −9.1MB (319→310MB). Тесты: `test/retention-heavy.test.js`.
**Storage thresholds (2026-05-04):** auto-compact и `claudeye health` warn-уровень подняты со 100MB до 150MB — после `claudeye archive` steady-state floor ~100MB и старый порог давал ложные срабатывания сразу после успешного архива. Critical уровень 250MB. Daemon `auto-archive` action автоматически триггерит архивацию при превышении 250MB (2026-05-28, #30 CLOSED). Hot/cold split: mem.db (hot) + archive.db (cold), search fallback реализован в search.js. **Invariant INFRA-1 порог 150→300MB (2026-06-21, #119 CLOSED):** retention #116 держит mem.db на плато ~262MB (+0.02MB/день), поэтому 150MB сидел ниже рабочего набора и давал ложный RED каждый прогон analyzer'а. 300MB = headroom над плато, ловит реальный runaway если retention регрессирует. Абсолютный размер — слабый сигнал; daemon `db-growth-alert` использует growth-based детект (anomaly при росте > 5MB/ч).
**compress.js --system-prompt fix (#103, 2026-05-13):** Claude Code 2.1.x+ использует собственный default system prompt, который перекрывает инструкции из stdin user message — следствие: `No JSON in response` и рост compress_fallbacks. Фикс: `SYSTEM_PROMPT` передаётся через `--system-prompt` CLI флаг в `execFileSync`; stdin содержит только user message (tool/input/output). Применено для `compressObservation` и `compressSession`. Симптом диагностируется по `hook_errors` таблице: все записи `error_type=compress_fallback` с message `[CLAUDE_BIN] No JSON in response`.
**GitHub Project:** https://github.com/users/leetio-varsha/projects/4

---

## Current file structure

```
claudeye/
├── cli.js                      # main CLI entrypoint (commander)
├── package.json
├── README.md
├── ANALYTICS_DESIGN.md         # architecture design doc (reference)
│
├── hooks/
│   ├── save-hook.js            # PostToolUse — compress + embed + store
│   ├── inject-hook.js          # UserPromptSubmit — hybrid search + inject context
│   └── summary-hook.js         # Stop — compress full session summary
│
├── src/
│   ├── db.js                   # SQLite schema (better-sqlite3), migrations, all DB operations
│   ├── embeddings.js           # embed(), embedWithMeta(), resolveProvider(), cosineSimilarity(), bufToFloat32() — multi-provider (#41)
│   ├── compress.js             # AI compression via claude --print CLI
│   ├── search.js               # hybridSearch(), buildContext() — RRF fusion
│   ├── analytics.js            # all analytics computations (pure SQLite)
│   ├── advisor.js              # Claude CLI advisor, weekly digest, issue detection
│   ├── analytics-cli.js        # CLI commands: analytics, advise, rate, digest, patterns, auto-issues
│   ├── patterns.js             # pattern detection: repeat-fixes, hotspots, time sinks, cross-session
│   ├── auto-issues.js          # auto-create GitHub issues from pattern findings (#15, #83 local-DB dedup)
│   ├── automation-advisor.js   # workflow automation recommendations with ROI scoring (#16)
│   ├── import.js               # Git import (claudeye import git)
│   ├── import-notion.js        # Notion import — pages + database rows (#9)
│   ├── import-github.js        # GitHub import — issues + PRs + comments, read-first (#23)
│   ├── import-jira.js          # Jira Cloud import — issues + comments (#10), sprint data (#23)
│   ├── import-linear.js        # Linear import — issues + comments via GraphQL (#10)
│   ├── import-slack.js         # Slack import — channel messages + threads, read-first (#23)
│   ├── import-sentry.js        # Sentry import — issues + stacktraces + auto-triage, read-first (#23)
│   ├── import-cowork.js        # Cowork transcript import (#88) — парсит .jsonl сессий из desktop app
│   ├── export.js               # memory export → Markdown (#11)
│   ├── agent.js                # Agent v1 (#20) — crossRepoContext(), prReview(), logAgentAction(), getAgentHistory()
│   ├── agent-daemon.js         # Local agent mode (#18) — getDaemonConfig, acquireLock, runDaemonCycle, getDaemonStatus
│   └── server.js               # Express web viewer, localhost:47777
│
├── scripts/
│   ├── setup.js                # interactive first-time config
│   ├── install-hooks.js        # patches ~/.claude/settings.json
│   ├── backfill-friction.js    # one-time friction score recalculation for old sessions
│   ├── backfill-duration.js    # one-time duration_ms backfill for closed sessions (#81)
│   ├── digest-standalone.js    # self-contained digest generator (bypasses TCC); skips only if generated TODAY (not just this week)
│   ├── digest-scheduler.js     # launchd agent for weekly digest
│   ├── daily-insights.js       # daily anomaly detection (quota, friction, hook health)
│   ├── insights-standalone.js  # TCC-safe daily-insights runner (copied to ~/.claudeye/)
│   ├── insights-scheduler.js   # launchd agent for daily insights (#82)
│   ├── agent-daemon-standalone.mjs  # TCC-safe daemon runner (copied to ~/.claudeye/) (#18)
│   └── agent-daemon-scheduler.js    # launchd install/uninstall/status for com.claudeye.agent-daemon (#18)
│
└── test/
    ├── db.test.js              # database CRUD + FTS search tests
    ├── patterns.test.js        # pattern detection SQL tests
    ├── effort.test.js          # effort classification tests
    ├── compress.test.js        # noise detection, fallback compression, error extraction
    ├── search.test.js          # normalizeProject, RRF scoring
    ├── embeddings.test.js      # cosineSimilarity, bufToFloat32
    ├── embeddings-provider.test.js # multi-provider selection, voyage/openai/fallback (#41)
    ├── auto-issues.test.js     # deduplication, issue formatting, friction trends, local-DB persistence (#83)
    ├── export.test.js          # renderMarkdown + edge cases (#11)
    ├── agent.test.js           # agent_actions schema + CRUD tests (#20)
    └── agent-daemon.test.js    # daemon config, lock, schema tests (#18)
```

---

## Data storage

All data lives in `~/.claudeye/` (mode 0700).

```
~/.claudeye/
├── mem.db          # main SQLite database
└── settings.json   # API keys etc (mode 0600)
```

### Key tables

**`observations`** — compressed AI summaries of every tool event
**`embeddings`** — Float32Array blobs (1536 dims) per observation
**`sessions`** — session metadata with friction scores
**`fts_obs`** — FTS5 virtual table (when available, otherwise LIKE fallback)
**`issues`** — auto-detected issue lifecycle
**`digests`** — cached weekly advisor reports
**`hook_errors`** — diagnostic rows from failing hooks (retention 30d, #89)
**`injection_stats`** — per-prompt RAG injection size + section breakdown (#90)
**`cowork_imports`** — dedup for `claudeye import cowork` (#88)
**`session_ratings`** — user ratings 1-5 per session
**`import_sources`** — idempotent import tracking
**`advises`** (#87) — Claude-powered behavioral advises. Поля: `category`, `observation`, `why`, `proposal`, `code_draft`, `confidence`, `status` (new/shown/accepted/dismissed/applied), `observation_hash` (dedup). Источник: `behavioral-advisor.js` → Claude CLI → JSON → таблица. Показываются через `inject-hook` (top-1 new) и CLI `claudeye advises`.

---

## How context retrieval works

```
User prompt
    │
    ├── FTS5/LIKE search (keyword matching)        → ranked list A (up to 20)
    └── cosine similarity vs stored embeddings     → ranked list B (top 30 of 300)
              │
    RRF fusion: score = Σ 1/(60 + rank)
              │
    importance boost: score × (0.5 + importance × 0.5)
              │
    top-K deduped results → inject as markdown comment block before user prompt
```

---

## AI compression (compress.js)

Uses `claude --print` CLI with claude-haiku equivalent.
Input: tool name + truncated input/output (3000 chars each).
Output: `{ summary: string, tags: string[], importance: float }`.

Noise fast-path: bash commands matching `/^(ls|pwd|echo|cat|which|clear)/` skip AI entirely, stored with importance 0.05.

**JSON extraction (2026-05-06):** greedy `/\{[\s\S]*\}/` заменён на `extractFirstJson()` (brace-depth counting) — фиксит `SyntaxError: Expected ',' or '}'` когда Claude добавлял trailing text после JSON. Тот же фикс в `src/behavioral-advisor.js` и `scripts/behavioral-standalone.mjs`.

Importance scale:
- `0.9+` — architectural decisions, security fixes, breaking changes
- `0.8`  — decisions with rationale (auto-boosted by Decision Memory #25)
- `0.7`  — feature implementation, schema changes, bug fixes
- `0.5`  — routine code edits
- `0.3`  — reads, searches
- `< 0.1` — noise, discarded

**Decision Memory (#25):** compress.js extracts `decision_rationale` from observations containing architectural choices, technology decisions, or trade-offs. Decisions are auto-tagged with `"decision"`, boosted to importance ≥ 0.8, prioritized in inject-hook context, and browsable via `claudeye decisions`.

**Session Handoff:** inject-hook monitors session length. At 100 prompts — soft warning. At 200 prompts — strong recommendation to start a new session + ready-to-paste handoff block with: what was done, key decisions, unresolved issues, files touched. Also available manually via `claudeye handoff`.

---

## Friction score

```
friction = (error_ratio × 0.4) + (retry_ratio × 0.4) + (importance_avg × 0.2)
```

High friction = session had errors, retries, or complex work.

---

## CLI commands reference

```bash
# Setup
claudeye setup              # configure API keys
claudeye install-hooks      # patch ~/.claude/settings.json

# Memory
claudeye search <query>     # hybrid FTS + vector search
claudeye recent [n]         # recent observations
claudeye sessions           # browse sessions
claudeye viewer             # web UI at localhost:47777
claudeye share              # create a read-only share link (--project, --label, --ttl, --list, --revoke)
claudeye clear              # clear data

# Import
claudeye import git                                                    # git history
claudeye import notion --token <token>                                 # Notion pages + database rows (#9)
claudeye import github --repo owner/name --token <token>               # GitHub issues + PRs + comments (#23)
claudeye import jira   --url <url> --email <e> --token <api-token>     # Jira Cloud issues + comments (#10)
claudeye import jira   --sprints [--board <id>] [--project-key <key>]  # Jira sprint data (#23)
claudeye import linear --token <api-key>                               # Linear issues + comments (#10)
claudeye import slack  --token <xoxb> [--channel a,b] [--days 30]      # Slack messages + threads (#23)
claudeye import sentry --token <t> --org <slug> [--days 14]            # Sentry issues + stacktraces + auto-triage (#23)

# Analytics
claudeye analytics                    # global overview
claudeye analytics --project <path>   # per-project
claudeye analytics --plugins          # plugin effectiveness
claudeye analytics --models           # model comparison
claudeye analytics --issues           # issue resolution
claudeye analytics --hotspots         # complexity hotspots

# Advisor (general, on-demand)
claudeye advise                       # AI recommendations (streams)
claudeye advise --focus plugins       # focused advice
claudeye rate [session-id]            # rate session 1-5
claudeye digest                       # show latest digest
claudeye digest --generate            # generate now

# Behavioral Advises (#87) — Claude-powered, proactive, с implementation draft
claudeye advises                      # список pending advises (new + shown)
claudeye advises show <id>            # полный текст + code draft
claudeye advises accept <id>          # принял — учитывается в feedback loop
claudeye advises dismiss <id> --reason "…"   # отклонил; advisor не повторит похожий
claudeye advises generate --days 14   # запустить вручную (обычно крутит scheduler по понедельникам)
claudeye advises generate --dry-run   # посмотреть вывод без записи в DB

# Decision Memory
claudeye decisions                    # decisions in current project
claudeye decisions --all              # all projects
claudeye handoff                      # generate handoff for new session
claudeye handoff -s <session-id>      # handoff for specific session

# Knowledge Graph (#26)
claudeye graph                        # top entities + relations for current project
claudeye graph --entity <name>        # all relations for a specific entity
claudeye graph --type file            # filter by entity type (file|project|tool|decision|bug|person)
claudeye graph --rebuild              # rebuild graph from all existing observations

# Workflow Engine (#28)
claudeye workflow time                # time allocation by category (code/debug/review/docs/research/ops)
claudeye workflow time -d 14 -p <path> --json
claudeye workflow bottlenecks         # slow steps, costly transitions, churn files, high-friction sessions
claudeye workflow benchmarks          # personal speed vs your average, trend by week (-w 8)
claudeye workflow templates           # recommended step order per task type (A→B→C)

# Pattern Detection & Automation
claudeye patterns                     # repeat-fixes, hotspots, time sinks
claudeye patterns --json              # structured output
claudeye automation-advice            # workflow automation recommendations
claudeye automation-advice --json     # structured JSON output
claudeye auto-issues --dry-run        # preview auto-created GitHub issues
claudeye auto-issues                  # create issues from detected patterns
claudeye backfill-friction            # recalculate friction for old sessions
claudeye insights                     # daily anomaly detection
claudeye insights --schedule          # install launchd agent (daily 09:00, #82)
claudeye insights --status            # scheduler status
claudeye health                       # self-check (DB, digests, insights freshness)

# Invariants / stability (#99)
claudeye invariants                   # run all 18 invariant checks (SCHED/DATA/TRACK/SCHEMA/INFRA/SEC)
claudeye invariants --json            # structured JSON output for CI/automation
claudeye invariants --save            # run + persist to invariant_checks table
claudeye stability                    # streak view: consecutive all-green days, MVP gate (14d)

# Export (#11)
claudeye export                       # memory → ./claudeye-export-YYYY-MM-DD.md
claudeye export --project <substring> --since <YYYY-MM-DD> --output <path>
claudeye export --include-raw --no-git

# Testing
npm test                              # run all tests (node:test) — 170 tests
```

---

## Development roadmap

### Phase 1: Dogfooding Foundation (March 2026) ✅
- [x] Core memory hooks (save, inject, summarize)
- [x] Hybrid FTS5 + vector search with RRF
- [x] AI compression via Claude CLI
- [x] Analytics computation layer
- [x] Git history import
- [x] Switch to better-sqlite3 for native FTS5 (#1)
- [x] E2E hook testing (#2, #3) ← #1
- [x] First real git import on own repos (#4) — 6,866 commits from 19 repos ← #1

### Phase 2: Polish & Fix (April 2026) ✅
- [x] Retention policy + tiered storage (#5, #59)
- [x] Private tag support (#6)
- [x] Dashboard polish with Chart.js (#7)
- [x] Weekly digest automation (#8)
- [x] Hardening: timeouts, retries, graceful degradation (#31)
- [x] Onboarding UX: `claudeye init` (#32)
- [x] Decision Memory: capture why, not just what (#25)
- [x] Post-commit hook: auto git import (#50)
- [x] Daily proactive insights: anomalies, quota alerts (#49)
- [x] Effort advisor: rule-based prompt classification (#63)

### Phase 2.5: Advisor Foundation (April 2026) ✅
- [x] Structured advisor output — JSON format (#17)
- [x] Cross-project friction heatmap (#56)
- [x] `claudeye generate-claude-md` — auto-generate CLAUDE.md from observations (#57)
- [x] Pattern detection: repeat-fixes, hotspots, time sinks (#19)
- [x] Auto-issues from advisor (#15) ← #17
- [x] Automation advisor — full workflow analysis (#16) ← #17, #19
- [x] Weekly digest TCC fix — standalone script (#65)
- [x] Weekly digest reliability — hook-based auto-trigger + health check (#79)
- [x] Backfill friction scores for historical sessions (#73)
- [x] npm test — node:test runner with 82 tests (#72, #77)
- [x] GitHub Actions CI — automated tests on push (#66) ← #72
- [x] Tool distribution anomaly — git-commit filtered from analytics (#67)
- [x] DB auto-compact — daily auto-compact at 100MB, alert at 150MB (#74)
- [x] DB retention tightening — git-commit 50/14d, compact 7d, effective coverage metric (#76)
- [x] Embedding coverage — effectiveCoverage metric, smart reindex (#75)
- [x] Friction analysis — worktree normalization, friction breakdown script (#78)
- [x] Embedding backfill standalone — reindex-standalone.mjs в scheduler (#105)
- [x] Analyzer coverage metric fix — emb_embeddable (реальный denominator importance>=0.5) (#106)
- [x] Shared read-only viewer (#33) — share_tokens table + CRUD, /shared/:token/* routes (stats/trends/sessions, no raw data), CLI: claudeye share [--list|--revoke|--project|--label|--ttl]

### Phase 3: Agent v1 (April-May 2026) ← CURRENT
- [x] Local agent mode: background analysis and proactive actions (#18) — launchd one-shot, session-analysis + db-growth-alert, confirm/auto/off modes
- [x] One agent, one use-case, full cycle through Claudeye (#20) — cross-repo-context + pr-review, agent_actions feedback loop
- [x] Feedback loop: system learns from its own actions (#21) — accept/reject capture, effectiveness + rejection-rate tuning signal, weekly digest, time-saved-vs-review metric, advisor learning (`agent learn`)
- [ ] Routing + Control: anti-chaos (1 agent, strict context, kill switch) (#22) ← #20 ✅ UNBLOCKED

### Phase 4: Import Layer & Integrations (May 2026)
- [x] Notion import (#9)
- [x] Jira/Linear import (#10)
- [x] Memory export as markdown (#11)
- [ ] Read-first integrations (#23): GitHub ✓, Jira ✓, Slack ✓, Sentry ✓ — осталось GitLab, Gmail; write-фаза не начата

### Phase 5: Team Foundation (May-June 2026)
- [ ] Postgres + pgvector — team backend (#12)
- [ ] API auth + multi-user (#13) ← #12
- [ ] Team Sync Layer — local SQLite → shared DB, aggregates only (#34) ← #12, #13
- [ ] Team Roles & Access — dev / tech lead / admin (#35) ← #13
- [ ] Landing page + pricing (#14)
- [x] Multi-provider embeddings: OpenAI + Voyage + keyword fallback (#41)

### Phase 5.5: Team UX (June 2026)
- [ ] Team Auto-Setup — `npx claudeye join <token>` (#36) ← #34, #35
- [ ] Team Dashboard — friction heatmap, tool ROI, standardization (#37) ← #34, #35
- [ ] Team CLAUDE.md — hierarchical: global → team → project → personal (#38) ← #34
- [ ] Team Analytics — aggregated advisor for the whole team (#39) ← #34
- [ ] Shared Knowledge Base — privacy-first knowledge sharing (#40) ← #34

### Phase 6: Autopilot (July+ 2026)
- [ ] Partial automation with control: auto triage, reports, tasks (#24)

### Phase 7: Digital Twin (Q4 2026+)
- [ ] Developer model: style, decisions, partial delegation (#29)

### Cross-phase (gradual)
- [x] Knowledge Graph: entities + relations foundation, wired to all save pipelines (#26)
- [ ] Personal AI OS: unified memory, entry, control (#27)
- [ ] Self-Improving Workflow Engine: coach + optimizer (#28)
- [x] Shared read-only viewer: share dashboard by link (#33)
- [ ] Scalability: hot/cold storage, L2 compression, vector index (#30)

### Dependency graph (key chains)
```
#17 (Structured advisor) → #15 (Auto-issues), #16 (Automation advisor) → #18, #20 (Agent)
#20 (Agent v1) → #21 (Feedback loop) → #22 (Routing)
#12 (Postgres) → #13 (Auth) → #34 (Sync) → #35 (Roles) → #36-#40 (Team UX)
```

Each issue has readiness criteria — scheduler checks them daily.

**Стратегия:** core → value → one agent → learning → scale

**Эволюция:** memory tool → self-improving system → team platform → personal AI OS → digital twin

---

## Known gaps

### Resolved
- ~~sql.js lacks FTS5~~ — using better-sqlite3 with native FTS5 (#1)
- ~~Hook payload format unverified~~ — validated (#3)
- ~~analytics-cli.js wiring~~ — fixed (#54)
- ~~`<private>` tag support~~ — implemented (#6)
- ~~Retention policy~~ — tiered retention + compact (#59)
- ~~Dashboard analytics~~ — redesigned with actionable insights (#7)
- ~~Unclosed sessions (57%)~~ — root cause: import-git sessions + orphan cleanup added (#60)

### Resolved (recent)
- ~~`duration_ms/model/token_input/token_output` always NULL~~ — `closeSession` queried `created_at` (doesn't exist in sessions; use `started_at`). Stop hook silently failed, sessions fell to orphan cleanup. Fixed + backfilled (#81)
- ~~Sessions count explosion (×2.9/run)~~ — `compress.js` calls `claude --print` which triggered `UserPromptSubmit` inject-hook, creating phantom sessions. Fixed by setting `CLAUDEYE_INTERNAL=1` on compress subprocesses; inject-hook exits early when set.
- ~~Notion import stub~~ — full implementation: pages + database rows, idempotent, AI-compressed (#9)
- ~~Jira/Linear import stub~~ — `src/import-jira.js` (REST v3 + ADF flattening + comments) and `src/import-linear.js` (GraphQL issues + comments), both idempotent via `import_sources`, AI-compressed, importance-weighted by issue type/priority (#10)

### Active
- None — all known gaps resolved.

---

## Automated analysis (Scheduler)

A Cowork scheduled task `claudeye-analyzer` runs daily at 17:05 with 4 tracks:

- **Track A:** Codebase analysis — bugs, quality, security, features
- **Track B:** Usage pattern analysis from mem.db — friction, repeated actions
- **Track C:** Full workflow analysis — git, GitHub PRs/issues, dev operations
- **Track D:** Readiness check — verifies criteria for each open issue, comments when ready

The scheduler auto-creates GitHub issues and adds them to Project #4.

---

## Dependencies

```json
{
  "better-sqlite3": "^11.0.0",
  "chalk": "^5.3.0",
  "commander": "^12.0.0",
  "express": "^4.18.2",
  "ora": "^8.0.1"
}
```

Node.js >= 20 required (ESM throughout).

---

## Product context

Personal tool first. Three-phase roadmap:
1. **Personal** — validate memory + analytics + automation advisor for one developer
2. **Team** — shared backend, team dashboard, per-seat pricing
3. **Platform** — marketplace for custom analyzers and integrations

### Team-level vision
Те же принципы что для одного дева, масштабированные на команду:
- **Privacy-first** — raw данные (код, промпты) никогда не покидают машину дева. Наверх уходят только агрегаты: friction, модели, плагины, теги, метрики.
- **Insight-driven, не слежка** — тех лид видит где команда буксует и какие инструменты работают. Не видит конкретные промпты и код.
- **Иерархический CLAUDE.md** — global → team → project → personal. Унифицирует практики без потери личного контроля.
- **Shared Knowledge Base** — дев решил проблему → расшарил решение → другой нашёл через поиск. Шаринг только добровольный.
- **Онбординг за одну команду** — `npx claudeye join <token>` настраивает всё: хуки, sync, team CLAUDE.md.
- **Team analytics** — friction по девам × проектам, ROI инструментов, onboarding score, стандартизация.

Issues: #34 (Sync Layer), #35 (Roles), #36 (Auto-Setup), #37 (Dashboard), #38 (CLAUDE.md), #39 (Analytics), #40 (Knowledge Base).

The analytics + advisor + automation layer (Parts 2-3) is the defensible product.
Memory (Part 1) will eventually be commoditized by Anthropic native features.

Target market: engineering teams spending $1k+/month on AI tooling who want ROI visibility.
Price point: $50-200/month per team.
Open-source the memory core, monetize the analytics/advisor/automation layer.

---

## How to continue work in Claude Code

When starting a new session:
1. Claude Code will auto-load this file
2. Check the Development roadmap section — work on the current phase
3. Check Known gaps — fix criticals before adding features
4. Run `claudeye-analyzer` readiness report to see what's ready

**Current priority:** Phase 3 (Agent v1) — #18 ✅ CLOSED, #20 ✅ CLOSED. Next: #21 Feedback loop, #22 Routing + Control.
