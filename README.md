# Claudeye

**See how you work. Work better.**

Claudeye gives Claude Code a memory and shows you how to use it better.
It captures everything across your sessions, surfaces relevant context when you need it,
and analyzes your AI workflow patterns to show you exactly where you're fast,
where you're stuck, and how to improve.

---

## Two parts

### 🧠 Memory
Claude Code forgets everything when a session ends. Claudeye doesn't.

- Captures every tool event, compressed by AI into searchable observations
- Injects relevant past context before each new prompt automatically
- Works across all your projects — ask "how did we solve this in project X"
  and get a grounded answer, not a hallucination

### 📊 Analytics + Advisor
Raw usage data turned into actionable insight.

- **Friction scores** per session and project — where are you struggling?
- **Plugin effectiveness** — is Superpowers actually helping, or just slowing you down?
- **Model comparison** — when does Opus outperform Sonnet for your work?
- **Issue resolution time** — how long do bugs actually take to fix?
- **Weekly digest** — Claude analyzes your patterns and tells you what to change

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

## Setup

```bash
# 1. Clone and install
git clone https://github.com/yourname/claudeye
cd claudeye
npm install

# 2. Link CLI globally
npm link

# 3. Configure
claudeye setup        # enter OpenAI key for embeddings (optional but recommended)

# 4. Install hooks into Claude Code
claudeye install-hooks

# 5. Restart Claude Code
```

---

## Usage

```bash
# Memory
claudeye search "how we fixed the auth bug"   # hybrid search across all projects
claudeye recent                               # last 15 observations, current project
claudeye sessions                             # browse session history
claudeye viewer                               # web UI at localhost:47777

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
├── mem.db          # SQLite database (WAL mode)
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

## Security (vs claude-mem)

| Issue | claude-mem | Claudeye |
|-------|-----------|----------|
| Unauthenticated HTTP API | ✗ Always running | ✓ No daemon |
| Open port 37777 | ✗ Always | ✓ Only when `claudeye viewer` |
| API keys in GET response | ✗ Cleartext | ✓ No settings API endpoint |
| Path traversal via MCP | ✗ Unfixed | ✓ No MCP server |
| Credential file permissions | ✗ 0644 | ✓ 0600 |

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

- [x] Core memory hooks (save, inject, summarize)
- [x] Hybrid FTS5 + vector search with RRF
- [x] AI compression via Claude CLI
- [x] Analytics computation layer
- [x] Plugin + model effectiveness comparison
- [x] Issue auto-detection and lifecycle tracking
- [x] On-demand advisor (`claudeye advise`)
- [x] Weekly digest generation
- [ ] Fix critical gaps (see CLAUDE.md)
- [ ] Web dashboard analytics tabs
- [ ] Weekly digest launchd automation
- [ ] Per-project `.claudeye` config
- [ ] `claudeye export` — memory as markdown
- [ ] Team sharing via shared Postgres

---

## License

MIT
