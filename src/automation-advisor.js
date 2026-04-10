/**
 * src/automation-advisor.js — Automation opportunity detector (#16)
 *
 * Analyzes real workflow patterns from mem.db and recommends concrete automations.
 * Each recommendation includes: type, estimated time saved, complexity, ROI score.
 *
 * Categories:
 * 1. Task management (issue creation, status updates)
 * 2. Code review / PR (review patterns, stale PRs)
 * 3. Monitoring (CI/CD failures, issue aging, hook health)
 * 4. Documentation (stale docs, README updates)
 * 5. Communication (standup generation, weekly digest)
 */

import { getDb } from './db.js';
import { detectAllPatterns } from './patterns.js';

// ─── Recommendation types ────────────────────────────────────────────────

const AUTOMATION_TYPES = {
  scheduler:     { label: 'Scheduler',      icon: '⏰', complexity: 'low' },
  hook:          { label: 'Hook',           icon: '🪝', complexity: 'low' },
  script:        { label: 'Script/CLI',     icon: '📜', complexity: 'medium' },
  github_action: { label: 'GitHub Action',  icon: '🔄', complexity: 'medium' },
  integration:   { label: 'Integration',    icon: '🔗', complexity: 'high' },
};

// ─── Detectors ───────────────────────────────────────────────────────────

function detectTaskManagementOpportunities(db, days) {
  const recommendations = [];

  // Repeat error→fix cycles that should auto-create issues
  const repeatErrors = db.prepare(`
    SELECT o.project, COUNT(*) as error_count,
           COUNT(DISTINCT DATE(o.created_at)) as days_with_errors,
           COUNT(DISTINCT o.session_id) as sessions
    FROM observations o
    WHERE o.created_at >= datetime('now', '-' || ? || ' days')
      AND (o.tags LIKE '%error%' OR o.tags LIKE '%bugfix%')
    GROUP BY o.project
    HAVING error_count >= 5
    ORDER BY error_count DESC
  `).all(days);

  for (const r of repeatErrors) {
    const proj = r.project?.split('/').pop() || 'unknown';
    recommendations.push({
      category:    'task-management',
      type:        'scheduler',
      title:       `Auto-create issues из повторяющихся ошибок в ${proj}`,
      description: `${r.error_count} ошибок за ${r.days_with_errors} дней в ${r.sessions} сессиях. Используй \`claudeye auto-issues\` по расписанию.`,
      time_saved:  5, // мин/неделю
      complexity:  'low',
      action:      `claudeye auto-issues --days ${days}`,
      project:     proj,
      data:        r,
    });
  }

  // Stale open issues (not updated in 7+ days)
  const staleIssues = db.prepare(`
    SELECT project, COUNT(*) as stale_count,
           AVG(ROUND((julianday('now') - julianday(opened_at)) * 24, 0)) as avg_hours_open
    FROM issues
    WHERE status = 'open'
      AND opened_at < datetime('now', '-7 days')
    GROUP BY project
    HAVING stale_count >= 2
  `).all();

  for (const s of staleIssues) {
    const proj = s.project?.split('/').pop() || 'unknown';
    recommendations.push({
      category:    'task-management',
      type:        'scheduler',
      title:       `Мониторинг stale issues в ${proj}`,
      description: `${s.stale_count} issues открыты >7 дней (avg ${Math.round(s.avg_hours_open / 24)}d). Нужен scheduled sweep.`,
      time_saved:  3,
      complexity:  'low',
      action:      'Добавь scheduled task для проверки stale issues с нотификацией',
      project:     proj,
      data:        s,
    });
  }

  return recommendations;
}

function detectCodeReviewOpportunities(db, days) {
  const recommendations = [];

  // High-friction sessions that could benefit from pre-commit checks
  const highFrictionProjects = db.prepare(`
    SELECT project, AVG(friction_score) as avg_friction,
           COUNT(*) as sessions,
           SUM(CASE WHEN friction_score > 0.2 THEN 1 ELSE 0 END) as high_friction_sessions
    FROM sessions
    WHERE started_at >= datetime('now', '-' || ? || ' days')
      AND friction_score > 0
      AND id NOT LIKE 'import-git-%'
    GROUP BY project
    HAVING avg_friction > 0.15 AND sessions >= 3
    ORDER BY avg_friction DESC
  `).all(days);

  for (const p of highFrictionProjects) {
    const proj = p.project?.split('/').pop() || 'unknown';
    recommendations.push({
      category:    'code-review',
      type:        'github_action',
      title:       `CI quality gate для ${proj}`,
      description: `Avg friction ${p.avg_friction.toFixed(2)} за ${p.sessions} сессий (${p.high_friction_sessions} с friction >0.2). Нужны pre-merge checks.`,
      time_saved:  10,
      complexity:  'medium',
      action:      'Добавь GitHub Action: lint + test + type-check на каждый PR',
      project:     proj,
      data:        p,
    });
  }

  // Projects with lots of retries → need better validation
  const retryHeavy = db.prepare(`
    SELECT o.project, o.tool, SUM(o.retry_count) as total_retries,
           COUNT(*) as ops, AVG(o.retry_count) as avg_retries
    FROM observations o
    WHERE o.created_at >= datetime('now', '-' || ? || ' days')
      AND o.retry_count > 0
    GROUP BY o.project, o.tool
    HAVING total_retries >= 10 AND avg_retries > 0.5
    ORDER BY total_retries DESC
    LIMIT 5
  `).all(days);

  for (const r of retryHeavy) {
    const proj = r.project?.split('/').pop() || 'unknown';
    recommendations.push({
      category:    'code-review',
      type:        'hook',
      title:       `Pre-validation для ${r.tool} в ${proj}`,
      description: `${r.total_retries} retries за ${r.ops} операций (avg ${r.avg_retries.toFixed(1)}). Pre-validation может сократить retries.`,
      time_saved:  Math.round(r.total_retries * 0.5), // ~30 sec per retry saved
      complexity:  'medium',
      action:      `Добавь pre-validation hook для ${r.tool}: проверка синтаксиса/типов перед выполнением`,
      project:     proj,
      data:        r,
    });
  }

  return recommendations;
}

function detectMonitoringOpportunities(db, days) {
  const recommendations = [];

  // DB growth monitoring
  const dbMetrics = db.prepare(`
    SELECT COUNT(*) as total_obs,
           COUNT(DISTINCT project) as projects,
           MIN(created_at) as first_obs,
           ROUND(julianday('now') - julianday(MIN(created_at))) as days_of_data
    FROM observations
  `).get();

  if (dbMetrics.days_of_data > 7) {
    const dailyRate = dbMetrics.total_obs / dbMetrics.days_of_data;
    if (dailyRate > 500) {
      recommendations.push({
        category:    'monitoring',
        type:        'scheduler',
        title:       'Auto-compact DB (weekly)',
        description: `${Math.round(dailyRate)} obs/день, ${dbMetrics.total_obs} total. Нужен автоматический VACUUM + cleanup старых данных.`,
        time_saved:  5,
        complexity:  'low',
        action:      'Добавь weekly scheduler: VACUUM + удаление obs старше 90 дней',
        project:     'claudeye',
        data:        { dailyRate, totalObs: dbMetrics.total_obs },
      });
    }
  }

  // Hook error monitoring
  try {
    const hookErrors = db.prepare(`
      SELECT COUNT(*) as error_count,
             COUNT(DISTINCT DATE(created_at)) as days_with_errors
      FROM hook_errors
      WHERE created_at >= datetime('now', '-' || ? || ' days')
    `).get(days);

    if (hookErrors.error_count > 10) {
      recommendations.push({
        category:    'monitoring',
        type:        'scheduler',
        title:       'Hook health monitoring',
        description: `${hookErrors.error_count} hook errors за ${hookErrors.days_with_errors} дней. Нужен автоматический мониторинг.`,
        time_saved:  5,
        complexity:  'low',
        action:      'claudeye insights --no-notify (scheduled daily)',
        project:     'claudeye',
        data:        hookErrors,
      });
    }
  } catch { /* hook_errors table might not exist */ }

  // Friction trend monitoring
  const frictionSpikes = db.prepare(`
    SELECT project,
           AVG(CASE WHEN started_at >= datetime('now', '-7 days') THEN friction_score END) as recent,
           AVG(CASE WHEN started_at < datetime('now', '-7 days')
                     AND started_at >= datetime('now', '-' || ? || ' days') THEN friction_score END) as earlier
    FROM sessions
    WHERE friction_score > 0 AND id NOT LIKE 'import-git-%'
      AND started_at >= datetime('now', '-' || ? || ' days')
    GROUP BY project
    HAVING recent > earlier * 1.3 AND recent > 0.1
  `).all(days, days);

  if (frictionSpikes.length > 0) {
    recommendations.push({
      category:    'monitoring',
      type:        'scheduler',
      title:       'Автоматический friction alert',
      description: `${frictionSpikes.length} проектов с растущим friction. Настрой автоматический мониторинг.`,
      time_saved:  3,
      complexity:  'low',
      action:      'claudeye insights (scheduled daily) + notification на friction spikes',
      project:     'cross-project',
      data:        { projects: frictionSpikes.map(p => p.project?.split('/').pop()) },
    });
  }

  return recommendations;
}

function detectDocumentationOpportunities(db, days) {
  const recommendations = [];

  // Projects with activity but no doc updates
  const activeProjects = db.prepare(`
    SELECT project, COUNT(*) as obs_count, MAX(created_at) as last_activity
    FROM observations
    WHERE created_at >= datetime('now', '-' || ? || ' days')
    GROUP BY project
    HAVING obs_count >= 50
  `).all(days);

  const docUpdates = db.prepare(`
    SELECT project, MAX(created_at) as last_doc_edit
    FROM observations
    WHERE (raw_input LIKE '%README%' OR raw_input LIKE '%CHANGELOG%' OR raw_input LIKE '%docs/%')
      AND tool IN ('Edit', 'Write')
    GROUP BY project
  `).all();

  const docMap = {};
  for (const d of docUpdates) docMap[d.project] = d.last_doc_edit;

  for (const p of activeProjects) {
    const lastDoc = docMap[p.project];
    if (!lastDoc || new Date(lastDoc) < new Date(Date.now() - 14 * 86400000)) {
      const proj = p.project?.split('/').pop() || 'unknown';
      recommendations.push({
        category:    'documentation',
        type:        'hook',
        title:       `Auto-update CLAUDE.md для ${proj}`,
        description: `${p.obs_count} obs за ${days}d, но docs не обновлялись ${lastDoc ? '14+ дней' : 'никогда'}. claudeye generate-claude-md может обновлять автоматически.`,
        time_saved:  10,
        complexity:  'low',
        action:      `claudeye generate-claude-md -p ${p.project} (scheduled weekly)`,
        project:     proj,
        data:        { obs_count: p.obs_count, last_doc: lastDoc },
      });
    }
  }

  return recommendations;
}

function detectCommunicationOpportunities(db, days) {
  const recommendations = [];

  // Check if digest is working
  const digestCount = db.prepare(`
    SELECT COUNT(*) as n FROM digests WHERE created_at >= datetime('now', '-' || ? || ' days')
  `).get(days);

  if (digestCount.n === 0 && days >= 7) {
    recommendations.push({
      category:    'communication',
      type:        'scheduler',
      title:       'Weekly digest не генерируется',
      description: `0 дайджестов за ${days} дней. Проверь launchd agent или настрой Cowork scheduler.`,
      time_saved:  15,
      complexity:  'low',
      action:      'claudeye digest --generate (проверь scheduler)',
      project:     'claudeye',
    });
  }

  // Standup data availability
  const dailyActivity = db.prepare(`
    SELECT DATE(created_at) as day, COUNT(*) as obs,
           COUNT(DISTINCT project) as projects
    FROM observations
    WHERE created_at >= datetime('now', '-7 days')
      AND tool != 'git-commit'
    GROUP BY day
    HAVING obs >= 20
  `).all();

  if (dailyActivity.length >= 3) {
    recommendations.push({
      category:    'communication',
      type:        'scheduler',
      title:       'Auto-standup из Claudeye данных',
      description: `${dailyActivity.length} активных дней за неделю (avg ${Math.round(dailyActivity.reduce((s, d) => s + d.obs, 0) / dailyActivity.length)} obs/день). Достаточно для автоматического standup.`,
      time_saved:  10,
      complexity:  'medium',
      action:      'Добавь утренний scheduler: claudeye daily-summary → Slack/Notion',
      project:     'cross-project',
      data:        { active_days: dailyActivity.length },
    });
  }

  return recommendations;
}

// ─── ROI scoring ─────────────────────────────────────────────────────────

function scoreROI(rec) {
  const complexityMultiplier = { low: 3, medium: 2, high: 1 };
  const multiplier = complexityMultiplier[rec.complexity] || 1;
  // ROI = time_saved * frequency_multiplier / complexity
  // Higher = better ROI
  return +(rec.time_saved * multiplier / 4).toFixed(1); // normalize to ~1-10 scale
}

// ─── Consolidation ───────────────────────────────────────────────────────
// Group similar recommendations across projects into single actionable items

function consolidateRecommendations(recs) {
  const groups = {};

  for (const r of recs) {
    // Key: same category + type → consolidate
    const key = `${r.category}:${r.type}`;
    if (!groups[key]) {
      groups[key] = { ...r, projects: [r.project], count: 1 };
    } else {
      groups[key].projects.push(r.project);
      groups[key].count++;
      groups[key].time_saved += r.time_saved;
    }
  }

  return Object.values(groups).map(g => {
    if (g.count > 1) {
      const projList = g.projects.slice(0, 3).join(', ');
      const more = g.count > 3 ? ` +${g.count - 3} ещё` : '';
      g.title = `${g.title.split(' для ')[0]} (${g.count} проектов: ${projList}${more})`;
      g.project = `${g.count} projects`;
    }
    return g;
  });
}

// ─── Main entry point ────────────────────────────────────────────────────

export function getAutomationRecommendations({ days = 14 } = {}) {
  const db = getDb();

  const rawRecs = [
    ...detectTaskManagementOpportunities(db, days),
    ...detectCodeReviewOpportunities(db, days),
    ...detectMonitoringOpportunities(db, days),
    ...detectDocumentationOpportunities(db, days),
    ...detectCommunicationOpportunities(db, days),
  ];

  // Consolidate similar recommendations across projects
  const allRecs = consolidateRecommendations(rawRecs);

  // Score and sort by ROI
  for (const rec of allRecs) {
    rec.roi = scoreROI(rec);
    const typeInfo = AUTOMATION_TYPES[rec.type] || {};
    rec.type_label = typeInfo.label || rec.type;
    rec.type_icon  = typeInfo.icon || '•';
  }

  allRecs.sort((a, b) => b.roi - a.roi);

  // Summary
  const byCategory = {};
  const byType = {};
  let totalTimeSaved = 0;

  for (const r of allRecs) {
    byCategory[r.category] = (byCategory[r.category] || 0) + 1;
    byType[r.type] = (byType[r.type] || 0) + 1;
    totalTimeSaved += r.time_saved;
  }

  return {
    recommendations: allRecs,
    summary: {
      total:           allRecs.length,
      total_time_saved: totalTimeSaved,
      by_category:     byCategory,
      by_type:         byType,
      top_roi:         allRecs.slice(0, 3).map(r => r.title),
    },
  };
}
