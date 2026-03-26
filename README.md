# Claudeye

**See how you work. Work better.**

Claudeye gives Claude Code a memory and shows you how to use it better.
It captures everything across your sessions, surfaces relevant context when you need it,
analyzes your AI workflow patterns, and recommends what to automate in your entire dev workflow.

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
```

Repeat for each project you want Claudeye to know about.

---

## Three parts

### 1. Memory

Claude Code forgets everything when a session ends. Claudeye doesn't.

- Captures every tool event, compressed by AI into searchable observations
- Injects relevant past context before each new prompt automatically
- Works across all your projects — ask "how did we solve this in project X"
  and get a grounded answer, not a hallucination

### 2. Analytics + Advisor

Raw usage data turned into actionable insight.

- **Friction scores** per session and project — where are you struggling?
- **Plugin effectiveness** — is Superpowers actually helping, or just slowing you down?
- **Model comparison** — when does Opus outperform Sonnet for your work?
- **Issue resolution time** — how long do bugs actually take to fix?
- **Weekly digest** — Claude analyzes your patterns and tells you what to change

### 3. Automation Advisor (coming soon)

Analyzes your entire dev workflow — not just Claude Code — and recommends what to automate.

- **Task management** — detects repeated issue creation, stale tickets, sprint grooming patterns
- **Code review** — spots PRs waiting too long, repeated review comments, missing checks
- **Monitoring** — CI/CD status checks, branch divergence, dependency updates
- **Documentation** — README/CHANGELOG drift, release notes generation
- **Communications** — standup generation, weekly digests, Slack notifications
- **Dev operations** — merged branch cleanup, test scheduling, database checks

Each recommendation includes: automation type (Scheduler / Hook / Agent / Script / MCP / GitHub Action),
estimated time savings, and implementation complexity.

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

# Import
claudeye import git                           # import git history from current repo
claudeye import git --path /other/repo        # from another repo
claudeye import notion                        # (coming soon — Issue #9)
claudeye import jira                          # (coming soon — Issue #10)

# Analytics
claudeye analytics                            # global overview
claudeye analytics --plugins                  # plugin effectiveness matrix
claudeye analytics --models                   # model comparison
claudeye analytics --issues                   # issue resolution metrics
claudeye analytics --hotspots                 # most complex files/areas

# Advisor
claudeye advise                               # AI-powered workflow recommendations
claudeye advise --focus plugins               # focused on plugin usage
claudeye rate                                 # rate a session 1-5
claudeye digest                               # latest weekly digest
claudeye digest --generate                    # generate now
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

Claudeye includes a scheduled analyzer (via Cowork) that runs daily with 4 tracks:

| Track | What it does |
|-------|-------------|
| **A: Codebase** | Finds bugs, code quality issues, security gaps, missing features |
| **B: Usage patterns** | Analyzes mem.db for friction hotspots, repeated actions |
| **C: Workflow** | Scans git + GitHub for PR/issue patterns, recommends automations |
| **D: Readiness** | Checks each issue's start criteria, comments when ready |

The analyzer auto-creates GitHub issues and adds them to the project board.

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
- OpenAI `text-embedding-3-small`
- ~100 tool events/day → **$0.0003/day**
- One full year of heavy use → **~$0.10 total**

---

## Roadmap

### Phase 1: Dogfooding Foundation (March 2026)
- [x] Core memory hooks (save, inject, summarize)
- [x] Hybrid FTS5 + vector search with RRF
- [x] AI compression via Claude CLI
- [x] Analytics computation layer
- [x] Git history import
- [ ] Switch to better-sqlite3 for native FTS5 (#1)
- [ ] E2E hook testing (#2, #3)
- [ ] First real git import on own repos (#4)

### Phase 2: Polish & Fix (April 2026, after 2 weeks dogfooding)
- [ ] Retention policy (#5)
- [ ] Private tag support (#6)
- [ ] Dashboard polish with Chart.js (#7)
- [ ] Weekly digest automation (#8)

### Phase 2.5: Advisor Foundation (April 2026)
- [ ] Structured advisor output — JSON format (#17)
- [ ] Auto-issues from advisor (#15)
- [ ] Automation advisor — full workflow analysis (#16)

### Phase 3: Import Layer (late April 2026)
- [ ] Notion import (#9)
- [ ] Jira/Linear import (#10)
- [ ] Memory export as markdown (#11)

### Phase 4: Team Prep (May-June 2026)
- [ ] Postgres + pgvector (#12)
- [ ] API auth + multi-user (#13)
- [ ] Landing page + pricing (#14)
- [ ] Local agent mode (#18)

### Phase 5: Agent v1 (June-July 2026)
- [ ] Pattern detection: repeat-fix detector, file hotspots (#19)
- [ ] One agent, one use-case, full cycle through Claudeye (#20)
- [ ] Feedback loop: system learns from its own actions (#21)
- [ ] Routing + Control: anti-chaos (1 agent, strict context, kill switch) (#22)

### Phase 6: Integrations (July-August 2026)
- [ ] Read-first: GitLab, Jira, Slack, Gmail, Sentry (#23)

### Phase 7: Autopilot (August+ 2026)
- [ ] Partial automation with control: auto triage, reports, tasks (#24)

**Strategy:** core -> value -> one agent -> learning -> scale

All issues have readiness criteria — the daily analyzer checks them automatically.

---

## License

MIT
