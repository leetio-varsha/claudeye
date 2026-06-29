#!/usr/bin/env node
/**
 * insights-standalone.mjs — Standalone daily insights generator (#82)
 *
 * Runs independently of the main claudeye CLI to avoid TCC restrictions
 * when executed from launchd. Copied to ~/.claudeye/ and accesses only
 * ~/.claudeye/mem.db — no ~/Documents access needed.
 *
 * Writes a row to the `insights` table so the daily scheduler never "goes silent"
 * without leaving evidence. Alerts are simplified (quota, friction, infra) —
 * a subset of what scripts/daily-insights.js produces, but without reliance
 * on the full project tree.
 *
 * Fix for #82: launchd wasn't configured at all, so insights just stopped.
 * We now install a plist that runs this script daily at 09:00.
 *
 * NOTE: Copied as .mjs to ~/.claudeye/ to work regardless of package.json type.
 */

import { createRequire } from 'module';
import { join } from 'path';
import { homedir } from 'os';
import { existsSync, appendFileSync, mkdirSync, statSync } from 'fs';

// Use better-sqlite3 from ~/.claudeye/node_modules/ (avoids TCC on ~/Documents)
const _require = createRequire(join(homedir(), '.claudeye', 'package.json'));
const Database = _require('better-sqlite3');

const DATA_DIR = join(homedir(), '.claudeye');
const DB_PATH  = join(DATA_DIR, 'mem.db');
const LOG_DIR  = join(DATA_DIR, 'logs');
const LOG_PATH = join(LOG_DIR, 'insights-heartbeat.log');

if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });

function logLine(msg) {
  try {
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${msg}\n`);
  } catch { /* non-critical */ }
}

logLine('[insights] start');

// ─── Thresholds (mirrors scripts/daily-insights.js) ──────────────────────

const TH = {
  SESSION_WARN_PROMPTS: 250,
  SESSION_CRIT_PROMPTS: 450,
  HOOK_SILENCE_HOURS: 72,              // floor before any silence alert (covers a normal weekend idle for a solo user) (#123)
  HOOK_SILENCE_CRITICAL_HOURS: 168,    // 🔴 ≥1 week of silence → likely a real hook failure, escalate to critical (#123)
  DB_SIZE_WARN_MB: 150,
  ERROR_RATE_CRIT: 20,
};

// ─── Hook-silence detector (#123) — mirrors scripts/daily-insights.js ────────
// A solo user is regularly idle (nights, weekends, working through Cowork
// instead of the CLI). The old detector cried `critical` at a flat 36h floor,
// so every weekend produced a FALSE-RED "Хуки молчат". Distinguish a real hook
// failure from normal idle by comparing the current gap against the user's own
// activity rhythm (p90 of recent inter-observation gaps), and tier severity.
function percentile(values, p) {
  if (!values || values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function detectHookSilence({ hoursSince, typicalGapHours = 0, pipelineGapHours = null, thresholds }) {
  const floor = thresholds.HOOK_SILENCE_HOURS;
  const crit  = thresholds.HOOK_SILENCE_CRITICAL_HOURS;
  if (!(hoursSince > floor)) return null;                 // within the quiet floor
  // Pipeline alive recently ⇒ infra is fine, user is just idle. Don't escalate.
  const pipelineAlive = pipelineGapHours != null && pipelineGapHours < crit;
  if (hoursSince >= crit && !pipelineAlive) {
    return { severity: 'critical', hoursSince };          // whole pipeline dark ≥1 week → real failure
  }
  const idleBand = Math.max(floor, typicalGapHours * 1.5);
  if (hoursSince <= idleBand) return null;                // normal idle rhythm, not breakage
  return { severity: 'warning', hoursSince };
}

function collectAlerts(db) {
  const alerts = [];

  // Long sessions
  try {
    const critSessions = db.prepare(`
      SELECT id, project, prompt_count FROM sessions
      WHERE id NOT LIKE 'import-git-%'
        AND prompt_count >= ?
        AND (ended_at IS NULL OR ended_at > datetime('now', '-1 day'))
      ORDER BY prompt_count DESC
    `).all(TH.SESSION_CRIT_PROMPTS);
    if (critSessions.length > 0) {
      alerts.push({
        severity: 'critical',
        category: 'quota',
        title: `${critSessions.length} сессий по ${TH.SESSION_CRIT_PROMPTS}+ промптов — квота горит`,
        detail: `Проекты: ${[...new Set(critSessions.map(s => s.project))].join(', ')}`,
      });
    }
  } catch (e) { logLine(`[insights] warn: long-sessions check failed: ${e.message}`); }

  // Hook silence (#123) — idle-aware, tiered severity
  try {
    const lastObs = db.prepare(`
      SELECT MAX(created_at) as last_at FROM observations WHERE tool != 'git-commit'
    `).get();
    if (lastObs?.last_at) {
      const hoursSince = (Date.now() - new Date(lastObs.last_at + 'Z').getTime()) / 3600000;
      // Baseline: the user's own idle rhythm = p90 of inter-observation gaps over the last 30d.
      const gapRows = db.prepare(`
        WITH obs AS (
          SELECT created_at,
                 LAG(created_at) OVER (ORDER BY created_at) AS prev_at
          FROM observations
          WHERE tool != 'git-commit'
            AND created_at > datetime('now', '-30 day')
        )
        SELECT (julianday(created_at) - julianday(prev_at)) * 24.0 AS gap_h
        FROM obs WHERE prev_at IS NOT NULL
      `).all();
      const typicalGapHours = percentile(gapRows.map(r => r.gap_h), 90);
      // Liveness proxy: gap since the last observation of ANY tool (incl. automated
      // git-import rows). Fresh ⇒ machine/DB/import pipeline alive ⇒ not a hook break.
      const lastAny = db.prepare(`SELECT MAX(created_at) as last_at FROM observations`).get();
      const pipelineGapHours = lastAny?.last_at
        ? (Date.now() - new Date(lastAny.last_at + 'Z').getTime()) / 3600000
        : null;
      const silence = detectHookSilence({ hoursSince, typicalGapHours, pipelineGapHours, thresholds: TH });
      if (silence) {
        const isCrit = silence.severity === 'critical';
        alerts.push({
          severity: silence.severity,
          category: 'infra',
          title: isCrit
            ? `Хуки молчат ${Math.round(hoursSince)}ч — вероятен отказ`
            : `Live-хуки тихо ${Math.round(hoursSince)}ч`,
          detail: isCrit
            ? `Последний observation: ${lastObs.last_at}. Весь пайплайн молчит — вероятна поломка хуков.`
            : `Последний live-observation: ${lastObs.last_at} (типичный idle p90 ~${Math.round(typicalGapHours)}ч). Пайплайн жив (~${Math.round(pipelineGapHours)}ч назад) — нет интерактивных CLI-сессий, не поломка.`,
        });
      }
    }
  } catch (e) { logLine(`[insights] warn: hook-silence check failed: ${e.message}`); }

  // DB size
  try {
    const sizeMB = +(statSync(DB_PATH).size / 1024 / 1024).toFixed(1);
    if (sizeMB > TH.DB_SIZE_WARN_MB) {
      alerts.push({
        severity: 'warning',
        category: 'infra',
        title: `База данных ${sizeMB}MB`,
        detail: `Рекомендуемый максимум: ${TH.DB_SIZE_WARN_MB}MB.`,
      });
    }
  } catch (e) { logLine(`[insights] warn: db-size check failed: ${e.message}`); }

  // Hook errors (last 24h)
  try {
    const errCount = db.prepare(`
      SELECT COUNT(*) as n FROM hook_errors
      WHERE created_at >= date('now', '-1 day') AND error_type != 'info'
    `).get().n;
    if (errCount > TH.ERROR_RATE_CRIT) {
      alerts.push({
        severity: 'critical',
        category: 'infra',
        title: `${errCount} ошибок хуков за 24ч`,
        detail: 'Проверь `claudeye health`',
      });
    }
  } catch { /* table may not exist */ }

  return alerts;
}

// ─── Main ────────────────────────────────────────────────────────────────

try {
  const db = new Database(DB_PATH);

  // Ensure insights table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS insights (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      date       TEXT    NOT NULL DEFAULT (date('now')),
      alerts     TEXT    NOT NULL,
      summary    TEXT,
      created_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_insights_date ON insights(date DESC);
  `);

  const alerts = collectAlerts(db);
  const crit   = alerts.filter(a => a.severity === 'critical').length;
  const warn   = alerts.filter(a => a.severity === 'warning').length;
  const insights = alerts.filter(a => a.severity === 'insight').length;
  const summary = `${crit} critical, ${warn} warnings, ${insights} insights`;

  db.prepare(`
    INSERT INTO insights (alerts, summary) VALUES (?, ?)
  `).run(JSON.stringify(alerts), summary);

  logLine(`[insights] finish: ${summary}`);
  console.error(`[insights] ${summary}`);
  db.close();

  if (crit > 0 || warn > 0) {
    process.exit(0); // success — alerts were collected
  }
} catch (e) {
  logLine(`[insights] FATAL: ${e.message}`);
  console.error(`[insights] FATAL: ${e.message}`);
  process.exit(1);
}
