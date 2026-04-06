# Claudeye — Project Context

> **See how you work. Work better.**
> This file is the source of truth for Claude Code.
> Read this before making any changes to the codebase.

---

## What this project is

Claudeye is a production-ready personal memory and analytics layer for Claude Code.

Three distinct parts — all important, different maturity levels.

**Part 1: Memory** — persist context across Claude Code sessions using hooks.
**Part 2: Analytics + Advisor** — understand and improve how you use Claude Code.
**Part 3: Automation Advisor** — analyze your entire dev workflow and recommend what to automate.

Long-term vision: "Datadog for AI-assisted development." Start personal, grow to teams.

---

## Core principles (don't violate these)

- **No background daemon** — hooks call Node scripts directly. Nothing running 24/7.
- **No open ports by default** — viewer is opt-in (`claudeye viewer`), localhost only.
- **Never block Claude Code** — all hooks exit 0 on failure. Memory failure = silent skip.
- **Claude CLI only** — use `claude --print` for AI calls. No Anthropic SDK, no API keys for compression/advice. Uses the user's existing Claude Code subscription.
- **OpenAI embeddings only** — the one external API. `text-embedding-3-small`, 1536 dims. Optional but strongly recommended.
- **Security first** — settings file mode 0600, no sensitive data in GET responses, localhost-only for viewer.

---

## Current status

**Runtime:** better-sqlite3 (native SQLite with FTS5). Fully operational.
**Scheduler:** Cowork scheduled task `claudeye-analyzer` runs daily at 17:05 — analyzes codebase, usage patterns, workflow, and checks issue readiness criteria.
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
│   ├── embeddings.js           # embed(), cosineSimilarity(), bufToFloat32()
│   ├── compress.js             # AI compression via claude --print CLI
│   ├── search.js               # hybridSearch(), buildContext() — RRF fusion
│   ├── analytics.js            # all analytics computations (pure SQLite)
│   ├── advisor.js              # Claude CLI advisor, weekly digest, issue detection
│   ├── analytics-cli.js        # CLI commands: analytics, advise, rate, digest
│   ├── import.js               # Import dispatcher (git implemented, notion/jira stubs)
│   └── server.js               # Express web viewer, localhost:47777
│
└── scripts/
    ├── setup.js                # interactive first-time config
    └── install-hooks.js        # patches ~/.claude/settings.json
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
**`session_ratings`** — user ratings 1-5 per session
**`import_sources`** — idempotent import tracking

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

Importance scale:
- `0.9+` — architectural decisions, security fixes, breaking changes
- `0.8`  — decisions with rationale (auto-boosted by Decision Memory #25)
- `0.7`  — feature implementation, schema changes, bug fixes
- `0.5`  — routine code edits
- `0.3`  — reads, searches
- `< 0.1` — noise, discarded

**Decision Memory (#25):** compress.js extracts `decision_rationale` from observations containing architectural choices, technology decisions, or trade-offs. Decisions are auto-tagged with `"decision"`, boosted to importance ≥ 0.8, prioritized in inject-hook context, and browsable via `claudeye decisions`.

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
claudeye clear              # clear data

# Import
claudeye import git         # import git history
claudeye import notion      # (stub — Issue #9)
claudeye import jira        # (stub — Issue #10)

# Analytics
claudeye analytics                    # global overview
claudeye analytics --project <path>   # per-project
claudeye analytics --plugins          # plugin effectiveness
claudeye analytics --models           # model comparison
claudeye analytics --issues           # issue resolution
claudeye analytics --hotspots         # complexity hotspots

# Advisor
claudeye advise                       # AI recommendations (streams)
claudeye advise --focus plugins       # focused advice
claudeye rate [session-id]            # rate session 1-5
claudeye digest                       # show latest digest
claudeye digest --generate            # generate now

# Decision Memory
claudeye decisions                    # decisions in current project
claudeye decisions --all              # all projects
```

---

## Development roadmap

### Phase 1: Dogfooding Foundation (now — week of March 26)
- #1 Switch to better-sqlite3 for native FTS5 ✅ DONE
- #2 E2E test hook lifecycle (after #1)
- #3 Validate hook stdin payloads (after #1)
- #4 First real git import (after #1)

### Phase 2: Polish & Fix (~April 9, after 2 weeks dogfooding)
- #5 Retention policy
- #6 Private tag support
- #7 Dashboard polish (Chart.js)
- #8 Weekly digest launchd automation

### Phase 2.5: Advisor Foundation (~April 9-16)
- #17 Structured advisor output (JSON) — foundation for #15 and #16
- #15 Auto-issues from advisor (after #17)
- #16 Automation advisor — full workflow analysis (after #17)

### Phase 3: Import Layer (~April 23)
- #9 Notion import
- #10 Jira/Linear import
- #11 claudeye export

### Phase 4: Team Foundation (~May-June)
- #12 Postgres + pgvector — team backend
- #13 API auth + multi-user — JWT/OAuth
- #34 Team Sync Layer — локальный SQLite → общая база (только агрегаты, не raw данные)
- #35 Team Roles & Access — dev / tech lead / admin с разным уровнем видимости
- #14 Landing page + pricing
- #18 Local agent mode

### Phase 4.5: Team UX (~June)
- #36 Team Auto-Setup — `npx claudeye join <token>` онбординг за одну команду
- #37 Team Dashboard — админка: friction по девам, инструменты, стандартизация, health
- #38 Team CLAUDE.md — иерархия global → team → project → personal
- #39 Team Analytics — агрегированный advisor: кто буксует, что стандартизировать, onboarding score
- #40 Shared Knowledge Base — privacy-first обмен решениями между девами

### Phase 5: Agent v1 (~June-July)
- #19 Pattern detection: повторяющиеся проблемы и hotspots
- #20 Agent v1: один use-case через Claudeye (PR review / bug triage / cross-repo / meeting->tasks)
- #21 Feedback loop: система учится на своей работе
- #22 Routing + Control: анти-хаос (1 агент, строгий контекст, kill switch)

### Phase 6: Integrations (~July-August)
- #23 Read-first интеграции: GitLab, Jira, Slack, Gmail, Sentry

### Phase 7: Autopilot (~August+)
- #24 Частичная автоматизация с контролем (авто triage, отчёты, таски)

### Phase 8: Digital Twin (~Q4 2026+)
- #29 Модель разработчика: стиль, решения, delegation

### Cross-phase (постепенно)
- #25 Decision Memory: сохранять почему, а не только что (Phase 2.5, малой кровью)
- #26 Knowledge Graph: связи между сущностями (Phase 5, нужно 500+ observations)
- #27 Personal AI OS: единая память, единый вход, единый контроль (Phase 3-4)
- #28 Self-Improving Workflow Engine: coach + optimizer (Phase 5)

Each issue has readiness criteria — scheduler checks them daily.

**Общая стратегия:** ядро -> польза -> один агент -> обучение -> масштаб

**Эволюция продукта:**
memory tool -> self-improving system -> personal AI OS -> digital twin

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

### Active
- **@anthropic-ai/sdk in package.json** — unused, should remove (#58)
- **migrateAnalytics duplication** — db.js and analytics.js have divergent schemas (#58)

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

**Current priority:** Phase 2.5 (Advisor Foundation) — #17 structured output, then #15/#16. Also #49 (scheduler health check), #57 (generate-claude-md).
