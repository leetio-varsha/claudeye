#!/usr/bin/env node
/**
 * scripts/daily-insights.js — Daily Proactive Insights (#49)
 *
 * Analyzes mem.db for anomalies, quota issues, friction patterns,
 * and actionable recommendations. Outputs alerts + full report.
 *
 * Can be run:
 *   - Via CLI: claudeye insights
 *   - Via scheduled task (Cowork scheduler / launchd)
 *   - Standalone: node scripts/daily-insights.js
 *
 * Alert severity:
 *   🔴 critical — immediate action needed (quota burning, hooks broken)
 *   🟡 warning  — trend worsening, should address soon
 *   🟢 insight  — opportunity to improve (not urgent)
 *
 * Philosophy: no alerts = everything is fine. Don't spam.
 */

import { getDb, getDbMetrics, getErrorStats } from '../src/db.js';
import { isEmbeddingEnabled } from '../src/embeddings.js';
import { existsSync, statSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import { homedir } from 'os';

// ─── Thresholds ──────────────────────────────────────────────────────────

const THRESHOLDS = {
  // Quota / session length
  SESSION_WARN_PROMPTS: 150,       // 🟡 session getting long
  SESSION_CRIT_PROMPTS: 300,       // 🔴 session way too long, quota burning
  DAILY_PROMPTS_SPIKE: 1.5,        // 🟡 >1.5x average daily prompts

  // Friction
  FRICTION_SPIKE_PCT: 0.30,        // 🟡 project friction up >30% vs 7-day avg
  REPEAT_FIX_THRESHOLD: 5,         // 🟡 same file edited 5+ times in 7 days (high importance)

  // Infrastructure
  HOOK_SILENCE_HOURS: 36,          // 🔴 no observations for 36+ hours
  DB_SIZE_WARN_MB: 100,            // 🟡 database getting large
  ERROR_RATE_CRIT: 20,             // 🔴 >20 hook errors in 24h

  // Activity
  EMPTY_SESSION_RATIO: 0.5,        // 🟡 >50% sessions with 0 high-importance obs
};

// ─── Main ────────────────────────────────────────────────────────────────

export async function runInsights({ days = 1, verbose = false, notify = true } = {}) {
  const db = getDb();
  const alerts = [];

  // ── 1. Quota & Session Length ──────────────────────────────────────────

  // Only alert on sessions that were active in the lookback period
  // (either still open, or ended within the last N days)
  const longSessions = db.prepare(`
    SELECT id, project, prompt_count, started_at,
           ROUND((julianday(COALESCE(ended_at, datetime('now'))) - julianday(started_at)) * 24, 1) as hours
    FROM sessions
    WHERE id NOT LIKE 'import-git-%'
      AND prompt_count >= ?
      AND (
        ended_at IS NULL
        OR ended_at > datetime('now', '-' || ? || ' days')
      )
    ORDER BY prompt_count DESC
  `).all(THRESHOLDS.SESSION_WARN_PROMPTS, days);

  const critSessions = longSessions.filter(s => s.prompt_count >= THRESHOLDS.SESSION_CRIT_PROMPTS);
  const warnSessions = longSessions.filter(s =>
    s.prompt_count >= THRESHOLDS.SESSION_WARN_PROMPTS &&
    s.prompt_count < THRESHOLDS.SESSION_CRIT_PROMPTS
  );

  if (critSessions.length > 0) {
    const totalPrompts = critSessions.reduce((s, x) => s + x.prompt_count, 0);
    const projects = [...new Set(critSessions.map(s => shortProject(s.project)))].join(', ');
    alerts.push({
      severity: 'critical',
      category: 'quota',
      title: `${critSessions.length} сессий по ${THRESHOLDS.SESSION_CRIT_PROMPTS}+ промптов — квота горит`,
      detail: `Суммарно ${totalPrompts} промптов. Проекты: ${projects}. Каждый промпт после 200-го тратит ~2-3x больше токенов из-за накопленного контекста.`,
      action: 'Используй `claudeye handoff` и начинай новую сессию после 100-150 промптов.',
      data: critSessions.map(s => ({
        project: shortProject(s.project),
        prompts: s.prompt_count,
        hours: s.hours,
      })),
    });
  } else if (warnSessions.length > 0) {
    alerts.push({
      severity: 'warning',
      category: 'quota',
      title: `${warnSessions.length} сессий по ${THRESHOLDS.SESSION_WARN_PROMPTS}+ промптов`,
      detail: `Сессии становятся длинными. Пока не критично, но тренд к перерасходу квоты.`,
      action: 'Рассмотри более частый handoff для экономии токенов.',
      data: warnSessions.map(s => ({
        project: shortProject(s.project),
        prompts: s.prompt_count,
      })),
    });
  }

  // Daily prompt volume: compare last N days vs previous period
  const recentDaily = db.prepare(`
    SELECT date(created_at) as day, COUNT(*) as obs
    FROM observations
    WHERE created_at > datetime('now', '-' || ? || ' days')
      AND tool != 'git-commit'
    GROUP BY day
  `).all(days + 7);

  if (recentDaily.length >= 5) {
    const sorted = recentDaily
      .filter(d => d.obs >= 10) // skip days with no real activity
      .sort((a, b) => b.day.localeCompare(a.day));
    const recent = sorted.slice(0, Math.min(3, sorted.length));
    const baseline = sorted.slice(3);

    if (baseline.length >= 2) {
      const recentAvg = recent.reduce((s, d) => s + d.obs, 0) / recent.length;
      const baselineAvg = baseline.reduce((s, d) => s + d.obs, 0) / baseline.length;

      if (baselineAvg > 50 && recentAvg / baselineAvg > THRESHOLDS.DAILY_PROMPTS_SPIKE) {
        alerts.push({
          severity: 'warning',
          category: 'quota',
          title: `Объём работы вырос в ${(recentAvg / baselineAvg).toFixed(1)}x`,
          detail: `Среднее за последние дни: ${Math.round(recentAvg)} obs/день vs ${Math.round(baselineAvg)} ранее.`,
          action: 'Проверь нет ли зацикленных сессий или избыточных tool calls.',
        });
      }
    }
  }

  // ── 2. Friction Anomalies ─────────────────────────────────────────────

  // Per-project friction comparison: last 3 days vs 7-day baseline
  const projectFriction = db.prepare(`
    SELECT
      project,
      AVG(CASE WHEN created_at > datetime('now', '-3 days') THEN importance END) as recent_imp,
      AVG(CASE WHEN created_at <= datetime('now', '-3 days') AND created_at > datetime('now', '-10 days') THEN importance END) as baseline_imp,
      COUNT(CASE WHEN created_at > datetime('now', '-3 days') THEN 1 END) as recent_count,
      COUNT(CASE WHEN created_at <= datetime('now', '-3 days') AND created_at > datetime('now', '-10 days') THEN 1 END) as baseline_count
    FROM observations
    WHERE created_at > datetime('now', '-10 days')
      AND tool != 'git-commit'
    GROUP BY project
    HAVING recent_count >= 10 AND baseline_count >= 10
  `).all();

  for (const p of projectFriction) {
    if (p.baseline_imp && p.recent_imp) {
      const delta = (p.recent_imp - p.baseline_imp) / p.baseline_imp;
      if (delta > THRESHOLDS.FRICTION_SPIKE_PCT) {
        alerts.push({
          severity: 'warning',
          category: 'friction',
          title: `Friction вырос на ${Math.round(delta * 100)}% в ${shortProject(p.project)}`,
          detail: `Средний importance: ${p.recent_imp.toFixed(3)} (последние 3 дня) vs ${p.baseline_imp.toFixed(3)} (baseline). Больше ошибок или сложных задач.`,
          action: `Проверь что происходит в ${shortProject(p.project)} — возможно нужен рефакторинг или лучший CLAUDE.md.`,
        });
      }
    }
  }

  // Repeat-fix hotspots
  const hotspots = db.prepare(`
    SELECT
      SUBSTR(raw_input, 1, 200) as file_hint,
      COUNT(*) as times,
      project,
      GROUP_CONCAT(SUBSTR(summary, 1, 80), ' | ') as summaries
    FROM observations
    WHERE tool IN ('Edit', 'Write')
      AND importance >= 0.6
      AND raw_input IS NOT NULL
      AND created_at > datetime('now', '-7 days')
    GROUP BY SUBSTR(raw_input, 1, 200), project
    HAVING times >= ?
    ORDER BY times DESC
    LIMIT 5
  `).all(THRESHOLDS.REPEAT_FIX_THRESHOLD);

  for (const h of hotspots) {
    // Extract just the file path from the JSON-ish raw_input
    const fileMatch = h.file_hint.match(/[\/\w.-]+\.\w+/);
    const fileName = fileMatch ? fileMatch[0].split('/').slice(-2).join('/') : h.file_hint.slice(0, 60);
    alerts.push({
      severity: 'warning',
      category: 'friction',
      title: `${fileName} отредактирован ${h.times}x за неделю`,
      detail: `Проект: ${shortProject(h.project)}. Частые правки высокой важности = возможный hotspot для рефакторинга.`,
      action: 'Рассмотри рефакторинг этого файла или улучши покрытие тестами.',
    });
  }

  // ── 3. Infrastructure Health ──────────────────────────────────────────

  // Hook silence
  const lastObs = db.prepare(`
    SELECT MAX(created_at) as last_at FROM observations WHERE tool != 'git-commit'
  `).get();

  if (lastObs?.last_at) {
    const hoursSince = (Date.now() - new Date(lastObs.last_at + 'Z').getTime()) / 3600000;
    if (hoursSince > THRESHOLDS.HOOK_SILENCE_HOURS) {
      alerts.push({
        severity: 'critical',
        category: 'infra',
        title: `Хуки молчат ${Math.round(hoursSince)}ч`,
        detail: `Последний observation: ${lastObs.last_at}. Либо Claude Code не запускался, либо хуки сломаны.`,
        action: 'Проверь `claudeye health` и переустанови хуки если нужно.',
      });
    }
  }

  // DB size
  const metrics = getDbMetrics();
  if (metrics.fileSizeMB > THRESHOLDS.DB_SIZE_WARN_MB) {
    alerts.push({
      severity: 'warning',
      category: 'infra',
      title: `База данных ${metrics.fileSizeMB}MB`,
      detail: `Рекомендуемый максимум: ${THRESHOLDS.DB_SIZE_WARN_MB}MB. Поиск может замедлиться.`,
      action: 'Запусти `claudeye cleanup` для очистки старых данных.',
    });
  }

  // Hook errors
  const errors = getErrorStats(1);
  if (errors.total > THRESHOLDS.ERROR_RATE_CRIT) {
    alerts.push({
      severity: 'critical',
      category: 'infra',
      title: `${errors.total} ошибок хуков за 24ч`,
      detail: errors.byHook.slice(0, 3).map(e => `${e.hook}: ${e.error_type} (${e.count}x)`).join(', '),
      action: 'Проверь `claudeye health` — возможно проблема с API ключом или DB.',
    });
  }

  // Embedding gap
  if (metrics.obsCount > 0) {
    const gapPct = Math.round((1 - metrics.embCount / metrics.obsCount) * 100);
    if (gapPct > 60 && isEmbeddingEnabled()) {
      alerts.push({
        severity: 'insight',
        category: 'infra',
        title: `${gapPct}% observations без embeddings`,
        detail: `${metrics.embCount} из ${metrics.obsCount} имеют vector embeddings. Поиск использует только FTS5 для остальных.`,
        action: 'Запусти `claudeye reindex` для улучшения качества поиска.',
      });
    }
  }

  // ── 4. Positive Insights ──────────────────────────────────────────────

  // Find project with biggest friction drop
  for (const p of projectFriction) {
    if (p.baseline_imp && p.recent_imp) {
      const delta = (p.recent_imp - p.baseline_imp) / p.baseline_imp;
      if (delta < -0.20 && p.recent_count >= 20) {
        alerts.push({
          severity: 'insight',
          category: 'positive',
          title: `Friction снизился на ${Math.round(Math.abs(delta) * 100)}% в ${shortProject(p.project)}`,
          detail: `Importance: ${p.recent_imp.toFixed(3)} → ${p.baseline_imp.toFixed(3)}. Меньше ошибок, работа идёт ровнее.`,
          action: null,
        });
      }
    }
  }

  // ── 5. Notification ───────────────────────────────────────────────────

  const critAlerts = alerts.filter(a => a.severity === 'critical');
  const warnAlerts = alerts.filter(a => a.severity === 'warning');
  const insightAlerts = alerts.filter(a => a.severity === 'insight');

  if (notify && (critAlerts.length > 0 || warnAlerts.length > 0)) {
    sendNotification(critAlerts, warnAlerts);
  }

  // ── 6. Save to DB for trend tracking ──────────────────────────────────

  try {
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

    db.prepare(`
      INSERT INTO insights (alerts, summary)
      VALUES (?, ?)
    `).run(
      JSON.stringify(alerts),
      `${critAlerts.length} critical, ${warnAlerts.length} warnings, ${insightAlerts.length} insights`
    );
  } catch { /* non-critical */ }

  return { alerts, critAlerts, warnAlerts, insightAlerts };
}

// ─── Formatting ──────────────────────────────────────────────────────────

export function formatReport(result) {
  const { alerts, critAlerts, warnAlerts, insightAlerts } = result;
  const lines = [];

  if (alerts.length === 0) {
    lines.push('  ✅ Всё в норме. Аномалий не обнаружено.\n');
    return lines.join('\n');
  }

  if (critAlerts.length > 0) {
    lines.push('  🔴 CRITICAL\n');
    for (const a of critAlerts) {
      lines.push(`  ${a.title}`);
      lines.push(`    ${a.detail}`);
      if (a.action) lines.push(`    → ${a.action}`);
      if (a.data) {
        for (const d of a.data.slice(0, 5)) {
          const parts = Object.entries(d).map(([k, v]) => `${k}: ${v}`).join(', ');
          lines.push(`      ${parts}`);
        }
      }
      lines.push('');
    }
  }

  if (warnAlerts.length > 0) {
    lines.push('  🟡 WARNINGS\n');
    for (const a of warnAlerts) {
      lines.push(`  ${a.title}`);
      lines.push(`    ${a.detail}`);
      if (a.action) lines.push(`    → ${a.action}`);
      if (a.data) {
        for (const d of a.data.slice(0, 3)) {
          const parts = Object.entries(d).map(([k, v]) => `${k}: ${v}`).join(', ');
          lines.push(`      ${parts}`);
        }
      }
      lines.push('');
    }
  }

  if (insightAlerts.length > 0) {
    lines.push('  🟢 INSIGHTS\n');
    for (const a of insightAlerts) {
      lines.push(`  ${a.title}`);
      lines.push(`    ${a.detail}`);
      if (a.action) lines.push(`    → ${a.action}`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

// ─── macOS Notification ──────────────────────────────────────────────────

function sendNotification(critAlerts, warnAlerts) {
  try {
    const title = critAlerts.length > 0
      ? `🔴 Claudeye: ${critAlerts.length} critical`
      : `🟡 Claudeye: ${warnAlerts.length} warnings`;

    const body = [...critAlerts, ...warnAlerts]
      .slice(0, 3)
      .map(a => a.title)
      .join('\n');

    const escaped = body.replace(/"/g, '\\"').replace(/\n/g, '\\n');
    execSync(`osascript -e 'display notification "${escaped}" with title "${title}"'`, {
      timeout: 5000,
    });
  } catch {
    // notification failed, non-critical
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function shortProject(project) {
  return (project || '').replace(homedir(), '~').split('/').slice(-2).join('/');
}

// ─── Standalone execution ────────────────────────────────────────────────

const isMain = process.argv[1]?.endsWith('daily-insights.js');
if (isMain) {
  const result = await runInsights({ days: 1, notify: true });
  const chalk = (await import('chalk')).default;

  console.log(chalk.bold('\n  Claudeye Daily Insights\n'));
  console.log(formatReport(result));

  const { critAlerts, warnAlerts, insightAlerts } = result;
  const total = critAlerts.length + warnAlerts.length + insightAlerts.length;
  console.log(chalk.gray(`  ${total} alerts: ${critAlerts.length} critical, ${warnAlerts.length} warnings, ${insightAlerts.length} insights\n`));
}
