# Claudeye

[![CI](https://github.com/leetio-varsha/claudeye/actions/workflows/ci.yml/badge.svg)](https://github.com/leetio-varsha/claudeye/actions/workflows/ci.yml)

**See how you work. Work better.**

Claudeye is a **personal behavioral layer for AI work** — it observes how you work with Claude Code, finds patterns you don't notice yourself, and proposes concrete automations with ready-to-apply implementations.

It's not just memory. Memory is the foundation — the real product is the advisor that sits on top, turning raw behavioral data into specific recommendations tailored to how _you_ work.

Long-term vision: a persistent behavioral model of the individual user, portable across AI assistants as they evolve.

---

## Quick Start

```bash
# Clone and install
git clone git@github.com:leetio-varsha/claudeye.git
cd claudeye
npm install

# Link CLI globally
npm link

# Configure (enter OpenAI key for embeddings — optional but recommended)
claudeye setup

# Install hooks into Claude Code (patches ~/.claude/settings.json)
claudeye install-hooks

# Restart Claude Code — hooks are now active for ALL projects
```

### Bootstrap with existing history

Don't start with an empty database — import your git history:

```bash
cd ~/my-project
claudeye import git                    # import from current repo
claudeye import git --since 2024-01-01 # only recent commits
claudeye import notion --token <token> # import Notion pages + databases
claudeye import github --repo owner/name --token "$(gh auth token)" # GitHub issues + PRs (#23)
claudeye import jira   --url <https://org.atlassian.net> --email <you@x> --token <api-token>
claudeye import linear --token <api-key>
claudeye import slack  --token <xoxb-token> # Slack channel messages + threads (#23)
claudeye import sentry --token <token> --org <slug> # Sentry issues + stacktraces + auto-triage (#23)
claudeye import cowork                 # import Claude desktop Cowork sessions (#88)
```

Repeat for each project you want Claudeye to know about.

---

## The product — four layers

Claudeye is structured as four layers. The top layer is where the actual value lives — the ones below exist to feed it.

### 1. Behavioral Advisor — the core

Claude-powered advisor that analyzes your patterns and proposes concrete automations with working implementations. Each advise is structured:

- **Observation** — what behavior was noticed (in plain language, not metrics)
- **Why it matters** — concrete impact on quota, context quality, time, or reliability
- **Proposal** — specific hook, script, scheduler, or CLI change
- **Implementation draft** — code snippet, CLI command, or file path you can apply directly
- **Confidence** — low / medium / high

The advisor runs weekly via the unified scheduler, deduplicates via observation hash, and respects your past dismiss/accept history so it doesn't repeat ignored suggestions. Top advises surface automatically at session start via `inject-hook`. Managed via `claudeye advises list | show | accept | dismiss | generate`.

### 2. Rule-based insights

Daily scheduler writes threshold-based alerts:

- **Friction scores** per session and project — where are you struggling?
- **Quota & session length** — long sessions, model mismatch, token ratio outliers
- **Hotspots** — files with high error rates, repeat-fixes, cross-cutting infra code
- **Plugin & model effectiveness** — is this tool actually helping, or slowing you down?
- **Hook health** — compress fallback rate, scheduler heartbeat, hook silence detection
- **Weekly digest** — Claude-written summary with recommendations

### 3. Memory — the foundation

Claude Code forgets everything when a session ends. Claudeye doesn't. This is infrastructure, not the product.

- Captures every tool event, compressed by AI into searchable observations
- Injects relevant past context before each new prompt automatically
- Works across all your projects — ask "how did we solve this in project X"
  and get a grounded answer, not a hallucination
- FTS5 + vector search with RRF fusion, OpenAI text-embedding-3-small (or Voyage, or fallback)

Anthropic will commoditize memory in the next year. We don't rely on this as defensible value — it's the data source that makes behavioral analysis possible.

### 4. Automation Advisor

Extends the behavioral lens beyond Claude Code into your full dev workflow.

- **Task management** — repeated issue creation, stale tickets, sprint grooming patterns
- **Code review** — PRs waiting too long, repeated review comments, missing checks
- **Monitoring** — CI/CD status, branch divergence, dependency updates
- **Documentation** — README/CHANGELOG drift, release notes generation
- **Communications** — standup generation, weekly digests, notifications
- **Dev operations** — merged branch cleanup, test scheduling

Each recommendation includes: automation type (Scheduler / Hook / Agent / Script / MCP / GitHub Action), estimated time savings, and implementation complexity.

---

## Product ladder

Four stages, one endgame.

**Observe** (shipped) — telemetry layer. Hooks see everything.

**Advise** (shipped, Phase 1 via [#87](https://github.com/leetio-varsha/claudeye/issues/87)) — advisor finds patterns, proposes automations with implementation drafts.

**Act** (Phase 3) — advisor writes the hook, opens the PR, configures the scheduler. User approves or rejects with one click. The role shifts from writing code to making decisions. See [#24](https://github.com/leetio-varsha/claudeye/issues/24).

**Learn** (Phase 4) — feedback loop. System sees which advises you accepted, which you dismissed, which worked. Advisor becomes personalized within 2-3 weeks of use. See [#21](https://github.com/leetio-varsha/claudeye/issues/21).

**Endgame — Model.** Digital Twin ([#29](https://github.com/leetio-varsha/claudeye/issues/29)): months of behavioral data become a model of you. This model is an infrastructure layer — any future AI assistant can plug into it and work _as you_ or _with awareness of your particular patterns_.

---

## Beyond Claude Code

The current surface is Claude Code. The behavioral layer applies equally to any AI-assisted workflow — writing, research, PM work, analysis, design. Memory + telemetry + advisor infrastructure is the same; the vocabulary of patterns changes per role.

When Claude Desktop / Cowork opens an extensions API, Claudeye retargets without rebuilding the core.

---

### Team Mode (coming later)

Same principles, scaled to a team. Privacy-first — raw data never leaves dev machines.

- **Aggregated metrics only** — friction scores, models, plugins, patterns flow up. Code and prompts stay local.
- **Tech lead dashboard** — see where the team struggles, which tools actually work, what to standardize
- **Hierarchical CLAUDE.md** — global → team → project → personal. Unified practices without losing individual control.
- **Shared Knowledge Base** — dev solves a problem, shares the solution. Others find it through search. Sharing is always voluntary.
- **One-command onboarding** — `npx claudeye join <token>` sets up hooks, sync, team config.
- **Team analytics** — friction × developer × project heatmap, tool ROI, onboarding score for new members.

---

## Architecture

```
Claude Code
  │
  ├── UserPromptSubmit ──► inject-hook.js ──► hybridSearch() ──► prepend context
  ├── PostToolUse      ──► save-hook.js   ──► compress() + embed() ──► SQLite
  └── Stop             ──► summary-hook.js ──► compressSession() ──► session summary
```

**Retrieval: Hybrid FTS5 + Vector (RRF fusion)**

```
prompt → FTS5 search + cosine similarity → RRF merge → importance boost → inject
```

**No daemon. No open ports. No background processes.**
Three hook scripts, one SQLite file, that's it.

---

## Usage

```bash
# Memory
claudeye search "how we fixed the auth bug"   # hybrid search across all projects
claudeye recent                               # last 15 observations, current project
claudeye sessions                             # browse session history
claudeye viewer                               # web UI at localhost:47777
claudeye share                                # create a read-only share link
claudeye share --list                         # list active share links
claudeye share --revoke <token>               # revoke a share link
claudeye share --project <path> --ttl 14      # scope to project, 14-day TTL

# Import
claudeye import git                           # import git history from current repo
claudeye import git --path /other/repo        # from another repo
claudeye import notion --token <token>        # import Notion pages + database rows
claudeye import notion --database-only        # only database rows
claudeye import notion --pages-only           # only standalone pages
# NOTION_API_KEY env var also accepted

# GitHub (#23, read-first) — issues + PRs + comments
claudeye import github --repo owner/name --token "$(gh auth token)"
claudeye import github --repo owner/name --state open --limit 200
# GITHUB_TOKEN / GH_TOKEN env vars also accepted

# Jira Cloud — issues + inline comments
claudeye import jira --url https://acme.atlassian.net --email you@acme --token <api-token>
claudeye import jira --project-key ENG --limit 200
# JIRA_URL / JIRA_EMAIL / JIRA_API_TOKEN env vars also accepted

# Jira sprint data (#23) — sprints (active/closed/future) с goal и done/total counts
claudeye import jira --sprints
claudeye import jira --sprints --board 12 --project-key ENG

# Linear — issues + comments (GraphQL)
claudeye import linear --token <api-key>
claudeye import linear --team ENG --limit 200
# LINEAR_API_KEY env var also accepted

# Slack (#23, read-first) — channel messages + threads («поиск решений в обсуждениях»)
claudeye import slack --token xoxb-...                  # all member channels, last 30 days
claudeye import slack --channel dev,general --days 90   # specific channels, deeper lookback
# SLACK_TOKEN / SLACK_BOT_TOKEN env vars also accepted.
# Scopes: channels:read + channels:history. Threads are imported as one
# observation (parent + replies); joins/short noise filtered out.

# Sentry (#23, read-first) — issues + stacktraces + auto-triage
claudeye import sentry --token <token> --org <slug>          # unresolved issues, last 14 days
claudeye import sentry --sentry-project my-api --days 30     # one project, deeper lookback
claudeye import sentry --query "is:unresolved level:error" --no-stacks
# SENTRY_TOKEN / SENTRY_ORG env vars also accepted; --url <base> for self-hosted.
# Scopes: org:read + project:read + event:read. Each issue lands as one
# observation with latest-event in-app stack frames; auto-triage tag
# (triage:high/medium/low from level × events × users) drives importance.

# Cowork (#88) — desktop-app sessions don't fire Claude Code hooks, so import
# their transcripts from disk. Deduped via cowork_imports (UNIQUE cli_session_id).
# Daily run is wired into the unified scheduler.
# Noise filter + intra-session dedup + assistant-text bundling (#93) keep the
# import lean — empty TodoWrite, repeated `screenshot {}`, 'Да', etc. are dropped.
claudeye import cowork
claudeye import cowork --force               # wipes + re-imports (applies new filters)
claudeye cleanup --cowork-noise              # also clears already-imported noise/dupes
claudeye cleanup --degenerate-sessions --dry-run  # preview empty '/' / $TMPDIR junk sessions (#122)
claudeye cleanup --degenerate-sessions       # purge them (destructive; follow-up to #121 guard)

# Heavy-session retention (#116) — prune old low-importance obs from 450+ turn sessions
claudeye retention --dry-run                 # preview (default: > 300 obs, older than 7d, importance < 0.5)
claudeye retention                           # prune + VACUUM; decisions/git-commit always kept

# Injection stats (#90) — RAG "tax" per user prompt
claudeye injection-stats                     # last 7 days, p50/p95/p99
claudeye injection-stats -d 30 -p /path      # scope to project / window

# Analytics
claudeye analytics                            # global overview
claudeye analytics --plugins                  # plugin effectiveness matrix
claudeye analytics --models                   # model comparison
claudeye analytics --issues                   # issue resolution metrics
claudeye analytics --hotspots                 # most complex files/areas

# Advisor
claudeye advise                               # AI-powered workflow recommendations
claudeye advise --focus plugins               # focused on plugin usage
claudeye advise --json                        # structured JSON output
claudeye rate                                 # rate a session 1-5
claudeye digest                               # latest weekly digest
claudeye digest --generate                    # generate now
claudeye insights                             # daily proactive insights (rule-based)
claudeye insights --schedule                  # install unified launchd agent (daily 09:00)
claudeye insights --status                    # scheduler status
claudeye health                               # self-check (DB, digests, insights freshness)

# Behavioral Advises (#87) — Claude-powered, written to advises table
claudeye advises                              # list pending (new + shown)
claudeye advises show <id>                    # full advise (observation/why/proposal/code_draft)
claudeye advises accept <id>                  # accept — counted in feedback loop
claudeye advises dismiss <id> --reason "..."  # dismiss — advisor won't repeat similar
claudeye advises generate --days 14           # run manually (scheduler does it Mondays)
claudeye advises generate --dry-run           # preview output without writing to DB

# Agent (#20) + Feedback loop (#21)
claudeye agent context <query>                # cross-repo context: search all projects
claudeye agent pr-review [--dry-run]          # PR review context from git diff
claudeye agent history                        # recent agent action log
claudeye agent pending                        # actions awaiting accept/reject
claudeye agent review                         # interactive batch review: y/n/s per action (#115)
claudeye agent accept <id> [note]             # mark action useful (feedback loop)
claudeye agent reject <id> [reason]           # mark action noise (feedback loop)
claudeye agent effectiveness [--since <days>] # accepted vs rejected, rejection rate
claudeye agent digest [--days <n>]            # what the agent did + what was useful
claudeye agent savings [--since <days>]       # time saved vs time spent reviewing
claudeye agent learn [--days <n>] [--json]    # advisor analyzes actions → tuning tips

# Workflow Engine (#28)
claudeye workflow time [-d 30] [-p <path>]    # time allocation: code/debug/review/docs/research/ops
claudeye workflow bottlenecks [-d 30] [-t 5]  # slow steps, costly transitions, churn files, high-friction sessions
claudeye workflow benchmarks [-w 8] [-p <path>] # personal speed vs your average, trend by week
claudeye workflow templates [-d 30] [-m 3]    # recommended step order per task type (A→B→C)
claudeye workflow compare [-w 14] [--pivot <datetime>] # before/after metrics around a recommendation
claudeye workflow suggest [-d 30] [-m 3]      # proactive session-start hints (also injected on first prompt)

# Pattern Detection & Automation
claudeye patterns                             # repeat-fixes, hotspots, time sinks
claudeye patterns --json                      # structured output
claudeye automation-advice                    # workflow automation recommendations
claudeye auto-issues --dry-run                # preview auto-created GitHub issues
claudeye auto-issues                          # create issues from detected patterns (deduped locally + on GH)
claudeye backfill-friction                    # recalculate friction for old sessions

# Export
claudeye export                               # memory → ./claudeye-export-YYYY-MM-DD.md
claudeye export --project ~/code/foo          # filter by project path substring
claudeye export --since 2026-04-01            # only sessions started on/after date
claudeye export --output ./snapshot.md        # custom output path
claudeye export --include-raw                 # include raw tool I/O (verbose)
claudeye export --no-git                      # skip git-commit observations

# Testing
npm test                                      # run all tests (node:test)
```

---

## Storage

All data stays on your machine at `~/.claudeye/` — never leaves.

```
~/.claudeye/
├── mem.db          # SQLite database
└── settings.json   # API keys (mode 0600, only you can read)
```

---

## How it retrieves context

When you type a new prompt, Claudeye runs two searches in parallel:

1. **FTS5** — keyword search with Porter stemmer over all your observations
2. **Vector search** — cosine similarity against stored embeddings

Results are merged using Reciprocal Rank Fusion, boosted by importance score,
and the top results are prepended to your prompt as a context block.

This means searching *"login issue"* finds past observations about
*"JWT token expiry"*, *"session middleware"*, *"auth guard"* — even across
different projects — because it understands meaning, not just keywords.

---

## Automated daily analysis

Claudeye includes two daily scheduled tasks that run via **Cowork** (Claude Desktop).
The scripts live in the repo, but the schedulers themselves are Cowork runtime configs — they don't transfer with `git clone`. If you're setting up Claudeye from scratch, you need to create them manually.

### Why schedulers exist

Claudeye collects data passively through hooks, but raw data alone isn't actionable. The schedulers turn it into a daily feedback loop: the analyzer finds problems in the codebase and workflow, creates GitHub issues automatically; the insights monitor watches for anomalies (quota burn, broken hooks, friction spikes) and alerts before things go wrong. Without them Claudeye is a memory tool. With them it's a proactive advisor.

### 1. `claudeye-analyzer` — daily codebase + workflow analysis

Runs daily (recommended: 13:00). Performs 4 analysis tracks:

| Track | What it does |
|-------|-------------|
| **A: Codebase** | Finds bugs, code quality issues, security gaps, missing features |
| **B: Usage patterns** | Analyzes mem.db for friction hotspots, repeated actions |
| **C: Workflow** | Scans git + GitHub for PR/issue patterns, recommends automations |
| **D: Readiness** | Checks each issue's start criteria, comments when ready |

Auto-creates GitHub issues and adds them to the project board.
Not a standalone script — runs as a Cowork scheduled task with an LLM prompt that reads the codebase, mem.db, and GitHub state.

### 2. `claudeye-insights` — daily anomaly detection

Runs daily (recommended: 09:00). Script: `scripts/daily-insights.js`.
Can also be invoked via CLI: `claudeye insights`.

Monitors for:
- **Quota burn** — sessions with 250+ prompts, daily volume spikes
- **Friction anomalies** — per-project friction increase >30%, repeat-fix hotspots
- **Infrastructure health** — hook silence >36h, DB size, hook error rate, embedding gaps
- **Positive signals** — friction drops (so you know what's working)

Alert severity: 🔴 critical (act now), 🟡 warning (trend worsening), 🟢 insight (opportunity).
Philosophy: no alerts = everything is fine.

### Setting up schedulers (for new contributors)

Schedulers are created in **Cowork** (Claude Desktop app) using the `schedule` skill:

1. **claudeye-analyzer**: Create a daily scheduled task at 13:00. The task prompt should instruct Claude to analyze the Claudeye codebase (4 tracks above), read mem.db metrics, check GitHub issues for readiness criteria, and create new issues for findings. Cron: `0 13 * * *`.

2. **claudeye-insights**: Create a daily scheduled task at 09:00 that runs `node scripts/daily-insights.js` from the claudeye directory and reports the results. Cron: `0 9 * * *`.

Alternatively, for non-Cowork setups, `scripts/digest-scheduler.js` can install a macOS LaunchAgent for the weekly digest (`claudeye scheduler install`).

---

## Security (vs claude-mem)

| Issue | claude-mem | Claudeye |
|-------|-----------|----------|
| Unauthenticated HTTP API | Always running | No daemon |
| Open port 37777 | Always | Only when `claudeye viewer` |
| API keys in GET response | Cleartext | No settings API endpoint |
| Path traversal via MCP | Unfixed | No MCP server |
| Credential file permissions | 0644 | 0600 |

---

## Cost

AI compression uses `claude --print` CLI — **no API cost**, uses your
existing Claude Code subscription.

Embeddings (optional, for semantic search):
- **OpenAI** `text-embedding-3-small` (1536 dims) — default, ~100 tool events/day ≈ **$0.0003/day**, one year ≈ **$0.10 total**
- **Voyage AI** `voyage-3-lite` (512 dims) / `voyage-code-3` (1024 dims) — alternative provider, ~$0.00002/1K tokens
- **Keyword fallback** (128 dims) — no key, zero cost, rough similarity only

Select via `settings.embedding_provider` (`openai` | `voyage` | `fallback`) or auto-detect from whichever key is present. See `src/embeddings.js` (#41).

---

## Roadmap

> Synced with [GitHub Project #4](https://github.com/users/leetio-varsha/projects/4). Each issue has readiness criteria — the daily analyzer checks them automatically.
>
> **Dependency notation:** `← #N` means "blocked by issue #N".

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
- [x] Backfill friction scores for historical sessions (#73)
- [x] npm test — node:test runner with 29 tests (#72)
- [x] GitHub Actions CI — automated tests on push (#66) ← #72
- [x] Tool distribution anomaly — git-commit filtered from analytics (#67)
- [x] DB auto-compact — daily auto-compact at 150MB, alert at 250MB (#74, threshold raised 2026-05-04)

### Phase 2.6: Stability gate (May 2026)

Goal: 14 consecutive days of all-green invariants → Beta MVP unblocked.

- [ ] Invariants-mode analyzer — checklist replaces open-ended bug discovery (#99)
- [ ] Regression policy — every closed bug-issue ships with `test/issue-N.test.js` (#100)
- [x] Smoke regression tests for top recurrence classes — schedulers, schema migrations, session tracking
- [x] Behavioral advisor TCC fix — standalone wrapper in `~/.claudeye/` (follow-up to #87)

### Phase 3: Agent v1 (April-May 2026)

- [ ] Local agent mode: background analysis and proactive actions (#18) ← #15, #16
- [x] One agent, one use-case, full cycle through Claudeye (#20) ← #15, #16
- [x] Feedback loop: system learns from its own actions (#21) — accept/reject capture, effectiveness + rejection-rate tuning, weekly digest, time-saved-vs-review metric, advisor learning
- [ ] Routing + Control: anti-chaos (1 agent, strict context, kill switch) (#22) ← #20

### Phase 4: Import Layer & Integrations (May 2026)

- [x] Notion import (#9)
- [x] Jira/Linear import (#10)
- [ ] Memory export as markdown (#11)
- [ ] Read-first integrations (#23): GitHub ✓, Jira ✓, Slack ✓, Sentry ✓ — left: GitLab, Gmail; write-phase not started

### Phase 5: Team Foundation (May-June 2026)

- [ ] Postgres + pgvector — team backend (#12)
- [ ] API auth + multi-user (#13) ← #12
- [ ] Team Sync Layer — local SQLite → shared DB, aggregates only (#34) ← #12, #13
- [ ] Team Roles & Access — dev / tech lead / admin (#35) ← #13
- [ ] Landing page + pricing (#14)
- [x] Multi-provider embeddings: OpenAI + Voyage + keyword fallback (#41)

### Phase 5.5: Team UX (June 2026)

All items depend on Team Sync Layer (#34) + Team Roles (#35):

- [ ] Team Auto-Setup — `npx claudeye join <token>` (#36) ← #34, #35
- [ ] Team Dashboard — friction heatmap, tool ROI, standardization (#37) ← #34, #35
- [ ] Team CLAUDE.md — hierarchical: global → team → project → personal (#38) ← #34
- [ ] Team Analytics — aggregated advisor for the whole team (#39) ← #34 (needs 2+ weeks of team data)
- [ ] Shared Knowledge Base — privacy-first knowledge sharing (#40) ← #34

### Phase 6: Autopilot (July+ 2026)

- [ ] Partial automation with control: auto triage, reports, tasks (#24)

### Phase 7: Digital Twin (Q4 2026+)

- [ ] Developer model: style, decisions, partial delegation (#29)

### Cross-phase (gradual)

- [ ] Knowledge Graph: entity relationships (#26)
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

**Strategy:** core → value → one agent → learning → scale

**Evolution:** memory tool → self-improving system → team platform → personal AI OS → digital twin

---

## License

MIT
