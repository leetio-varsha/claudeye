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

    h.quota = "нормально".into();
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
    let mut stmt = match conn.prepare(
        "SELECT strftime('%d', created_at) AS d, COUNT(*)
         FROM observations
         WHERE created_at >= datetime('now','-14 day')
         GROUP BY date(created_at) ORDER BY date(created_at)",
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

#[derive(Serialize)]
struct Notif {
    sev: String,
    title: String,
    meta: String,
}

#[tauri::command]
fn recent_notifications() -> Vec<Notif> {
    let mut out = Vec::new();
    let conn = match open_ro() {
        Some(c) => c,
        None => return out,
    };
    let latest: Option<String> = conn
        .query_row(
            "SELECT alerts FROM insights ORDER BY created_at DESC LIMIT 1",
            [],
            |r| r.get(0),
        )
        .ok();
    if let Some(json) = latest {
        if let Ok(arr) = serde_json::from_str::<Vec<serde_json::Value>>(&json) {
            for a in arr.into_iter().take(12) {
                let severity = a.get("severity").and_then(|v| v.as_str()).unwrap_or("insight");
                let sev = match severity {
                    "critical" => "warn",
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
                    meta: severity.to_string(),
                });
            }
        }
    }
    out
}

#[derive(Serialize)]
struct Sess {
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
    let mut stmt = match conn.prepare(
        "SELECT project, COALESCE(summary,''), prompt_count,
                COALESCE(ended_at, started_at)
         FROM sessions ORDER BY started_at DESC LIMIT ?1",
    ) {
        Ok(s) => s,
        Err(_) => return out,
    };
    let rows = stmt.query_map([lim], |r| {
        Ok(Sess {
            project: r.get(0)?,
            summary: r.get(1)?,
            prompts: r.get(2)?,
            ended: r.get(3)?,
        })
    });
    if let Ok(rows) = rows {
        for s in rows.flatten() {
            out.push(s);
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
    run_claudeye(&["scheduler", "status"])
}

#[tauri::command]
fn cmd_open_board() -> String {
    "https://github.com/users/leetio-varsha/projects/4".into()
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let show = MenuItem::with_id(app, "show", "Открыть Claudeye", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Выйти", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => app.exit(0),
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
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
            cmd_reindex,
            cmd_cleanup,
            cmd_digest,
            cmd_agents_status,
            cmd_open_board
        ])
        .run(tauri::generate_context!())
        .expect("error while running Claudeye Desktop");
}
