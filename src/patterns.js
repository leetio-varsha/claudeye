/**
 * src/patterns.js — Pattern detection engine (#19)
 *
 * Detects concrete, actionable patterns in developer workflow:
 * - Repeat-fix detector: same file getting error→fix cycles
 * - File hotspot scoring: files correlated with high-friction sessions
 * - Time sink analysis: projects/files consuming disproportionate time
 * - Tool friction patterns: tool usage that correlates with retries
 *
 * All computations are pure SQLite queries — no external calls.
 */

import { getDb } from './db.js';

// ─── Repeat-fix detector ─────────────────────────────────────────────────
// Groups observations by file + error/bugfix tag, surfaces files with >N fixes

export function detectRepeatFixes({ days = 14, minFixes = 3 } = {}) {
  const db = getDb();

  const rows = db.prepare(`
    SELECT
      o.project,
      CASE
        WHEN o.raw_input LIKE '%file_path%:%' THEN
          REPLACE(SUBSTR(o.raw_input, INSTR(o.raw_input, 'file_path') + 10, 200), '"', '')
        WHEN o.raw_input LIKE '%/%' THEN
          SUBSTR(o.raw_input, 1, INSTR(o.raw_input || CHAR(10), CHAR(10)) - 1)
        ELSE o.raw_input
      END AS file_hint,
      COUNT(*)                          AS fix_count,
      COUNT(DISTINCT o.session_id)      AS across_sessions,
      COUNT(DISTINCT DATE(o.created_at)) AS across_days,
      MIN(o.created_at)                 AS first_seen,
      MAX(o.created_at)                 AS last_seen,
      AVG(o.importance)                 AS avg_importance,
      GROUP_CONCAT(DISTINCT o.tool)     AS tools_used
    FROM observations o
    WHERE o.created_at >= datetime('now', '-' || ? || ' days')
      AND o.raw_input IS NOT NULL
      AND o.tags IS NOT NULL
      AND (o.tags LIKE '%error%' OR o.tags LIKE '%bugfix%' OR o.tags LIKE '%fix%')
      AND o.tool IN ('Edit', 'Write', 'Bash')
    GROUP BY o.project, file_hint
    HAVING fix_count >= ?
    ORDER BY fix_count DESC, across_sessions DESC
    LIMIT 20
  `).all(days, minFixes);

  return rows.map(r => ({
    project:        r.project?.split('/').pop() || 'unknown',
    project_full:   r.project,
    file:           cleanFileHint(r.file_hint),
    fix_count:      r.fix_count,
    across_sessions: r.across_sessions,
    across_days:    r.across_days,
    first_seen:     r.first_seen,
    last_seen:      r.last_seen,
    avg_importance: +r.avg_importance.toFixed(2),
    tools_used:     r.tools_used,
    message:        `${cleanFileHint(r.file_hint)}: ${r.fix_count} fixes за ${r.across_days} дней в ${r.across_sessions} сессиях`,
  }));
}

// ─── File hotspot scoring ────────────────────────────────────────────────
// Files appearing most frequently in high-friction sessions

export function getFileHotspots({ days = 14, minOccurrences = 3 } = {}) {
  const db = getDb();

  const rows = db.prepare(`
    SELECT
      o.project,
      CASE
        WHEN o.raw_input LIKE '%file_path%:%' THEN
          REPLACE(SUBSTR(o.raw_input, INSTR(o.raw_input, 'file_path') + 10, 200), '"', '')
        WHEN o.raw_input LIKE '%/%' THEN
          SUBSTR(o.raw_input, 1, INSTR(o.raw_input || CHAR(10), CHAR(10)) - 1)
        ELSE o.raw_input
      END AS file_hint,
      COUNT(*)                          AS total_ops,
      COUNT(DISTINCT o.session_id)      AS sessions,
      AVG(s.friction_score)             AS avg_session_friction,
      SUM(o.retry_count)                AS total_retries,
      AVG(o.importance)                 AS avg_importance,
      SUM(CASE WHEN o.tags LIKE '%error%' THEN 1 ELSE 0 END) AS error_count
    FROM observations o
    JOIN sessions s ON s.id = o.session_id
    WHERE o.created_at >= datetime('now', '-' || ? || ' days')
      AND o.raw_input IS NOT NULL
      AND o.tool IN ('Edit', 'Write', 'Read', 'Bash')
    GROUP BY o.project, file_hint
    HAVING total_ops >= ?
    ORDER BY (avg_session_friction * total_ops + total_retries * 0.5) DESC
    LIMIT 15
  `).all(days, minOccurrences);

  return rows.map(r => {
    const hotspotScore = +(
      (r.avg_session_friction || 0) * 0.4 +
      (r.error_count / r.total_ops) * 0.3 +
      (Math.min(1, r.total_retries / r.total_ops)) * 0.3
    ).toFixed(3);

    return {
      project:              r.project?.split('/').pop() || 'unknown',
      project_full:         r.project,
      file:                 cleanFileHint(r.file_hint),
      total_ops:            r.total_ops,
      sessions:             r.sessions,
      avg_session_friction: +(r.avg_session_friction || 0).toFixed(3),
      total_retries:        r.total_retries || 0,
      error_count:          r.error_count,
      hotspot_score:        hotspotScore,
      message:              `${cleanFileHint(r.file_hint)} (${r.project?.split('/').pop()}): hotspot=${hotspotScore}, ${r.total_ops} ops, ${r.error_count} errors, ${r.total_retries || 0} retries`,
    };
  });
}

// ─── Time sink analysis ──────────────────────────────────────────────────
// Projects and files consuming disproportionate time

export function getTimeSinks({ days = 14 } = {}) {
  const db = getDb();

  // Per-project time analysis
  const projectSinks = db.prepare(`
    SELECT
      s.project,
      COUNT(DISTINCT s.id)     AS sessions,
      AVG(s.duration_ms)       AS avg_duration_ms,
      SUM(s.duration_ms)       AS total_duration_ms,
      AVG(s.friction_score)    AS avg_friction,
      AVG(s.prompt_count)      AS avg_prompts,
      COUNT(o.id)              AS total_obs
    FROM sessions s
    LEFT JOIN observations o ON o.session_id = s.id
    WHERE s.started_at >= datetime('now', '-' || ? || ' days')
      AND s.duration_ms IS NOT NULL
      AND s.duration_ms > 0
      AND s.id NOT LIKE 'import-git-%'
    GROUP BY s.project
    HAVING sessions >= 2
    ORDER BY total_duration_ms DESC
    LIMIT 10
  `).all(days);

  // Get global average for comparison
  const globalAvg = db.prepare(`
    SELECT AVG(duration_ms) AS avg_ms, AVG(prompt_count) AS avg_prompts
    FROM sessions
    WHERE started_at >= datetime('now', '-' || ? || ' days')
      AND duration_ms > 0
      AND id NOT LIKE 'import-git-%'
  `).get(days);

  const avgMs = globalAvg?.avg_ms || 1;
  const avgPrompts = globalAvg?.avg_prompts || 1;

  // Tool time sinks — tools with high retry rates in specific projects
  const toolSinks = db.prepare(`
    SELECT
      o.project,
      o.tool,
      COUNT(*)                AS ops,
      AVG(o.retry_count)      AS avg_retries,
      SUM(o.retry_count)      AS total_retries,
      AVG(o.importance)       AS avg_importance
    FROM observations o
    WHERE o.created_at >= datetime('now', '-' || ? || ' days')
      AND o.retry_count > 0
    GROUP BY o.project, o.tool
    HAVING ops >= 5 AND avg_retries > 0.5
    ORDER BY total_retries DESC
    LIMIT 10
  `).all(days);

  return {
    projects: projectSinks.map(p => ({
      project:         p.project?.split('/').pop() || 'unknown',
      project_full:    p.project,
      sessions:        p.sessions,
      total_hours:     +(p.total_duration_ms / 3600000).toFixed(1),
      avg_min:         +(p.avg_duration_ms / 60000).toFixed(1),
      avg_friction:    +(p.avg_friction || 0).toFixed(3),
      avg_prompts:     +p.avg_prompts.toFixed(0),
      duration_ratio:  +((p.avg_duration_ms || 0) / avgMs).toFixed(2),
      prompt_ratio:    +((p.avg_prompts || 0) / avgPrompts).toFixed(2),
      total_obs:       p.total_obs,
    })),
    tool_sinks: toolSinks.map(t => ({
      project:       t.project?.split('/').pop() || 'unknown',
      tool:          t.tool,
      ops:           t.ops,
      avg_retries:   +t.avg_retries.toFixed(2),
      total_retries: t.total_retries,
    })),
    global_avg_min: +(avgMs / 60000).toFixed(1),
  };
}

// ─── Cross-session pattern detection ─────────────────────────────────────
// Finds patterns that span multiple sessions

export function detectCrossSessionPatterns({ days = 14 } = {}) {
  const db = getDb();

  // Error→Fix cycles: sessions where same project has alternating error/fix patterns
  const errorFixCycles = db.prepare(`
    SELECT
      o.project,
      DATE(o.created_at) AS day,
      SUM(CASE WHEN o.tags LIKE '%error%' THEN 1 ELSE 0 END) AS errors,
      SUM(CASE WHEN o.tags LIKE '%bugfix%' OR o.tags LIKE '%fix%' THEN 1 ELSE 0 END) AS fixes,
      COUNT(DISTINCT o.session_id) AS sessions
    FROM observations o
    WHERE o.created_at >= datetime('now', '-' || ? || ' days')
      AND o.tags IS NOT NULL
    GROUP BY o.project, day
    HAVING errors >= 2 OR fixes >= 2
    ORDER BY day DESC, errors DESC
  `).all(days);

  // Aggregate by project
  const projectCycles = {};
  for (const row of errorFixCycles) {
    const proj = row.project?.split('/').pop() || 'unknown';
    if (!projectCycles[proj]) {
      projectCycles[proj] = { project: proj, project_full: row.project, days_with_issues: 0, total_errors: 0, total_fixes: 0 };
    }
    projectCycles[proj].days_with_issues++;
    projectCycles[proj].total_errors += row.errors;
    projectCycles[proj].total_fixes += row.fixes;
  }

  // Friction trend by project (is it getting better or worse?)
  const frictionTrends = db.prepare(`
    SELECT
      s.project,
      CASE
        WHEN s.started_at >= datetime('now', '-7 days') THEN 'recent'
        ELSE 'earlier'
      END AS period,
      AVG(s.friction_score) AS avg_friction,
      COUNT(*) AS sessions
    FROM sessions s
    WHERE s.started_at >= datetime('now', '-' || ? || ' days')
      AND s.friction_score > 0
      AND s.id NOT LIKE 'import-git-%'
    GROUP BY s.project, period
    HAVING sessions >= 2
  `).all(days);

  // Build trend comparisons
  const trendMap = {};
  for (const row of frictionTrends) {
    const proj = row.project?.split('/').pop() || 'unknown';
    if (!trendMap[proj]) trendMap[proj] = { project: proj, project_full: row.project };
    trendMap[proj][row.period] = { avg_friction: +row.avg_friction.toFixed(3), sessions: row.sessions };
  }

  const trends = Object.values(trendMap)
    .filter(t => t.recent && t.earlier)
    .map(t => ({
      ...t,
      delta: +(t.recent.avg_friction - t.earlier.avg_friction).toFixed(3),
      direction: t.recent.avg_friction > t.earlier.avg_friction ? 'worsening' : 'improving',
    }))
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  return {
    error_fix_cycles: Object.values(projectCycles).sort((a, b) => b.total_errors - a.total_errors),
    friction_trends:  trends,
  };
}

// ─── Main pattern detection entry point ──────────────────────────────────

export function detectAllPatterns({ days = 14 } = {}) {
  const repeatFixes   = detectRepeatFixes({ days });
  const hotspots      = getFileHotspots({ days });
  const timeSinks     = getTimeSinks({ days });
  const crossSession  = detectCrossSessionPatterns({ days });

  // Build concrete, actionable findings
  const findings = [];

  // Repeat fixes → refactoring recommendations
  for (const rf of repeatFixes.slice(0, 5)) {
    findings.push({
      category:    'repeat-fix',
      severity:    rf.fix_count >= 5 ? 'high' : 'medium',
      title:       `${rf.file}: ${rf.fix_count} fixes за ${rf.across_days}d`,
      description: rf.message,
      project:     rf.project,
      action:      `Рассмотри рефакторинг ${rf.file} — повторяющиеся фиксы указывают на архитектурную проблему`,
      data:        rf,
    });
  }

  // File hotspots → complexity warnings
  for (const hs of hotspots.filter(h => h.hotspot_score >= 0.15).slice(0, 5)) {
    findings.push({
      category:    'hotspot',
      severity:    hs.hotspot_score >= 0.3 ? 'high' : 'medium',
      title:       `${hs.file}: hotspot score ${hs.hotspot_score}`,
      description: hs.message,
      project:     hs.project,
      action:      `${hs.file} часто вызывает friction — возможно стоит разбить на модули или улучшить тесты`,
      data:        hs,
    });
  }

  // Time sinks → efficiency recommendations
  for (const ps of timeSinks.projects.filter(p => p.duration_ratio > 1.5).slice(0, 3)) {
    findings.push({
      category:    'time-sink',
      severity:    ps.duration_ratio > 2.0 ? 'high' : 'medium',
      title:       `${ps.project}: ${ps.duration_ratio}x дольше среднего`,
      description: `${ps.project}: ${ps.total_hours}h за ${ps.sessions} сессий, avg ${ps.avg_min} мин (среднее ${timeSinks.global_avg_min} мин)`,
      project:     ps.project,
      action:      `Сессии в ${ps.project} занимают ${ps.duration_ratio}x больше обычного — проверь зависимости и tooling`,
      data:        ps,
    });
  }

  // Worsening friction trends
  for (const t of crossSession.friction_trends.filter(t => t.direction === 'worsening' && t.delta > 0.02)) {
    findings.push({
      category:    'friction-trend',
      severity:    t.delta > 0.05 ? 'high' : 'medium',
      title:       `${t.project}: friction растёт (+${t.delta})`,
      description: `Friction в ${t.project}: ${t.earlier.avg_friction} → ${t.recent.avg_friction} (+${t.delta})`,
      project:     t.project,
      action:      `Friction в ${t.project} растёт — проверь недавние изменения и hotspots`,
      data:        t,
    });
  }

  // Tool sinks
  for (const ts of timeSinks.tool_sinks.slice(0, 3)) {
    findings.push({
      category:    'tool-friction',
      severity:    ts.avg_retries > 1.5 ? 'high' : 'medium',
      title:       `${ts.tool} в ${ts.project}: avg ${ts.avg_retries} retries`,
      description: `${ts.tool} в ${ts.project}: ${ts.total_retries} retries за ${ts.ops} ops`,
      project:     ts.project,
      action:      `Высокий retry rate для ${ts.tool} — проверь типичные ошибки и настрой pre-validation`,
      data:        ts,
    });
  }

  // Sort by severity (high first), then by hotspot_score/fix_count descending
  const severityRank = { high: 0, medium: 1, low: 2 };
  findings.sort((a, b) => {
    const sa = severityRank[a.severity] ?? 2;
    const sb = severityRank[b.severity] ?? 2;
    if (sa !== sb) return sa - sb;
    // Secondary: score/magnitude
    const scoreA = a.data?.hotspot_score || a.data?.fix_count || a.data?.delta || 0;
    const scoreB = b.data?.hotspot_score || b.data?.fix_count || b.data?.delta || 0;
    return scoreB - scoreA;
  });

  return {
    findings,
    raw: { repeatFixes, hotspots, timeSinks, crossSession },
    summary: {
      total_findings:     findings.length,
      high_severity:      findings.filter(f => f.severity === 'high').length,
      categories:         [...new Set(findings.map(f => f.category))],
      projects_affected:  [...new Set(findings.map(f => f.project))],
    },
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function cleanFileHint(hint) {
  if (!hint) return 'unknown';
  // Remove JSON artifacts, quotes, common prefixes
  let clean = hint
    .replace(/^["'{]+|["'}]+$/g, '')
    .replace(/\\n.*$/, '')
    .replace(/^\s+/, '')
    .trim();
  // Shorten long paths: keep last 2-3 segments
  const parts = clean.split('/').filter(Boolean);
  if (parts.length > 3) {
    clean = '.../' + parts.slice(-3).join('/');
  }
  return clean || 'unknown';
}
