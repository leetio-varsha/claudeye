# Claudeye Desktop

A native macOS app (Tauri v2) in a Tahoe / Liquid Glass style on top of
`~/.claudeye/mem.db`. It replaces ephemeral macOS popups with a persistent
dashboard, a notification center and a control panel.

## Stack

- **Shell:** Tauri v2 (Rust), tray / menu-bar icon, transparent + overlay title bar (`macOSPrivateApi`), native notifications.
- **Bridge:** Rust commands on `rusqlite` read `mem.db` read-only. CLI actions (`reindex`, `cleanup`, `digest`) run through `std::process::Command`.
- **Frontend:** no-build static files in `ui/` (`frontendDist`), vanilla JS + a vendored Chart.js (`ui/vendor/chart.umd.js`). No Vite/esbuild — only the Rust side is compiled. `withGlobalTauri: true` exposes `window.__TAURI__` to a plain `<script>`. Outside Tauri the frontend degrades to demo data.

## Views (v1)

1. **Overview** — KPIs + 14-day activity chart + latest notifications.
2. **Sessions** — Claude Code / Cowork sessions, drill-in, memory search.
3. **Notifications** — insights/alerts feed instead of popups; critical alerts are mirrored as native notifications.
4. **Controls** — reindex / cleanup / digest / agent status / project board.

## Run (dev, with a terminal)

Requires Node 20+ and the Rust toolchain (`rustup`).

```bash
cd apps/desktop
npm install        # only @tauri-apps/cli (no install scripts)
npm run tauri dev
```

## Build the app bundle

```bash
npm run tauri build
# → src-tauri/target/release/bundle/macos/Claudeye.app  (+ dmg)
```

Drag `Claudeye.app` into `/Applications`; it launches from Launchpad like any other app.

## Rust commands (bridge)

| Command | SQL / action |
|---|---|
| `dashboard_summary` | obs/24h, sessions/7d, projects, embedding %, DB size, hooks_up, health streak |
| `activity_14d` | observations per day for the last 14 days |
| `recent_notifications` | latest `insights.alerts` row merged with `advises` (+ severity mapping) |
| `recent_sessions(limit)` | `sessions` ordered by `started_at DESC` |
| `session_detail(id)` | session metadata + its observations (safe columns only, newest first) |
| `search_memory(query, limit)` | FTS5 search over `fts_obs`, mirrors `ftsSearch` in `src/db.js` |
| `cmd_reindex` / `cmd_cleanup` / `cmd_digest` | `claudeye <cmd>` |
| `cmd_agents_status` | `claudeye scheduler status --json` (parsed by the UI) |

Pure presentation helpers live in `ui/view-format.js` (loaded as a classic
script before `app.js`, no DOM access) and are covered by
`test/desktop-view-format.test.js` in the root test suite.

Packaging (DMG, code signing, notarization) is not done yet.
