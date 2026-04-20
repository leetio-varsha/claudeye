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
- **Multi-provider embeddings (#41)** — pluggable provider abstraction (`src/embeddings.js`). Default: OpenAI `text-embedding-3-small` (1536 dims). Optional: Voyage AI (`voyage-3-lite` / `voyage-code-3` / `voyage-large-2`). Keyword-hash fallback (128 dims) when no key is configured. Selection via `settings.embedding_provider` or auto-detect from available keys.
- **Security first** — settings file mode 0600, no sensitive data in GET responses, localhost-only for viewer.

---

## Current status

**Runtime:** better-sqlite3 (native SQLite with FTS5). Fully operational.
**Scheduler:** Cowork scheduled task `claudeye-analyzer` runs daily at 13:05 — агрегирует метрики из `~/.claudeye/mem.db` через `scripts/analyzer-metrics.mjs` (один JSON-вывод → один osascript-вызов, чтобы не триггерить AUP-классификатор), сверяет readiness criteria по issue titles и сохраняет отчёт в `../analyzer-report-YYYY-MM-DD.md`. Issues создаёт отдельный `claudeye-dev-agent` (14:08).
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
│   ├── import.js               # Import dispatcher (git implemented, notion/jira stubs)
│   ├── export.js               # memory export → Markdown (#11)
│   └── server.js               # Express web viewer, localhost:47777
│
├── scripts/
│   ├── setup.js                # interactive first-time config
│   ├── install-hooks.js        # patches ~/.claude/settings.json
│   ├── backfill-friction.js    # one-time friction score recalculation for old sessions
│   ├── digest-standalone.js    # self-contained digest generator (bypasses TCC)
│   ├── digest-scheduler.js     # launchd agent for weekly digest
│   ├── daily-insights.js       # daily anomaly detection (quota, friction, hook health)
│   ├── insights-standalone.js  # TCC-safe daily-insights runner (copied to ~/.claudeye/)
│   └── insights-scheduler.js   # launchd agent for daily insights (#82)
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
    └── export.test.js          # renderMarkdown + edge cases (#11)
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
claudeye handoff                      # generate handoff for new session
claudeye handoff -s <session-id>      # handoff for specific session

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

# Export (#11)
claudeye export                       # memory → ./claudeye-export-YYYY-MM-DD.md
claudeye export --project <substring> --since <YYYY-MM-DD> --output <path>
claudeye export --include-raw --no-git

# Testing
npm test                              # run all tests (node:test) — 120 tests
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

### Phase 3: Agent v1 (April-May 2026) ← CURRENT
- [ ] Local agent mode: background analysis and proactive actions (#18) ← #15, #16
- [ ] One agent, one use-case, full cycle through Claudeye (#20) ← #15, #16
- [ ] Feedback loop: system learns from its own actions (#21) ← #20
- [ ] Routing + Control: anti-chaos (1 agent, strict context, kill switch) (#22) ← #20

### Phase 4: Import Layer & Integrations (May 2026)
- [ ] Notion import (#9)
- [ ] Jira/Linear import (#10)
- [x] Memory export as markdown (#11)
- [ ] Read-first integrations: GitLab, Jira, Slack, Gmail, Sentry (#23)

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
- [ ] Knowledge Graph: entity relationships (#26)
- [ ] Personal AI OS: unified memory, entry, control (#27)
- [ ] Self-Improving Workflow Engine: coach + optimizer (#28)
- [ ] Shared read-only viewer: share dashboard by link (#33)
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

### Active
- None — all known gaps resolved. Phase 2.5 complete.

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

**Current priority:** Phase 3 (Agent v1) — #18 local agent mode, #20 one agent one use-case.
