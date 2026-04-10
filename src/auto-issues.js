/**
 * src/auto-issues.js — Auto-create GitHub issues from patterns & advisor (#15)
 *
 * Uses pattern detection + advisor findings to automatically create
 * GitHub issues. Self-improvement loop.
 *
 * Features:
 * - Combines pattern detection findings with advisor JSON output
 * - Deduplication: checks existing open issues before creating
 * - Configurable: repo, project board, max issues per run
 * - Dry-run mode for preview
 * - Trend alerts: friction rising 3+ days → creates issue
 */

import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { detectAllPatterns } from './patterns.js';
import { getDb } from './db.js';

const GH = process.env.GH_PATH || '/opt/homebrew/bin/gh';
const DATA_DIR = join(homedir(), '.claudeye');
const SETTINGS_PATH = join(DATA_DIR, 'settings.json');
const MAX_ISSUES_PER_RUN = 5;

// ─── Settings ────────────────────────────────────────────────────────────

function getSettings() {
  if (!existsSync(SETTINGS_PATH)) return {};
  try {
    return JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'));
  } catch { return {}; }
}

function getAutoIssueConfig() {
  const settings = getSettings();
  return {
    repo:       settings.auto_issues_repo || null,
    projectId:  settings.auto_issues_project_id || null,
    enabled:    settings.auto_issues_enabled !== false,
    maxPerRun:  settings.auto_issues_max_per_run || MAX_ISSUES_PER_RUN,
    ghPath:     settings.gh_path || GH,
  };
}

// ─── GitHub helpers ──────────────────────────────────────────────────────

function gh(args, { repo, ghPath } = {}) {
  const fullArgs = [...args];
  if (repo) fullArgs.push('--repo', repo);
  try {
    return execFileSync(ghPath || GH, fullArgs, { encoding: 'utf8', timeout: 30_000 });
  } catch (e) {
    throw new Error(`gh ${args[0]} failed: ${e.stderr || e.message}`);
  }
}

function getOpenIssues(config) {
  const raw = gh(['issue', 'list', '--state', 'open', '--limit', '100', '--json', 'title,number,labels'], config);
  try {
    return JSON.parse(raw);
  } catch { return []; }
}

function createIssue({ title, body, labels = [] }, config) {
  const args = ['issue', 'create', '--title', title, '--body', body];
  for (const l of labels) args.push('--label', l);
  const out = gh(args, config);
  // Extract issue number from output URL
  const match = out.match(/\/issues\/(\d+)/);
  return match ? parseInt(match[1]) : null;
}

function addToProject(issueNumber, config) {
  if (!config.projectId) return;
  try {
    gh(['issue', 'edit', String(issueNumber), '--add-project', config.projectId], config);
  } catch { /* non-critical */ }
}

// ─── Issue generation from patterns ──────────────────────────────────────

function patternToIssue(finding) {
  const categoryLabels = {
    'repeat-fix':      'tech-debt',
    'hotspot':         'performance',
    'time-sink':       'improvement',
    'friction-trend':  'monitoring',
    'tool-friction':   'improvement',
  };

  const severityEmoji = { high: '🔴', medium: '🟡', low: '🟢' };

  let body = `**Категория:** ${finding.category}\n`;
  body += `**Серьёзность:** ${severityEmoji[finding.severity] || '•'} ${finding.severity}\n`;
  body += `**Проект:** ${finding.project}\n\n`;
  body += `## Описание\n\n${finding.description}\n\n`;
  body += `## Рекомендация\n\n${finding.action}\n\n`;

  // Add data details
  if (finding.data) {
    body += `## Данные\n\n`;
    if (finding.data.hotspot_score) {
      body += `- Hotspot score: **${finding.data.hotspot_score}**\n`;
      body += `- Операций: ${finding.data.total_ops}\n`;
      body += `- Сессий: ${finding.data.sessions}\n`;
      body += `- Ошибок: ${finding.data.error_count}\n`;
      body += `- Retries: ${finding.data.total_retries}\n`;
    }
    if (finding.data.fix_count) {
      body += `- Фиксов: **${finding.data.fix_count}** за ${finding.data.across_days} дней\n`;
      body += `- В ${finding.data.across_sessions} сессиях\n`;
    }
    if (finding.data.delta !== undefined) {
      body += `- Изменение friction: **${finding.data.delta > 0 ? '+' : ''}${finding.data.delta}**\n`;
      body += `- Раньше: ${finding.data.earlier?.avg_friction} (${finding.data.earlier?.sessions} sessions)\n`;
      body += `- Сейчас: ${finding.data.recent?.avg_friction} (${finding.data.recent?.sessions} sessions)\n`;
    }
  }

  body += '\n---\n*Создано автоматически через `claudeye auto-issues` (#15)*';

  return {
    title: `[auto] ${finding.title}`,
    body,
    labels: [categoryLabels[finding.category] || 'improvement'].filter(Boolean),
    priority: finding.severity,
  };
}

// ─── Trend detection ─────────────────────────────────────────────────────

function detectFrictionTrendAlerts() {
  const db = getDb();
  const alerts = [];

  // Check for 3+ consecutive days of rising friction per project
  const trends = db.prepare(`
    SELECT
      project,
      DATE(started_at) AS day,
      AVG(friction_score) AS avg_friction
    FROM sessions
    WHERE started_at >= datetime('now', '-7 days')
      AND friction_score > 0
      AND id NOT LIKE 'import-git-%'
    GROUP BY project, day
    HAVING COUNT(*) >= 1
    ORDER BY project, day
  `).all();

  // Group by project and check for 3+ day rises
  const byProject = {};
  for (const row of trends) {
    const proj = row.project?.split('/').pop() || 'unknown';
    if (!byProject[proj]) byProject[proj] = [];
    byProject[proj].push({ day: row.day, friction: row.avg_friction });
  }

  for (const [proj, days] of Object.entries(byProject)) {
    if (days.length < 3) continue;
    // Check last 3 days for consecutive increase
    const recent = days.slice(-3);
    if (recent[0].friction < recent[1].friction && recent[1].friction < recent[2].friction) {
      const delta = +(recent[2].friction - recent[0].friction).toFixed(3);
      alerts.push({
        category:    'friction-trend',
        severity:    delta > 0.05 ? 'high' : 'medium',
        title:       `${proj}: friction растёт 3 дня подряд (+${delta})`,
        description: `Friction в ${proj}: ${recent[0].friction.toFixed(3)} → ${recent[2].friction.toFixed(3)} за 3 дня`,
        project:     proj,
        action:      `Проверь последние изменения в ${proj} — friction растёт устойчиво`,
        data:        { days: recent, delta },
      });
    }
  }

  return alerts;
}

// ─── Deduplication ───────────────────────────────────────────────────────

function isDuplicate(issue, existingIssues) {
  const titleLower = issue.title.toLowerCase();
  for (const existing of existingIssues) {
    const existingLower = existing.title.toLowerCase();
    // Exact match
    if (existingLower === titleLower) return true;
    // Partial match: same [auto] prefix + similar content
    if (existingLower.includes('[auto]') && titleLower.includes('[auto]')) {
      // Extract the core part after [auto]
      const coreA = titleLower.replace('[auto] ', '').split(':')[0];
      const coreB = existingLower.replace('[auto] ', '').split(':')[0];
      if (coreA === coreB) return true;
    }
  }
  return false;
}

// ─── Main entry point ────────────────────────────────────────────────────

export async function runAutoIssues({ dryRun = false, days = 14, advisorFindings = null } = {}) {
  const config = getAutoIssueConfig();

  if (!config.repo) {
    throw new Error('auto_issues_repo not configured in ~/.claudeye/settings.json. Run: claudeye setup-auto-issues');
  }

  // 1. Gather findings from patterns
  const patterns = detectAllPatterns({ days });
  const trendAlerts = detectFrictionTrendAlerts();

  // 2. Combine all sources
  const allFindings = [
    ...patterns.findings,
    ...trendAlerts,
  ];

  // Add advisor findings if provided
  if (advisorFindings?.length) {
    for (const f of advisorFindings) {
      if (f.actionable && f.priority === 'high') {
        allFindings.push({
          category:    f.category || 'workflow',
          severity:    f.priority,
          title:       f.title,
          description: f.description,
          project:     'cross-project',
          action:      f.tasks?.join('; ') || f.description,
          data:        { metric: f.metric },
        });
      }
    }
  }

  // 3. Filter: only high/medium severity, limit to maxPerRun
  const candidates = allFindings
    .filter(f => f.severity === 'high' || f.severity === 'medium')
    .slice(0, config.maxPerRun);

  if (!candidates.length) {
    return { created: 0, skipped: 0, issues: [], message: 'Нет findings достаточной серьёзности для создания issues.' };
  }

  // 4. Generate issue objects
  const issues = candidates.map(patternToIssue);

  // 5. Deduplication
  let existingIssues = [];
  if (!dryRun) {
    try {
      existingIssues = getOpenIssues(config);
    } catch (e) {
      console.error(`  Warning: couldn't fetch existing issues: ${e.message}`);
    }
  }

  const results = [];
  let created = 0;
  let skipped = 0;

  for (const issue of issues) {
    if (isDuplicate(issue, existingIssues)) {
      results.push({ ...issue, status: 'skipped', reason: 'duplicate' });
      skipped++;
      continue;
    }

    if (dryRun) {
      results.push({ ...issue, status: 'dry-run' });
      created++;
    } else {
      try {
        const num = createIssue(issue, config);
        if (num && config.projectId) {
          addToProject(num, config);
        }
        results.push({ ...issue, status: 'created', number: num });
        created++;
        // Add to existing for dedup within same run
        existingIssues.push({ title: issue.title, number: num });
      } catch (e) {
        results.push({ ...issue, status: 'error', error: e.message });
      }
    }
  }

  return {
    created,
    skipped,
    total: issues.length,
    issues: results,
    message: `${created} issues ${dryRun ? 'would be' : ''} created, ${skipped} skipped (duplicates)`,
  };
}
