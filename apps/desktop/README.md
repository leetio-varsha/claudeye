# Claudeye Desktop

Нативное macOS-приложение (Tauri v2) в стиле Tahoe / Liquid Glass поверх
`~/.claudeye/mem.db`. Заменяет эфемерные macOS-попапы постоянным дашбордом +
центром уведомлений и панелью управления.

## Стек

- **Shell:** Tauri v2 (Rust), tray/menu-bar, transparent + overlay title bar (`macOSPrivateApi`), нативные нотификации.
- **Bridge:** Rust-команды на `rusqlite` читают `mem.db` в read-only. CLI-действия (`reindex`, `cleanup`, `digest`) через `std::process::Command`.
- **Frontend:** no-build статика в `ui/` (`frontendDist`), vanilla JS + вендорный Chart.js (`ui/vendor/chart.umd.js`). Без Vite/esbuild — компилируется только Rust. `withGlobalTauri: true` даёт `window.__TAURI__` в обычном `<script>`. Degradeит на демо-данные вне Tauri.

## Вью (v1)

1. **Обзор** — KPI + график активности 14д + последние уведомления.
2. **Сессии** — список сессий Claude Code / Cowork, drill-in, поиск по памяти.
3. **Уведомления** — лента insights/alerts вместо попапов; critical дублируется нативной нотификацией.
4. **Управление** — reindex / cleanup / digest / статус агентов / board.

## Запуск (dev, с терминалом)

Требуется Node 20+ и Rust toolchain (`rustup`).

```bash
cd apps/desktop
npm install        # только @tauri-apps/cli (без install-скриптов)
npm run tauri dev
```

## Сборка в приложение (без терминала)

```bash
npm run tauri build
# → src-tauri/target/release/bundle/macos/Claudeye.app  (+ dmg)
```

Перетащить `Claudeye.app` в `/Applications` — запускается из Launchpad как обычная программа.

## Rust-команды (bridge)

| Команда | SQL / действие |
|---|---|
| `dashboard_summary` | obs/24ч, сессии/7д, проекты, emb %, размер БД, hooks_up, health streak |
| `activity_14d` | наблюдения по дням за 14 дней |
| `recent_notifications` | последний ряд `insights.alerts` (+ маппинг severity) |
| `recent_sessions(limit)` | `sessions` по `started_at DESC` |
| `cmd_reindex` / `cmd_cleanup` / `cmd_digest` | `claudeye <cmd>` |
| `cmd_agents_status` | `claudeye scheduler status` |

## Статус

v1 запускается (`tauri dev`, Rust компилируется чисто ~38с). Frontend читает
живой `mem.db` через `invoke`. **#129 (frontend UI) и #130 (rust-bridge)
закрыты**: 4 вью, адаптив вплоть до `minWidth 720` (сайдбар сворачивается в
иконочный рельс ≤760px), view-aware лоадер-скелетон, refresh-спиннер, пустые
состояния. Открытые задачи: #131 (нативные actionable-нотификации),
#132 (session mgmt), #133 (controls+tray), #134 (packaging — последним).
