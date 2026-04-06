/**
 * src/analytics.js — Analytics computation layer
 *
 * All computations are pure SQLite queries — no external calls.
 * Fast even with thousands of sessions.
 */

import { getDb, getEffortStats } from './db.js';

// NOTE: Schema migration for analytics lives in db.js (_migrateAnalytics),
// called automatically from getDb(). Do not duplicate DDL here.

// ─── Global stats ─────────────────────────────────────────────────────────

export function getGlobalStats() {
  const db = getDb();

  const overview = db.prepare(`
    SELECT
      COUNT(DISTINCT s.id)             AS total_sessions,
      COUNT(o.id)                      AS total_observations,
      COUNT(DISTINCT s.project)        AS total_projects,
      AVG(s.friction_score)            AS avg_friction,
      SUM(s.token_input + COALESCE(s.token_output, 0)) AS total_tokens,
      AVG(s.duration_ms) / 60000.0    AS avg_session_min
    FROM sessions s
    LEFT JOIN observations o ON o.session_id = s.id
  `).get();

  const byProject = db.prepare(`
    SELECT
      s.project,
      COUNT(DISTINCT s.id)          AS sessions,
      COUNT(o.id)                   AS observations,
      AVG(s.friction_score)         AS avg_friction,
      AVG(s.duration_ms) / 60000.0  AS avg_session_min,
      MAX(s.started_at)             AS last_active
    FROM sessions s
    LEFT JOIN observations o ON o.session_id = s.id
    GROUP BY s.project
    ORDER BY last_active DESC
  `).all();

  const weeklyTrend = db.prepare(`
    SELECT
      strftime('%Y-W%W', started_at) AS week,
      COUNT(*)                       AS sessions,
      AVG(friction_score)            AS avg_friction
    FROM sessions
    WHERE started_at >= date('now', '-12 weeks')
    GROUP BY week
    ORDER BY week ASC
  `).all();

  const topTags = db.prepare(`
    SELECT value AS tag, COUNT(*) AS n
    FROM observations, json_each(observations.tags)
    WHERE json_valid(observations.tags)
    GROUP BY tag
    ORDER BY n DESC
    LIMIT 15
  `).all();

  return { overview, byProject, weeklyTrend, topTags };
}

// ─── Project stats ────────────────────────────────────────────────────────

export function getProjectStats(project) {
  const db = getDb();

  const overview = db.prepare(`
    SELECT
      COUNT(DISTINCT s.id)          AS sessions,
      COUNT(o.id)                   AS observations,
      AVG(s.friction_score)         AS avg_friction,
      AVG(s.duration_ms) / 60000.0  AS avg_session_min,
      SUM(s.token_input)            AS total_tokens_in,
      SUM(s.token_output)           AS total_tokens_out,
      MIN(s.started_at)             AS first_session,
      MAX(s.started_at)             AS last_session
    FROM sessions s
    LEFT JOIN observations o ON o.session_id = s.id
    WHERE s.project = ?
  `).get(project);

  const byTool = db.prepare(`
    SELECT tool, COUNT(*) AS n, AVG(importance) AS avg_importance
    FROM observations
    WHERE project = ?
    GROUP BY tool
    ORDER BY n DESC
  `).all(project);

  const highImportance = db.prepare(`
    SELECT summary, tool, importance, created_at
    FROM observations
    WHERE project = ? AND importance >= 0.8
    ORDER BY created_at DESC
    LIMIT 20
  `).all(project);

  const frictionTrend = db.prepare(`
    SELECT
      date(started_at)    AS day,
      AVG(friction_score) AS avg_friction,
      COUNT(*)            AS sessions
    FROM sessions
    WHERE project = ? AND started_at >= date('now', '-30 days')
    GROUP BY day
    ORDER BY day ASC
  `).all(project);

  const issues = db.prepare(`
    SELECT * FROM issues WHERE project = ? ORDER BY opened_at DESC LIMIT 20
  `).all(project);

  return { overview, byTool, highImportance, frictionTrend, issues };
}

// ─── Plugin effectiveness matrix ─────────────────────────────────────────

export function getPluginMatrix() {
  const db = getDb();

  // Sessions with plugins active
  const withPlugins = db.prepare(`
    SELECT
      json_each.value                 AS plugin,
      COUNT(DISTINCT s.id)            AS sessions,
      AVG(s.friction_score)           AS avg_friction,
      AVG(s.duration_ms) / 60000.0    AS avg_duration_min,
      AVG(r.rating)                   AS avg_rating,
      COUNT(DISTINCT s.project)       AS projects_used_in
    FROM sessions s, json_each(s.plugins)
    LEFT JOIN session_ratings r ON r.session_id = s.id
    WHERE s.plugins IS NOT NULL AND s.plugins != '[]'
    GROUP BY plugin
    ORDER BY sessions DESC
  `).all();

  // Baseline: sessions with no plugins
  const baseline = db.prepare(`
    SELECT
      AVG(friction_score)           AS avg_friction,
      AVG(duration_ms) / 60000.0    AS avg_duration_min,
      AVG(r.rating)                 AS avg_rating,
      COUNT(*)                      AS sessions
    FROM sessions s
    LEFT JOIN session_ratings r ON r.session_id = s.id
    WHERE s.plugins IS NULL OR s.plugins = '[]'
  `).get();

  // Enrich with delta vs baseline
  const enriched = withPlugins.map(p => ({
    ...p,
    friction_delta:  p.avg_friction  - (baseline.avg_friction  || 0),
    duration_delta:  p.avg_duration_min - (baseline.avg_duration_min || 0),
    rating_delta:    (p.avg_rating   || 0) - (baseline.avg_rating || 0),
  }));

  return { plugins: enriched, baseline };
}

// ─── Model comparison ─────────────────────────────────────────────────────

export function getModelComparison() {
  const db = getDb();

  return db.prepare(`
    SELECT
      COALESCE(s.model, 'unknown')    AS model,
      COUNT(DISTINCT s.id)            AS sessions,
      AVG(s.friction_score)           AS avg_friction,
      AVG(s.duration_ms) / 60000.0    AS avg_duration_min,
      AVG(s.token_input)              AS avg_tokens_in,
      AVG(s.token_output)             AS avg_tokens_out,
      AVG(r.rating)                   AS avg_rating,
      COUNT(DISTINCT s.project)       AS projects
    FROM sessions s
    LEFT JOIN session_ratings r ON r.session_id = s.id
    GROUP BY model
    ORDER BY sessions DESC
  `).all();
}

// ─── Issue metrics ────────────────────────────────────────────────────────

export function getIssueMetrics() {
  const db = getDb();

  const summary = db.prepare(`
    SELECT
      COUNT(*)                                           AS total,
      SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) AS resolved,
      SUM(CASE WHEN status = 'open'     THEN 1 ELSE 0 END) AS open,
      AVG(CASE WHEN status = 'resolved' THEN resolution_ms END) / 3600000.0 AS avg_resolution_hrs,
      MAX(CASE WHEN status = 'resolved' THEN resolution_ms END) / 3600000.0 AS max_resolution_hrs,
      AVG(complexity)                                    AS avg_complexity
    FROM issues
  `).get();

  const byProject = db.prepare(`
    SELECT
      project,
      COUNT(*)                                            AS total,
      AVG(CASE WHEN status='resolved' THEN resolution_ms END) / 3600000.0 AS avg_hrs,
      AVG(complexity)                                     AS avg_complexity
    FROM issues
    GROUP BY project
    ORDER BY avg_hrs DESC
  `).all();

  const slowest = db.prepare(`
    SELECT title, project, complexity, resolution_ms / 3600000.0 AS hrs, opened_at
    FROM issues
    WHERE status = 'resolved'
    ORDER BY resolution_ms DESC
    LIMIT 10
  `).all();

  return { summary, byProject, slowest };
}

// ─── Complexity hotspots ──────────────────────────────────────────────────

export function getComplexityHotspots() {
  const db = getDb();

  // Files that appear most in high-friction/high-importance observations
  const hotFiles = db.prepare(`
    SELECT
      -- Extract filename from raw_input paths
      CASE
        WHEN raw_input LIKE '%/%' THEN
          substr(raw_input, instr(raw_input, '/') + 1, 200)
        ELSE raw_input
      END AS file_hint,
      COUNT(*)            AS occurrences,
      AVG(importance)     AS avg_importance,
      project
    FROM observations
    WHERE raw_input IS NOT NULL
      AND tool IN ('Edit', 'Write', 'Bash')
      AND importance >= 0.5
    GROUP BY file_hint, project
    HAVING occurrences >= 3
    ORDER BY occurrences DESC, avg_importance DESC
    LIMIT 20
  `).all();

  // Tools with highest retry rates
  const retryByTool = db.prepare(`
    SELECT tool, AVG(retry_count) AS avg_retries, COUNT(*) AS n
    FROM observations
    WHERE retry_count > 0
    GROUP BY tool
    ORDER BY avg_retries DESC
  `).all();

  return { hotFiles, retryByTool };
}

// ─── Rate a session ───────────────────────────────────────────────────────

export function rateSession(sessionId, rating, note = null) {
  const db = getDb();
  db.prepare(`
    INSERT INTO session_ratings (session_id, rating, note)
    VALUES (?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET rating = ?, note = ?, created_at = datetime('now')
  `).run(sessionId, rating, note, rating, note);
}

// ─── Compute friction score for a session ────────────────────────────────

export function computeFrictionScore(sessionId) {
  const db = getDb();

  const obs = db.prepare(`
    SELECT importance, retry_count, tags FROM observations WHERE session_id = ?
  `).all(sessionId);

  if (!obs.length) return 0;

  const errorCount  = obs.filter(o => {
    const tags = JSON.parse(o.tags || '[]');
    return tags.includes('error') || tags.includes('bugfix');
  }).length;

  const retryCount  = obs.reduce((sum, o) => sum + (o.retry_count || 0), 0);
  const avgImp      = obs.reduce((sum, o) => sum + o.importance, 0) / obs.length;

  const errorRatio  = errorCount / obs.length;
  const retryRatio  = Math.min(1, retryCount / obs.length);
  // High importance = complex work (not necessarily friction, but a signal)
  const impFactor   = avgImp;

  const score = (errorRatio * 0.4) + (retryRatio * 0.4) + (impFactor * 0.2);
  return Math.min(1, Math.max(0, score));
}

// ─── Build stats payload for advisor ──────────────────────────────────────

export function buildAdvisorPayload(days = 30) {
  const global  = getGlobalStats();
  const plugins = getPluginMatrix();
  const models  = getModelComparison();
  const issues  = getIssueMetrics();
  const hotspots = getComplexityHotspots();
  const effort  = getEffortStats(days);

  // Summarize for prompt (keep token count manageable)
  return {
    period_days:   days,
    generated_at:  new Date().toISOString(),
    overview:      global.overview,
    top_projects:  global.byProject.slice(0, 5).map(p => ({
      project:       p.project.split('/').pop(),
      sessions:      p.sessions,
      avg_friction:  +(p.avg_friction || 0).toFixed(2),
      avg_min:       +(p.avg_session_min || 0).toFixed(1),
    })),
    weekly_trend:  global.weeklyTrend,
    plugins: {
      baseline:    plugins.baseline,
      by_plugin:   plugins.plugins.map(p => ({
        plugin:          p.plugin,
        sessions:        p.sessions,
        friction_delta:  +(p.friction_delta || 0).toFixed(3),
        duration_delta:  +(p.duration_delta || 0).toFixed(1),
        avg_rating:      p.avg_rating ? +p.avg_rating.toFixed(1) : null,
      })),
    },
    models: models.map(m => ({
      model:        m.model,
      sessions:     m.sessions,
      avg_friction: +(m.avg_friction || 0).toFixed(2),
      avg_min:      +(m.avg_duration_min || 0).toFixed(1),
      avg_rating:   m.avg_rating ? +m.avg_rating.toFixed(1) : null,
    })),
    issues: {
      summary:    issues.summary,
      by_project: issues.byProject.slice(0, 5),
      slowest:    issues.slowest.slice(0, 3),
    },
    hotspots: hotspots.hotFiles.slice(0, 10),
    top_tags:  global.topTags.slice(0, 10),
    effort_analysis: effort.total > 0 ? {
      total_classified:    effort.total,
      suboptimal_count:    effort.suboptimal,
      suboptimal_percent:  effort.suboptimalPercent,
      distribution:        effort.distribution,
      by_project:          effort.byProject.slice(0, 10),
    } : null,
  };
}
