# Claudeye — Идея

## Что это

Claudeye — **персональный поведенческий слой для работы с AI**. Система наблюдает как человек работает с AI-ассистентом, находит паттерны которые он сам не видит, и предлагает конкретные автоматизации с готовой имплементацией.

Не «память для Claude Code». Не «Datadog для dev». Это другая категория — **behavioral analytics + actionable advisor** которая со временем превращается в модель конкретного пользователя.

## Что уже работает

Claude Code — первая поверхность. Хуки захватывают каждое взаимодействие (tool calls, prompts, decisions), compress через AI, сохраняют в локальную SQLite с FTS5 + vector search.

Поверх этого:
- **Memory** — foundation, не продукт. Контекст из прошлых сессий автоматически подставляется в релевантные места. Anthropic это коммодитизирует в течение года — мы не закладываемся на это как на defensible value.
- **Rule-based insights** — friction scores, hotspots, repeat-fixes, quota burn, session length, hook health. Ежедневный scheduler пишет alerts.
- **Behavioral Advisor (core)** — Claude-powered модуль анализирует поведение за 7-30 дней и выдаёт конкретные советы в структуре _observation → why it matters → proposed automation → implementation draft → confidence_. Дедуп через observation_hash, память о dismissed/accepted чтобы не повторяться.
- **Automation Advisor** — ROI-scored рекомендации по автоматизации всего workflow (task management, code review, monitoring, docs, communications).

## Product ladder

Четыре ступени, одна конечная цель.

**1. Observe** (есть) — telemetry слой. Хуки видят всё.

**2. Advise** (есть, Phase 1 закрыт в #87) — advisor находит паттерны и предлагает автоматизации с имплементацией. Юзер решает accept/dismiss, система учится на этом.

**3. Act** (Phase 3, 6 мес) — advisor не просто предлагает, а **делает**. Пишет hook, открывает PR, настраивает scheduler — юзер одним кликом принимает или отклоняет. Человек становится пилотом, не пишущим код. Рычаг огромный: 80% работы уже в implementation draft, если система закроет оставшиеся 20% — меняется роль самого разработчика внутри инструмента. См. #24.

**4. Learn** (Phase 4, 6-12 мес) — feedback loop (#21). Система видит какие советы ты принял, какие отклонил, что из принятых реально заработало, что откатил. Advisor становится **персонализированным** за 2-3 недели. Твой advisor ≠ advisor другого пользователя.

**Endgame: Model** — Digital Twin (#29). Если у системы месяцы поведенческих данных о человеке — паттерны, решения, предпочтения, темп, сильные/слабые места — это модель конкретного человека. И она становится **инфраструктурным слоем**: любой AI-ассистент в будущем может подключиться к этой модели и работать _как этот человек_ или _с учётом его особенностей_.

Endgame определяет почему всё остальное имеет смысл. Мы не строим отдельный инструмент для Claude Code — мы строим персональный слой который человек носит с собой через все AI-инструменты которые появятся.

## Почему это defensible

- **Anthropic не сделает:** у них 100+M юзеров, персонализация под каждого не приоритет. Они ship'ят среднее, не индивидуальное.
- **Cursor/Copilot не сделают:** у них конфликт интересов с выбором модели и с observability по usage. Они прячут метрики за seats.
- **OSS memory tools не сделают:** у них нет telemetry foundation — они решают только retrieval-слой.

Moat не в памяти. Moat в (а) **behavioral data aggregated across sessions + projects + time**, (б) **advisor с implementation drafts** который превращает совет в готовый merge, (в) **local-first privacy** — raw data не покидает машину, вверх уходят только агрегированные сигналы.

## Масштабирование: команды

Те же принципы работают на уровне команды. Каждый дев локально — raw данные на машине. Вверх уходят только агрегированные метрики: friction, модели, плагины, паттерны.

Тех-лид видит где команда буксует, какие инструменты _реально_ работают (vs куплены), что можно стандартизировать. Нарратив для buyer'а: «мы платим $30/seat за Copilot — что мы получаем». Ни Cursor, ни Copilot этот ответ не дают. Claudeye даёт.

Команда — это не отдельный продукт, а агрегация того же персонального слоя. Иерархический CLAUDE.md (global → team → project → personal), Shared Knowledge Base с privacy-first обменом, онбординг за `npx claudeye join <token>`. Всё уже в backlog (#34-#40).

## Масштабирование: не только разработчики

Claude сейчас уже не только dev-tool. PM'ы, writers, researchers, lawyers, analysts, consultants используют его ежедневно. Cowork mode (в котором работает эта беседа) позиционируется как consumer productivity.

**Behavioral layer применим ко всем этим ролям одинаково.** Infrastructure та же (telemetry, advisor, feedback loop). Меняется только UI и словарь паттернов:
- PM: «ты правишь один и тот же brief 15 раз — вот шаблон»
- Writer: «ты часто просишь Claude переписать одно место — здесь системная проблема в структуре»
- Researcher: «ты задаёшь похожие вопросы в разных чатах — вот сведённая база ответов»

Если Anthropic откроет extensions для Claude Desktop / Cowork — Claudeye становится «аналитика для твоей работы с Claude» для ~10-100M человек. TAM ×1000 vs только Claude Code.

## Монетизация — три вектора

**Solo (foothold, не destination).** OSS core + paid tier $5-10/мес за cloud sync, advanced advisor, email digest. Используется как distribution channel и источник feedback на advisor'е. Потолок рынка ~$120k-3M ARR при 1-5% conversion от 100-500k серьёзных Claude Code юзеров.

**Teams (B2B money).** $20-40/seat. Аудитория — engineering managers / CTO'ы ищущие ответ «мы эффективны с AI или нет». 6-12 мес работы над team features + SOC2-ish compliance. Выход через 5-10 design-partners, не broad launch.

**Non-devs (asymmetric bet).** Если extensions API для Claude Desktop / Cowork откроется — retool UI, infrastructure та же. TAM ×100-1000. Это Series A вопрос и история «поведенческий слой для работы с AI» для массового рынка.

## Стратегия

_observe → advise → act → learn → model_

Идём по ступенькам. Сейчас: **advise** работает, entering **act** phase через #24 автопилот. Одновременно — solo usage и ранние team design-partners. Non-devs пивот — когда откроется поверхность.

Open-source ядро. Монетизация — на advisor-слое и team aggregation. Raw data всегда локально. Агрегация всегда опциональна.

Принцип: **privacy-first, insight-driven, не слежка**.
