/**
 * scripts/weekly-project-report.js — Cross-project friction heatmap (#56)
 *
 * Generates a weekly report comparing friction across projects:
 *   1. Projects ranked by friction score
 *   2. Week-over-week friction trends
 *   3. File/module hotspots
 *   4. Session time distribution
 */

import { getDb } from '../src/db.js';

/**
 * Generate cross-project friction heatmap data.
 *
 * @param {object} opts
 * @param {number} opts.days — lookback period (default 7)
 * @returns {object} — { projects, trends, hotspots, timeSinks }
 */
export function generateProjectHeatmap({ days = 7 } = {}) {
  const db = getDb();

  // 1. Projects ranked by friction (using session friction_score + observation importance)
  const projects = db.prepare(`
    SELECT
      REPLACE(REPLACE(o.project, '/Users/lord/Sites/', ''), '/Users/lord/Documents/Claude/Projects/', '') as project,
      COUNT(DISTINCT s.id) as sessions,
      COUNT(o.id) as total_obs,
      SUM(CASE WHEN o.importance >= 0.8 THEN 1 ELSE 0 END) as critical_obs,
      ROUND(AVG(o.importance), 3) as avg_importance,
      ROUND(AVG(s.friction_score), 3) as avg_friction,
      ROUND(CAST(SUM(CASE WHEN o.importance >= 0.8 THEN 1 ELSE 0 END) AS REAL) / COUNT(o.id) * 100, 1) as critical_pct,
      SUM(s.prompt_count) as total_prompts
    FROM observations o
    JOIN sessions s ON s.id = o.session_id
    WHERE o.created_at >= date('now', '-' || ? || ' days')
      AND o.tool != 'git-commit'
    GROUP BY o.project
    HAVING total_obs >= 5
    ORDER BY avg_friction DESC, critical_pct DESC
  `).all(days);

  // 2. Week-over-week trends: compare this period vs previous period
  const trends = db.prepare(`
    SELECT
      REPLACE(REPLACE(project, '/Users/lord/Sites/', ''), '/Users/lord/Documents/Claude/Projects/', '') as project,
      ROUND(AVG(CASE WHEN created_at >= date('now', '-' || ? || ' days') THEN importance END), 3) as current_imp,
      ROUND(AVG(CASE WHEN created_at < date('now', '-' || ? || ' days')
                      AND created_at >= date('now', '-' || (? * 2) || ' days') THEN importance END), 3) as prev_imp,
      COUNT(CASE WHEN created_at >= date('now', '-' || ? || ' days') THEN 1 END) as current_count,
      COUNT(CASE WHEN created_at < date('now', '-' || ? || ' days')
                  AND created_at >= date('now', '-' || (? * 2) || ' days') THEN 1 END) as prev_count
    FROM observations
    WHERE created_at >= date('now', '-' || (? * 2) || ' days')
      AND tool != 'git-commit'
    GROUP BY project
    HAVING current_count >= 5 AND prev_count >= 5
    ORDER BY (current_imp - prev_imp) DESC
  `).all(days, days, days, days, days, days, days);

  // 3. File/module hotspots — repeated high-importance observations on same summary patterns
  const hotspots = db.prepare(`
    SELECT
      REPLACE(REPLACE(project, '/Users/lord/Sites/', ''), '/Users/lord/Documents/Claude/Projects/', '') as project,
      tool,
      SUBSTR(summary, 1, 120) as summary_prefix,
      COUNT(*) as occurrences,
      ROUND(AVG(importance), 3) as avg_importance
    FROM observations
    WHERE created_at >= date('now', '-' || ? || ' days')
      AND importance >= 0.7
      AND tool != 'git-commit'
    GROUP BY project, tool, summary_prefix
    HAVING occurrences >= 3
    ORDER BY occurrences DESC, avg_importance DESC
    LIMIT 15
  `).all(days);

  // 4. Session time sinks — projects with longest/most sessions
  const timeSinks = db.prepare(`
    SELECT
      REPLACE(REPLACE(project, '/Users/lord/Sites/', ''), '/Users/lord/Documents/Claude/Projects/', '') as project,
      COUNT(*) as session_count,
      SUM(prompt_count) as total_prompts,
      MAX(prompt_count) as max_prompts,
      ROUND(AVG(prompt_count), 0) as avg_prompts
    FROM sessions
    WHERE started_at >= date('now', '-' || ? || ' days')
      AND id NOT LIKE 'import-git-%'
    GROUP BY project
    HAVING session_count >= 2
    ORDER BY total_prompts DESC
    LIMIT 10
  `).all(days);

  return { projects, trends, hotspots, timeSinks, days };
}

/**
 * Format heatmap data as CLI-friendly text.
 */
export function formatHeatmap(data) {
  const lines = [];
  const { projects, trends, hotspots, timeSinks, days } = data;

  lines.push(`\n  Cross-Project Friction Heatmap (${days}d)\n`);

  // Projects by friction
  if (projects.length) {
    lines.push('  ── Projects by Friction ──\n');
    for (const p of projects.slice(0, 10)) {
      const bar = frictionBar(p.avg_friction);
      const name = p.project.split('/').pop().padEnd(25);
      lines.push(`  ${name} ${bar}  friction=${p.avg_friction}  critical=${p.critical_pct}%  obs=${p.total_obs}  sessions=${p.sessions}`);
    }
  } else {
    lines.push('  No projects with enough data.\n');
  }

  // Trends
  const rising = trends.filter(t => t.current_imp && t.prev_imp && t.current_imp > t.prev_imp + 0.03);
  const falling = trends.filter(t => t.current_imp && t.prev_imp && t.current_imp < t.prev_imp - 0.03);

  if (rising.length || falling.length) {
    lines.push('\n  ── Friction Trends ──\n');
    for (const t of rising.slice(0, 5)) {
      const delta = (t.current_imp - t.prev_imp).toFixed(3);
      lines.push(`  ↑ ${t.project.split('/').pop().padEnd(25)} +${delta} (${t.prev_imp} → ${t.current_imp})`);
    }
    for (const t of falling.slice(0, 5)) {
      const delta = (t.current_imp - t.prev_imp).toFixed(3);
      lines.push(`  ↓ ${t.project.split('/').pop().padEnd(25)} ${delta} (${t.prev_imp} → ${t.current_imp})`);
    }
  }

  // Hotspots
  if (hotspots.length) {
    lines.push('\n  ── Repeated Hotspots ──\n');
    for (const h of hotspots.slice(0, 8)) {
      const proj = h.project.split('/').pop();
      lines.push(`  ${proj}/${h.tool} (×${h.occurrences}, imp=${h.avg_importance}): ${h.summary_prefix}`);
    }
  }

  // Time sinks
  if (timeSinks.length) {
    lines.push('\n  ── Time Sinks (by prompts) ──\n');
    for (const t of timeSinks.slice(0, 5)) {
      const name = t.project.split('/').pop().padEnd(25);
      lines.push(`  ${name} ${t.total_prompts} prompts across ${t.session_count} sessions (avg ${t.avg_prompts}, max ${t.max_prompts})`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

function frictionBar(score) {
  const blocks = Math.round((score || 0) * 20);
  const bar = '█'.repeat(blocks) + '░'.repeat(20 - blocks);
  return bar;
}
