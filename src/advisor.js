/**
 * src/advisor.js — Claude-powered usage advisor
 *
 * Uses `claude -p` CLI — no API key needed, uses your subscription.
 * Analyzes aggregated stats and returns actionable recommendations.
 */

import { execFileSync, spawnSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { buildAdvisorPayload } from './analytics.js';
import { getDb } from './db.js';

const DATA_DIR = join(homedir(), '.claudeye');

// ─── System prompt ────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a senior developer advisor analyzing Claude Code usage patterns for a developer.

Your job: give specific, data-driven recommendations that will actually improve their workflow.

Rules:
- Reference specific numbers from the data. Never give generic advice.
- Be direct and opinionated. Say what you think, not what sounds safe.
- If a plugin/model is underperforming vs baseline, say so clearly.
- Structure your response with these sections:
  ## 🔍 Key Patterns
  ## ⚡ Top 3 Recommendations  
  ## 🔌 Plugin & Model Insights
  ## 🐛 Issue Resolution Analysis
  ## 🎯 One Big Change

Keep total response under 600 words. Dense, useful, no fluff.`;

// ─── On-demand advice ─────────────────────────────────────────────────────

/**
 * Generate advice using Claude Code CLI.
 * Streams output to terminal.
 *
 * @param {object} opts
 * @param {string} opts.focus  — optional focus area: 'plugins'|'workflow'|'issues'
 * @param {number} opts.days   — lookback period in days
 * @param {boolean} opts.stream — stream to stdout vs return string
 */
export async function generateAdvice({ focus = null, days = 30, stream = true } = {}) {
  const stats   = buildAdvisorPayload(days);
  const isEmpty = stats.overview.total_sessions === 0;

  if (isEmpty) {
    return '> Not enough data yet. Use Claude Code for a few sessions first, then run `claudeye advise` again.';
  }

  const focusNote = focus ? `\n\nFocus especially on: ${focus}` : '';

  const userPrompt = `Analyze my Claude Code usage for the last ${days} days.${focusNote}

DATA:
${JSON.stringify(stats, null, 2)}`;

  if (stream) {
    // Stream directly to terminal via claude CLI
    const result = spawnSync('claude', [
      '--print',
      '--system', SYSTEM_PROMPT,
      userPrompt,
    ], {
      stdio: ['pipe', 'inherit', 'pipe'],
      encoding: 'utf8',
      timeout: 120_000,
    });

    if (result.status !== 0) {
      throw new Error(`Claude CLI failed: ${result.stderr}`);
    }
    return null; // output already streamed
  } else {
    // Return as string (for digest storage)
    const result = spawnSync('claude', [
      '--print',
      '--system', SYSTEM_PROMPT,
      userPrompt,
    ], {
      encoding: 'utf8',
      timeout: 120_000,
    });

    if (result.status !== 0) {
      throw new Error(`Claude CLI failed: ${result.stderr}`);
    }
    return result.stdout;
  }
}

// ─── Weekly digest ────────────────────────────────────────────────────────

/**
 * Generate and store weekly digest.
 * Idempotent — won't regenerate if this week's digest already exists.
 */
export async function generateWeeklyDigest({ force = false } = {}) {
  const db = getDb();

  // Get Monday of current week
  const now       = new Date();
  const day       = now.getDay();
  const monday    = new Date(now);
  monday.setDate(now.getDate() - (day === 0 ? 6 : day - 1));
  const weekStart = monday.toISOString().slice(0, 10);

  // Check if already exists
  if (!force) {
    const existing = db.prepare('SELECT id FROM digests WHERE week_start = ?').get(weekStart);
    if (existing) {
      console.error(`[mem:digest] Digest for week ${weekStart} already exists. Use --force to regenerate.`);
      return null;
    }
  }

  console.error(`[mem:digest] Generating digest for week of ${weekStart}...`);

  const stats  = buildAdvisorPayload(7);
  const report = await generateAdvice({ days: 7, stream: false });

  db.prepare(`
    INSERT OR REPLACE INTO digests (week_start, report, raw_stats)
    VALUES (?, ?, ?)
  `).run(weekStart, report, JSON.stringify(stats));

  console.error(`[mem:digest] Saved.`);
  return report;
}

/**
 * Get the latest stored digest.
 */
export function getLatestDigest() {
  return getDb().prepare(`
    SELECT * FROM digests ORDER BY week_start DESC LIMIT 1
  `).get();
}

/**
 * List all digests.
 */
export function listDigests() {
  return getDb().prepare(`
    SELECT week_start, created_at,
           substr(report, 1, 200) AS preview
    FROM digests
    ORDER BY week_start DESC
  `).all();
}

// ─── Issue auto-detection ─────────────────────────────────────────────────

/**
 * Scan recent observations for issue patterns and auto-create issue records.
 * Runs at session end (from summary-hook).
 *
 * Detection logic:
 * - Observation tagged 'error' or 'bugfix' and importance >= 0.7 → open issue
 * - Subsequent observation in same project tagged 'bugfix' referencing similar area → resolve
 */
export function detectIssues(sessionId, project) {
  const db = getDb();

  const obs = db.prepare(`
    SELECT id, summary, tags, importance, created_at
    FROM observations
    WHERE session_id = ? AND importance >= 0.6
    ORDER BY created_at ASC
  `).all(sessionId);

  for (const o of obs) {
    const tags = JSON.parse(o.tags || '[]');
    const isError = tags.some(t => ['error', 'bug', 'crash', 'broken', 'failed'].includes(t));
    const isFix   = tags.some(t => ['bugfix', 'fix', 'resolved', 'patched'].includes(t));

    if (isError && !isFix) {
      // Check if similar open issue already exists (avoid duplicates)
      const existing = db.prepare(`
        SELECT id FROM issues
        WHERE project = ? AND status = 'open'
          AND title LIKE ?
        LIMIT 1
      `).get(project, '%' + o.summary.slice(0, 30) + '%');

      if (!existing) {
        db.prepare(`
          INSERT INTO issues (project, title, status, session_ids, obs_ids, complexity)
          VALUES (?, ?, 'open', ?, ?, ?)
        `).run(
          project,
          o.summary.slice(0, 200),
          JSON.stringify([sessionId]),
          JSON.stringify([o.id]),
          o.importance
        );
      }
    }

    if (isFix) {
      // Try to resolve matching open issue
      const openIssues = db.prepare(`
        SELECT id, session_ids, obs_ids, opened_at FROM issues
        WHERE project = ? AND status = 'open'
        ORDER BY opened_at ASC
        LIMIT 5
      `).all(project);

      for (const issue of openIssues) {
        const resMs = new Date(o.created_at) - new Date(issue.opened_at);
        const sessionIds = JSON.parse(issue.session_ids);
        const obsIds     = JSON.parse(issue.obs_ids);

        if (!sessionIds.includes(sessionId)) sessionIds.push(sessionId);
        if (!obsIds.includes(o.id)) obsIds.push(o.id);

        db.prepare(`
          UPDATE issues
          SET status = 'resolved',
              resolved_at = datetime('now'),
              resolution_ms = ?,
              session_ids = ?,
              obs_ids = ?
          WHERE id = ?
        `).run(resMs, JSON.stringify(sessionIds), JSON.stringify(obsIds), issue.id);

        break; // resolve only the oldest matching open issue
      }
    }
  }
}
