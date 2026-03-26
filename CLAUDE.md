# Claudeye — Project Context

> **See how you work. Work better.**
> This file is the source of truth for Claude Code.
> Read this before making any changes to the codebase.

---

## What this project is

Claudeye is a production-ready personal memory and analytics layer for Claude Code.
Two distinct parts — both important, different maturity levels.

**Part 1: Memory** — persist context across Claude Code sessions using hooks.
**Part 2: Analytics + Advisor** — understand and improve how you use Claude Code.

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
│   ├── db.js                   # SQLite schema, migrations, all DB operations
│   ├── embeddings.js           # embed(), cosineSimilarity(), bufToFloat32()
│   ├── compress.js             # AI compression via claude --print CLI
│   ├── search.js               # hybridSearch(), buildContext() — RRF fusion
│   ├── analytics.js            # all analytics computations (pure SQLite)
│   ├── advisor.js              # Claude CLI advisor, weekly digest, issue detection
│   ├── analytics-cli.js        # CLI commands: analytics, advise, rate, digest
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
```sql
id, session_id, project, tool, summary, raw_input, raw_output,
tags (JSON array), importance (0.0–1.0), created_at,
retry_count, duration_ms
```

**`embeddings`** — Float32Array blobs (1536 dims) per observation
```sql
observation_id, vector (BLOB), model, created_at
```

**`sessions`** — session metadata
```sql
id, project, started_at, ended_at, summary, prompt_count,
model, plugins (JSON), skills (JSON), duration_ms,
token_input, token_output, friction_score, outcome
```

**`fts_obs`** — FTS5 virtual table, auto-synced via triggers on observations

**`issues`** — auto-detected issue lifecycle
```sql
id, project, title, status (open|resolved|abandoned),
opened_at, resolved_at, session_ids (JSON), obs_ids (JSON),
complexity, resolution_ms
```

**`digests`** — cached weekly advisor reports
```sql
id, week_start, report (markdown), raw_stats (JSON), created_at
```

**`session_ratings`** — user ratings 1–5 per session
```sql
session_id, rating, note, created_at
```

---

## How context retrieval works

```
User prompt
    │
    ├── FTS5 (Porter stemmer, bm25 ranking)     → ranked list A (up to 20)
    └── cosine similarity vs stored embeddings  → ranked list B (top 30 of 300)
              │
    RRF fusion: score = Σ 1/(60 + rank)
              │
    importance boost: score × (0.5 + importance × 0.5)
              │
    top-K deduped results
              │
    inject as markdown comment block before user prompt
```

Context injection format:
```
<!-- claudeye: injected context — do not edit -->
## Recent session context
- <observation summary>

## Relevant past context
- <observation summary> [#tag1 #tag2]
<!-- end claudeye context -->
```

---

## AI compression (compress.js)

Uses `claude --print` CLI with claude-haiku equivalent.
Input: tool name + truncated input/output (3000 chars each).
Output: `{ summary: string, tags: string[], importance: float }`.

Noise fast-path: bash commands matching `/^(ls|pwd|echo|cat|which|clear)/` skip AI entirely, stored with importance 0.05.

Importance scale:
- `0.9+` — architectural decisions, security fixes, breaking changes
- `0.7`  — feature implementation, schema changes, bug fixes
- `0.5`  — routine code edits
- `0.3`  — reads, searches
- `< 0.1` — noise, discarded

---

## Analytics signals

**Friction score** (0.0–1.0, computed per session):
```
friction = (error_ratio × 0.4) + (retry_ratio × 0.4) + (importance_avg × 0.2)
```
High friction = session had errors, retries, or complex work.

**Plugin effectiveness**: friction delta vs baseline (sessions with no plugins).
Example output:
```
superpowers          47 sessions
  Friction:  +0.18 ↑ worse
  Duration:  +23min slower
  Rating:    3.1/5
```

**Issue auto-detection**: observations tagged `error|bug|crash` → open issue.
Subsequent `bugfix|fix|resolved` tag in same project → auto-close with resolution time.

---

## Advisor engine (advisor.js)

Uses `claude --print` (no API cost, uses subscription).

On-demand: `claudeye advise` — streams to terminal.
Weekly: `claudeye digest --generate` — stores markdown in `digests` table.

Prompt structure: aggregated stats JSON → Claude → structured markdown report with sections:
- Key Patterns, Top 3 Recommendations, Plugin & Model Insights,
  Issue Resolution Analysis, One Big Change

---

## CLI commands reference

```bash
# Setup
claudeye setup              # configure API keys (~/.claudeye/settings.json)
claudeye install-hooks      # patch ~/.claude/settings.json with hook definitions

# Memory
claudeye search <query>     # hybrid FTS + vector search
claudeye recent [n]         # recent observations for current project
claudeye sessions           # browse sessions
claudeye viewer             # web UI at localhost:47777
claudeye clear              # clear data (--project or --yes for all)

# Analytics
claudeye analytics                    # global overview
claudeye analytics --project <path>   # per-project deep dive
claudeye analytics --plugins          # plugin effectiveness matrix
claudeye analytics --models           # model comparison
claudeye analytics --issues           # issue resolution metrics
claudeye analytics --hotspots         # complexity hotspots (most-edited files)

# Advisor
claudeye advise                       # on-demand Claude recommendations (streams)
claudeye advise --focus plugins       # focused advice
claudeye advise --days 14             # custom lookback period
claudeye rate [session-id]            # rate session 1-5 (improves advisor)
claudeye digest                       # show latest weekly digest
claudeye digest --generate            # generate now
claudeye digest --list                # history
```

---

## Known gaps (must fix before production use)

### Critical
- **Hook payload validation** — need to verify exactly what fields Claude Code
  exposes in hook JSON. Specifically: does it include `model`, `plugins_active`,
  `token_input`, `token_output`? If not, those analytics fields stay null.
  Test by logging raw stdin in save-hook.js and running a session.

- **setup.js bug** — uses `require()` instead of `readFileSync` for existing
  settings load. Replace with:
  ```js
  import { readFileSync } from 'fs';
  const existing = existsSync(SETTINGS_PATH)
    ? JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'))
    : {};
  ```

- **analytics-cli.js not wired into cli.js** — commands exist in
  `src/analytics-cli.js` but aren't imported/registered in the main `cli.js`.
  Add: `import './src/analytics-cli.js'` at the bottom of cli.js.

- **migrateAnalytics() not called** — analytics schema additions
  (ALTER TABLE sessions ADD COLUMN model...) need to run on first use.
  Call `migrateAnalytics()` from `scripts/setup.js` wrapped in try/catch
  (ALTER TABLE fails silently if columns already exist in SQLite — that's fine).

### Important
- **`<private>` tag support** — if user wraps content in `<private>...</private>`
  in their prompt, save-hook should skip storing that observation.
  Implement in save-hook.js before storing.

- **Retention policy** — no auto-cleanup currently. Add to setup.js:
  ```js
  // Delete low-importance observations older than 90 days
  db.prepare(`
    DELETE FROM observations
    WHERE importance < 0.3 AND created_at < date('now', '-90 days')
  `).run();
  ```

- **Web dashboard analytics tabs** — server.js has the viewer UI but only
  shows observations. Analytics tabs (plugin matrix, model comparison,
  issue timeline) not yet built into the HTML.

- **Weekly digest automation** — need a launchd plist (macOS) to run
  `claudeye digest --generate` every Sunday. Not yet created.

### Nice to have
- Per-project `.claudeye` config file (exclude paths, importance thresholds)
- `claudeye export` — dump project memory as readable markdown
- Cross-device sync (swap better-sqlite3 for pg + pgvector, same interface)

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

## Product context (for future decisions)

This is a personal tool first. Two-phase roadmap:
1. **Personal** — validate memory + analytics work well for one developer
2. **Team** — shared Postgres backend, team dashboard, per-seat pricing

The analytics + advisor layer (Part 2) is the defensible product.
Memory (Part 1) will eventually be commoditized by Anthropic native features.

Target market when going team: engineering teams spending $1k+/month on AI
tooling who want ROI visibility. The pitch: "understand and improve how your
team uses AI." Price point: $50-200/month per team.

Open-source the memory core, monetize the analytics/advisor layer.

---

## How to continue work in Claude Code

When starting a new session:
1. Claude Code will auto-load this file (it's named CLAUDE.md)
2. Say which part you want to work on
3. Check the "Known gaps" section first — fix criticals before adding features

Suggested next session: fix the 4 critical gaps listed above,
then test the full hook → compress → embed → inject loop end to end.
