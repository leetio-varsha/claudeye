#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::path::PathBuf;
use std::process::Command;

use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Manager, Emitter};

fn db_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_default()
        .join(".claudeye")
        .join("mem.db")
}

fn open_ro() -> Option<Connection> {
    Connection::open_with_flags(db_path(), OpenFlags::SQLITE_OPEN_READ_ONLY).ok()
}

fn scalar_i64(conn: &Connection, sql: &str) -> i64 {
    conn.query_row(sql, [], |r| r.get::<_, i64>(0)).unwrap_or(0)
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct Health {
    hooks_up: bool,
    last_obs: String,
    obs24h: i64,
    sessions7d: i64,
    projects: i64,
    quota: String,
    emb_pct: i64,
    streak: i64,
    db_mb: i64,
}

#[tauri::command]
fn dashboard_summary() -> Health {
    let mut h = Health {
        hooks_up: false,
        last_obs: "—".into(),
        quota: "—".into(),
        ..Default::default()
    };

    if let Ok(meta) = fs::metadata(db_path()) {
        h.db_mb = (meta.len() / (1024 * 1024)) as i64;
    }

    let conn = match open_ro() {
        Some(c) => c,
        None => return h,
    };

    h.obs24h = scalar_i64(
        &conn,
        "SELECT COUNT(*) FROM observations WHERE created_at >= datetime('now','-1 day')",
    );
    h.sessions7d = scalar_i64(
        &conn,
        "SELECT COUNT(*) FROM sessions WHERE started_at >= datetime('now','-7 day')",
    );
    h.projects = scalar_i64(
        &conn,
        "SELECT COUNT(DISTINCT project) FROM sessions WHERE started_at >= datetime('now','-7 day')",
    );

    let obs_total = scalar_i64(&conn, "SELECT COUNT(*) FROM observations");
    let emb_total = scalar_i64(&conn, "SELECT COUNT(*) FROM embeddings");
    h.emb_pct = if obs_total > 0 {
        ((emb_total as f64 / obs_total as f64) * 100.0).round() as i64
    } else {
        0
    };

    if let Ok(last) = conn.query_row(
        "SELECT created_at FROM observations ORDER BY created_at DESC LIMIT 1",
        [],
        |r| r.get::<_, String>(0),
    ) {
        h.last_obs = last;
    }
    let gap_hours = scalar_i64(
        &conn,
        "SELECT CAST((julianday('now') - julianday(MAX(created_at))) * 24 AS INTEGER) FROM observations",
    );
    h.hooks_up = gap_hours <= 48;

    h.streak = scalar_i64(
        &conn,
        "SELECT COUNT(*) FROM (
            SELECT all_green, ROW_NUMBER() OVER (ORDER BY run_date DESC) AS rn,
                   SUM(CASE WHEN all_green = 0 THEN 1 ELSE 0 END)
                     OVER (ORDER BY run_date DESC) AS breaks
            FROM invariant_checks
         ) WHERE breaks = 0 AND all_green = 1",
    );

    // темп: среднее obs/день за 3 дня против предыдущей недели
    let recent = scalar_i64(
        &conn,
        "SELECT COUNT(*) FROM observations WHERE created_at >= datetime('now','-3 day')",
    ) as f64
        / 3.0;
    let base = scalar_i64(
        &conn,
        "SELECT COUNT(*) FROM observations
         WHERE created_at >= datetime('now','-10 day') AND created_at < datetime('now','-3 day')",
    ) as f64
        / 7.0;
    h.quota = if base > 0.0 && recent / base >= 1.3 {
        format!("{:.1}×", recent / base)
    } else {
        "норма".into()
    };
    h
}

#[derive(Serialize, Default)]
struct Activity {
    labels: Vec<String>,
    values: Vec<i64>,
}

#[tauri::command]
fn activity_14d() -> Activity {
    let mut a = Activity::default();
    let conn = match open_ro() {
        Some(c) => c,
        None => return a,
    };
    // дни без наблюдений отдаём нулями — иначе ось X с дырками
    let mut stmt = match conn.prepare(
        "WITH RECURSIVE days(d) AS (
            SELECT date('now','-13 day')
            UNION ALL SELECT date(d, '+1 day') FROM days WHERE d < date('now')
         )
         SELECT strftime('%d', d), COALESCE(cnt, 0)
         FROM days
         LEFT JOIN (
            SELECT date(created_at) AS dd, COUNT(*) AS cnt
            FROM observations
            WHERE created_at >= date('now','-13 day')
            GROUP BY dd
         ) ON dd = d
         ORDER BY d",
    ) {
        Ok(s) => s,
        Err(_) => return a,
    };
    let rows = stmt.query_map([], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
    });
    if let Ok(rows) = rows {
        for row in rows.flatten() {
            a.labels.push(row.0);
            a.values.push(row.1);
        }
    }
    a
}

/// Одна строка ленты уведомлений (#131).
///
/// `status` / `hash` нужны фронту (`view-format.js → notificationsViewModel`)
/// для дедупа и для решения, слать ли нативную нотификацию:
///   - status — 'new'|'shown'|'dismissed'|'accepted'|'applied' (колонка advises.status);
///              у alerts из insights такой колонки нет → всегда "new";
///   - hash   — advises.observation_hash; у alerts пусто, фронт падает на
///              фолбэк-ключ sev+title.
#[derive(Serialize)]
struct Notif {
    sev: String,
    title: String,
    meta: String,
    status: String,
    hash: String,
}

/// Лента = критичные/важные alerts из последнего прогона insights
/// + поведенческие advises (таблица `advises`), новейшие первыми.
///
/// Severity для advises берём из `confidence`: high→warn, medium→info, low→mut.
/// `crit` сознательно НЕ выдаём — критический уровень зарезервирован за
/// alerts из insights, только он поднимает нативную нотификацию (#131).
#[tauri::command]
fn recent_notifications() -> Vec<Notif> {
    let mut out = Vec::new();
    let conn = match open_ro() {
        Some(c) => c,
        None => return out,
    };
    let latest: Option<(String, String)> = conn
        .query_row(
            "SELECT alerts, created_at FROM insights ORDER BY created_at DESC LIMIT 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .ok();
    if let Some((json, created_at)) = latest {
        if let Ok(arr) = serde_json::from_str::<Vec<serde_json::Value>>(&json) {
            for a in arr.into_iter().take(12) {
                let severity = a.get("severity").and_then(|v| v.as_str()).unwrap_or("insight");
                let sev = match severity {
                    "critical" => "crit",
                    "warning" => "warn",
                    "insight" => "info",
                    _ => "mut",
                };
                out.push(Notif {
                    sev: sev.into(),
                    title: a
                        .get("title")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    meta: created_at.clone(),
                    status: "new".into(),
                    hash: String::new(),
                });
            }
        }
    }

    if let Ok(mut stmt) = conn.prepare(
        "SELECT observation, created_at, status, observation_hash, confidence
           FROM advises
          WHERE status != 'dismissed'
          ORDER BY created_at DESC
          LIMIT 20",
    ) {
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
            ))
        });
        if let Ok(rows) = rows {
            for row in rows.flatten() {
                let (observation, created_at, status, hash, confidence) = row;
                let sev = match confidence.as_str() {
                    "high" => "warn",
                    "medium" => "info",
                    _ => "mut",
                };
                out.push(Notif {
                    sev: sev.into(),
                    title: observation,
                    meta: created_at,
                    status,
                    hash,
                });
            }
        }
    }

    out
}

#[derive(Serialize)]
struct Sess {
    id: String,
    project: String,
    summary: String,
    prompts: i64,
    ended: String,
}

#[tauri::command]
fn recent_sessions(limit: Option<i64>) -> Vec<Sess> {
    let mut out = Vec::new();
    let conn = match open_ro() {
        Some(c) => c,
        None => return out,
    };
    let lim = limit.unwrap_or(12);
    // import-git сессии (0 промптов, служебные) — шум для этого вью
    let mut stmt = match conn.prepare(
        "SELECT id, project, COALESCE(summary,''), prompt_count,
                COALESCE(ended_at, started_at)
         FROM sessions
         WHERE id NOT LIKE 'import-%'
           AND NOT (prompt_count = 0 AND summary LIKE 'Git import:%')
         ORDER BY started_at DESC LIMIT ?1",
    ) {
        Ok(s) => s,
        Err(_) => return out,
    };
    let rows = stmt.query_map([lim], |r| {
        Ok(Sess {
            id: r.get(0)?,
            project: r.get(1)?,
            summary: r.get(2)?,
            prompts: r.get(3)?,
            ended: r.get(4)?,
        })
    });
    if let Ok(rows) = rows {
        for s in rows.flatten() {
            out.push(s);
        }
    }
    out
}

/// Одно наблюдение для drill-in / поиска (#132).
///
/// ⚠️ AUP: сюда НЕ попадают `raw_input` / `raw_output` — только AI-сжатый
/// `summary`, `decision_rationale` (#25 Decision Memory), теги и метаданные.
/// Тот же safe-набор колонок, что отдаёт `recentObservations` в src/db.js.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Obs {
    id: i64,
    summary: String,
    tool: String,
    tags: String,
    importance: f64,
    rationale: String,
    created_at: String,
    project: String,
}

/// Полный drill-in по сессии: метаданные + её наблюдения (#132).
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct SessionDetail {
    id: String,
    project: String,
    summary: String,
    started: String,
    ended: String,
    prompts: i64,
    observations: Vec<Obs>,
}

/// Наблюдения одной сессии из mem.db, новейшие первыми.
/// Читаем только safe-колонки (без raw_input/raw_output — AUP).
#[tauri::command]
fn session_detail(id: String) -> SessionDetail {
    let mut d = SessionDetail::default();
    let conn = match open_ro() {
        Some(c) => c,
        None => return d,
    };

    if let Ok((project, summary, started, ended, prompts)) = conn.query_row(
        "SELECT project, COALESCE(summary,''), started_at,
                COALESCE(ended_at, ''), prompt_count
         FROM sessions WHERE id = ?1",
        [&id],
        |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, i64>(4)?,
            ))
        },
    ) {
        d.id = id.clone();
        d.project = project;
        d.summary = summary;
        d.started = started;
        d.ended = ended;
        d.prompts = prompts;
    } else {
        return d; // нет такой сессии — пустой detail
    }

    if let Ok(mut stmt) = conn.prepare(
        "SELECT id, summary, tool, tags, importance,
                COALESCE(decision_rationale, ''), created_at, project
         FROM observations
         WHERE session_id = ?1
         ORDER BY created_at DESC, id DESC
         LIMIT 300",
    ) {
        let rows = stmt.query_map([&id], |r| {
            Ok(Obs {
                id: r.get(0)?,
                summary: r.get(1)?,
                tool: r.get(2)?,
                tags: r.get(3)?,
                importance: r.get(4)?,
                rationale: r.get(5)?,
                created_at: r.get(6)?,
                project: r.get(7)?,
            })
        });
        if let Ok(rows) = rows {
            for o in rows.flatten() {
                d.observations.push(o);
            }
        }
    }
    d
}

/// Полнотекстовый поиск по памяти через FTS5 `fts_obs` (#132).
///
/// Зеркалит `ftsSearch` из src/db.js: чистим не-словарные символы, режем на
/// слова и склеиваем через OR (recall важнее precision для drill-in),
/// сортируем по bm25. Возвращаем тот же safe-набор колонок, что и drill-in.
#[tauri::command]
fn search_memory(query: String, limit: Option<i64>) -> Vec<Obs> {
    let mut out = Vec::new();
    let conn = match open_ro() {
        Some(c) => c,
        None => return out,
    };
    // sanitize: не-словарные символы → пробел, разбить на слова, склеить OR
    let cleaned: String = query
        .chars()
        .map(|c| if c.is_alphanumeric() || c.is_whitespace() { c } else { ' ' })
        .collect();
    let terms: Vec<&str> = cleaned.split_whitespace().filter(|s| !s.is_empty()).collect();
    if terms.is_empty() {
        return out;
    }
    let fts_query = terms.join(" OR ");
    let lim = limit.unwrap_or(30);

    if let Ok(mut stmt) = conn.prepare(
        "SELECT o.id, o.summary, o.tool, o.tags, o.importance,
                COALESCE(o.decision_rationale, ''), o.created_at, o.project
         FROM fts_obs
         JOIN observations o ON o.id = fts_obs.rowid
         WHERE fts_obs MATCH ?1
         ORDER BY bm25(fts_obs) LIMIT ?2",
    ) {
        let rows = stmt.query_map(rusqlite::params![fts_query, lim], |r| {
            Ok(Obs {
                id: r.get(0)?,
                summary: r.get(1)?,
                tool: r.get(2)?,
                tags: r.get(3)?,
                importance: r.get(4)?,
                rationale: r.get(5)?,
                created_at: r.get(6)?,
                project: r.get(7)?,
            })
        });
        if let Ok(rows) = rows {
            for o in rows.flatten() {
                out.push(o);
            }
        }
    }
    out
}

fn run_claudeye(args: &[&str]) -> String {
    match Command::new("claudeye").args(args).output() {
        Ok(o) => String::from_utf8_lossy(&o.stdout).to_string(),
        Err(e) => format!("error: {e}"),
    }
}

#[tauri::command]
fn cmd_reindex() -> String {
    run_claudeye(&["reindex"])
}

#[tauri::command]
fn cmd_cleanup() -> String {
    run_claudeye(&["cleanup"])
}

#[tauri::command]
fn cmd_digest() -> String {
    run_claudeye(&["digest", "--generate"])
}

#[tauri::command]
fn cmd_agents_status() -> String {
    // --json → структурированный вывод для UI (renderAgentsPanel парсит его);
    // человекочитаемый цветной формат остаётся у CLI без флага.
    run_claudeye(&["scheduler", "status", "--json"])
}

#[tauri::command]
fn cmd_open_board() -> String {
    "https://github.com/users/leetio-varsha/projects/4".into()
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .setup(|app| {
            let show = MenuItem::with_id(app, "show", "Показать / скрыть окно", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Выйти", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => app.exit(0),
                    // readiness (#133): tray сворачивает/разворачивает окно —
                    // видимое прячем, скрытое показываем и фокусируем.
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            if w.is_visible().unwrap_or(false) {
                                let _ = w.hide();
                            } else {
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                        }
                    }
                    _ => {}
                })
                .build(app)?;

            if let Some(w) = app.get_webview_window("main") {
                let _ = w.emit("ready", ());
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            dashboard_summary,
            activity_14d,
            recent_notifications,
            recent_sessions,
            session_detail,
            search_memory,
            cmd_reindex,
            cmd_cleanup,
            cmd_digest,
            cmd_agents_status,
            cmd_open_board
        ])
        .run(tauri::generate_context!())
        .expect("error while running Claudeye Desktop");
}
