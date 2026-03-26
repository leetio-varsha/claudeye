# Claude Mem — Analytics & Advisor Architecture

## What we're building

A self-improving developer analytics layer on top of the memory scaffold.
Goal: surface patterns you can't see manually across hundreds of sessions.

---

## Data Model Extensions

### New fields on existing tables

```sql
-- sessions (additions)
ALTER TABLE sessions ADD COLUMN model          TEXT;     -- claude-opus-4-5, claude-sonnet-4-6...
ALTER TABLE sessions ADD COLUMN plugins        TEXT;     -- JSON array ["superpowers", "claude-mem"]
ALTER TABLE sessions ADD COLUMN skills         TEXT;     -- JSON array ["mem-search", "make-plan"]
ALTER TABLE sessions ADD COLUMN duration_ms    INTEGER;  -- session wall clock time
ALTER TABLE sessions ADD COLUMN token_input    INTEGER;  -- from hook event if available
ALTER TABLE sessions ADD COLUMN token_output   INTEGER;
ALTER TABLE sessions ADD COLUMN friction_score REAL;     -- computed: retries, back-and-forth
ALTER TABLE sessions ADD COLUMN outcome        TEXT;     -- 'success'|'partial'|'abandoned'|null

-- observations (additions)
ALTER TABLE observations ADD COLUMN retry_count INTEGER DEFAULT 0; -- same file/tool re-invoked
ALTER TABLE observations ADD COLUMN duration_ms INTEGER;           -- time for this tool call
```

### New tables

```sql
-- Explicit issue lifecycle tracking
CREATE TABLE issues (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project      TEXT    NOT NULL,
  title        TEXT    NOT NULL,           -- extracted from first mention
  status       TEXT    NOT NULL DEFAULT 'open',  -- open|resolved|abandoned
  opened_at    TEXT    NOT NULL,
  resolved_at  TEXT,
  session_ids  TEXT    NOT NULL DEFAULT '[]',    -- JSON array of session IDs involved
  obs_ids      TEXT    NOT NULL DEFAULT '[]',    -- JSON array of observation IDs
  complexity   REAL,                             -- 0.0–1.0, computed
  resolution_ms INTEGER                          -- time from open to resolved
);

-- Weekly digests (cached, not re-computed)
CREATE TABLE digests (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  week_start   TEXT    NOT NULL UNIQUE,    -- ISO date, Monday
  report       TEXT    NOT NULL,           -- full markdown report from Claude
  raw_stats    TEXT    NOT NULL,           -- JSON snapshot of stats that week
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- User ratings on sessions (optional, improves advice quality)
CREATE TABLE session_ratings (
  session_id   TEXT    PRIMARY KEY REFERENCES sessions(id),
  rating       INTEGER NOT NULL,   -- 1–5
  note         TEXT,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);
```

---

## Signal Derivation

The hard problem: how do we compute meaningful signals from raw events?

### Friction Score
Proxy for "how hard was this session":
```
friction = (
  retry_ratio      × 0.4 +   -- same file edited 3+ times
  error_ratio      × 0.3 +   -- observations tagged 'error'
  prompt_density   × 0.3     -- prompts per hour (high = back-and-forth)
)
```

### Issue Detection
We detect issues automatically by watching for:
- Observations tagged `bugfix`, `error`, `debug`
- Sequences: error observation → fix observation (same file/area)
- Resolution = session where the error pattern stops recurring

### Plugin/Skill Effectiveness
Per plugin, we track:
- Average session friction when plugin is active
- Average tool calls to complete a task
- Average session duration
- User rating (if provided)

Compare baseline (no plugin) vs plugin-active sessions per project.

### Complexity Hotspots
Files/areas that appear across many high-friction sessions.
Derived from `raw_input` paths in observations.

---

## Analytics Computations (src/analytics.js)

```
getGlobalStats()        → overview across all projects
getProjectStats(proj)   → deep dive for one project
getPluginMatrix()       → plugin × metric grid
getModelComparison()    → model × outcome × token cost
getIssueMetrics()       → resolution time, complexity distribution
getComplexityHotspots() → files/areas with most friction
getWeeklyTrend(n)       → last n weeks sparkline data
```

---

## Advisor Engine (src/advisor.js)

Uses `claude -p` CLI (no API key needed).

### On-demand: `cmem advise`
1. Collect last 30 days of aggregated stats as JSON
2. Build a structured prompt with the data
3. Pipe through `claude -p --system "you are a senior dev advisor..."`
4. Stream output to terminal as markdown

### Weekly digest: auto-runs Sunday night (launchd/cron)
1. Same as above but scoped to last 7 days
2. Stores result in `digests` table
3. Shown on next `cmem stats` or viewer open

### Prompt structure for advisor:
```
You are analyzing a developer's Claude Code usage patterns.
Given this data, provide:
1. Top 3 efficiency insights (with specific numbers)
2. Plugin/model recommendations (backed by the data)
3. One workflow change that would have the most impact
4. Issues that took longest to resolve and why (if detectable)

Be specific. Reference actual numbers. Avoid generic advice.

DATA:
{json_stats}
```

---

## CLI Commands

```bash
cmem analytics                    # global overview
cmem analytics --project entravel # per-project
cmem analytics --plugins          # plugin effectiveness matrix
cmem analytics --models           # model comparison
cmem analytics --issues           # issue resolution metrics
cmem analytics --hotspots         # complexity hotspots

cmem advise                       # on-demand Claude advice
cmem advise --focus plugins       # focus on plugin usage
cmem advise --focus workflow      # focus on workflow patterns

cmem rate [session-id]            # rate a session 1-5
cmem digest                       # show latest weekly digest
cmem digest --generate            # force regenerate
```

---

## Web Dashboard Extensions

### New tabs on the viewer:

**Analytics tab**
- Global sparkline: sessions/day for last 30 days
- Project breakdown: bar chart, obs count + friction score
- Plugin matrix: table with effectiveness metrics
- Model usage: pie chart + avg session rating per model

**Issues tab**
- Open issues list with age
- Resolved issues: avg resolution time per project
- Complexity heatmap (projects × issue complexity)

**Advisor tab**
- Latest digest (rendered markdown)
- "Generate advice" button (calls /api/advise → streams response)
- History of past advice

---

## Implementation Order

1. Schema migration (30 min)
2. Enhanced hook data capture (1 hr)
3. src/analytics.js — computation layer (2 hrs)
4. CLI analytics commands (1 hr)
5. src/advisor.js — Claude CLI advice engine (1 hr)
6. Dashboard tab extensions (2 hrs)
7. Issue auto-detection (2 hrs)
8. Weekly digest + launchd setup (1 hr)

Total: ~2 days of focused work
