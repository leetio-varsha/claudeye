# Claudeye — project context for Claude Code

Claudeye is a personal behavioral layer for AI work. Claude Code hooks persist every tool event into a local SQLite database (`~/.claudeye/mem.db`), compress and embed it, and inject relevant context back into later prompts. On top of that memory sit rule-based insights, a Claude-powered behavioral advisor, and integrations that import context from git, GitHub, Jira, Linear, Notion, Slack and Sentry. See `README.md` for the product overview and `ANALYTICS_DESIGN.md` / `docs/` for design notes.

## Repository layout

- `cli.js` — single commander entrypoint (`claudeye ...`): setup, hooks, search, import, analytics, advisor, scheduler, export, agent, workflow commands.
- `src/` — library code. Key modules: `db.js` (schema, migrations, all SQLite access), `compress.js` (AI compression via `claude --print`), `embeddings.js` + `quantize.js` (multi-provider vectors, int8 storage), `search.js` (hybrid FTS5 + cosine search with RRF fusion), `analytics.js` / `patterns.js` / `advisor.js` / `behavioral-advisor.js`, `import-*.js` (external sources), `server.js` (opt-in Express viewer on localhost:47777).
- `hooks/` — Claude Code hook scripts: `save-hook.js` (PostToolUse), `inject-hook.js` (UserPromptSubmit), `summary-hook.js` (Stop), `git-post-commit.js`.
- `scripts/` — setup and maintenance: `setup.js`, `install-hooks.js`, launchd schedulers (`*-scheduler.js`) and the TCC-safe `*-standalone.*` runners they copy into `~/.claudeye/`, backfills, one-off reports.
- `apps/desktop/` — Claudeye Desktop, a Tauri v2 macOS app: Rust bridge in `src-tauri/` reads `mem.db` read-only; the frontend in `ui/` is no-build vanilla JS (no bundler). Pure view helpers live in `ui/view-format.js`.
- `test/` — `node:test` suites (`*.test.js`), including regression tests named `regression-*.test.js` / `issue-N.test.js`.
- `.github/workflows/` — CI (`npm test` on Node 18/20/22) and the regression-test gate for bug-fix PRs.

## Running things

```bash
npm install
npm test                      # node --test test/*.test.js
node cli.js --help            # or `npm link` to get a global `claudeye`
claudeye setup                # writes ~/.claudeye/settings.json (mode 0600)
claudeye install-hooks        # patches ~/.claude/settings.json
claudeye viewer               # web UI, localhost only
cd apps/desktop && npm install && npm run tauri dev   # needs Rust toolchain
```

All runtime data lives in `~/.claudeye/` (mode 0700). Tests must not touch it; use temp databases.

## Principles

- Never block Claude Code: hooks always exit 0, memory failure is a silent skip.
- No open ports by default; the viewer is opt-in and binds to localhost. Share links expose aggregates only, never raw tool input/output.
- AI calls go through the `claude` CLI (`claude --print`), not an API key. Embeddings are pluggable (OpenAI, Voyage, keyword-hash fallback).
- The desktop app reads only compressed summaries and metadata; `raw_input` / `raw_output` never leave the database.

## Conventions

- ESM throughout, Node >= 20. No build step for the CLI or the desktop frontend.
- Everything committed is in English: code, comments, docs, commit messages.
- Regression policy: a PR that fixes an issue labelled `bug` must add or extend a regression test (`test/issue-N.test.js` or `test/regression-*.test.js`). Add `regression: skip` to the PR title to opt out with a justification. CI enforces this.
- Desktop frontend gotchas: Tauri v2 injects globals such as `window.isTauri`, and WebKit aborts the whole script on a top-level declaration that shadows one, so never declare top-level variables with Tauri global names (the app uses `inTauri`). Keep `ui/view-format.js` free of raw control bytes (write separators as `\u0000` escapes) so git treats it as text; a test guards this.
