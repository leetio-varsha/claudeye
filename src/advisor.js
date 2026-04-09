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

// Structured JSON output prompt (#17)
const SYSTEM_PROMPT_JSON = `You are a senior developer advisor analyzing Claude Code usage patterns.

Respond ONLY with a valid JSON object. No markdown, no explanation, no code fences.

JSON schema:
{
  "findings": [
    {
      "category": "workflow" | "plugins" | "models" | "issues" | "performance" | "friction",
      "title": "short title (under 80 chars)",
      "description": "2-3 sentence explanation with specific numbers",
      "priority": "high" | "medium" | "low",
      "tasks": ["actionable step 1", "actionable step 2"],
      "actionable": true | false,
      "metric": "optional: the key number behind this finding"
    }
  ],
  "summary": "one-sentence summary of the most important insight",
  "health_score": 0.0-1.0
}

Rules:
- Return 3-7 findings, ordered by priority.
- Reference specific numbers from the data. Never give generic advice.
- Be direct and opinionated.
- Every finding with actionable=true must have at least one task.
- health_score: 0.0 = critical issues, 1.0 = everything great.`;

// ─── On-demand advice ─────────────────────────────────────────────────────

/**
 * Generate advice using Claude Code CLI.
 * Streams output to terminal.
 *
 * @param {object} opts
 * @param {string} opts.focus  — optional focus area: 'plugins'|'workflow'|'issues'
 * @param {number} opts.days   — lookback period in days
 * @param {boolean} opts.stream — stream to stdout vs return string
 * @param {'markdown'|'json'} opts.format — output format (default 'markdown')
 */
export async function generateAdvice({ focus = null, days = 30, stream = true, format = 'markdown' } = {}) {
  const stats   = buildAdvisorPayload(days);
  const isEmpty = stats.overview.total_sessions === 0;

  if (isEmpty) {
    if (format === 'json') {
      return { findings: [], summary: 'Not enough data yet.', health_score: null };
    }
    return '> Not enough data yet. Use Claude Code for a few sessions first, then run `claudeye advise` again.';
  }

  const focusNote = focus ? `\n\nFocus especially on: ${focus}` : '';
  const systemPrompt = format === 'json' ? SYSTEM_PROMPT_JSON : SYSTEM_PROMPT;

  const userPrompt = `Analyze my Claude Code usage for the last ${days} days.${focusNote}

DATA:
${JSON.stringify(stats, null, 2)}`;

  // Pass prompt via stdin to avoid ARG_MAX limits on large payloads (#62)
  const fullPrompt = `${systemPrompt}\n\n${userPrompt}`;

  if (stream && format !== 'json') {
    // Stream directly to terminal via claude CLI
    const result = spawnSync('claude', [
      '--print', '-',
    ], {
      input: fullPrompt,
      stdio: ['pipe', 'inherit', 'pipe'],
      encoding: 'utf8',
      timeout: 120_000,
    });

    if (result.status !== 0) {
      throw new Error(`Claude CLI failed: ${result.stderr}`);
    }
    return null; // output already streamed
  } else {
    // Return as string (for digest storage) or JSON
    const result = spawnSync('claude', [
      '--print', '-',
    ], {
      input: fullPrompt,
      encoding: 'utf8',
      timeout: 120_000,
    });

    if (result.status !== 0) {
      throw new Error(`Claude CLI failed: ${result.stderr}`);
    }

    if (format === 'json') {
      return parseAdvisorJSON(result.stdout);
    }
    return result.stdout;
  }
}

/**
 * Parse and validate structured JSON from advisor output (#17).
 * Handles common LLM quirks: code fences, preamble text, trailing commas.
 *
 * @param {string} raw — raw CLI output
 * @param {number} retries — not used yet, reserved for future retry logic
 * @returns {object} — validated advisor response
 */
function parseAdvisorJSON(raw) {
  let text = raw.trim();

  // Strip markdown code fences if present
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');

  // Try to extract JSON object if wrapped in text
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) text = jsonMatch[0];

  try {
    const parsed = JSON.parse(text);
    return validateAdvisorResponse(parsed);
  } catch (e) {
    // Return a structured error instead of crashing
    return {
      findings: [],
      summary: 'Failed to parse advisor response as JSON.',
      health_score: null,
      _parseError: e.message,
      _raw: raw.slice(0, 500),
    };
  }
}

/**
 * Validate and normalize advisor JSON response.
 */
function validateAdvisorResponse(obj) {
  const result = {
    findings: [],
    summary: obj.summary || '',
    health_score: typeof obj.health_score === 'number' ? Math.max(0, Math.min(1, obj.health_score)) : null,
  };

  if (Array.isArray(obj.findings)) {
    for (const f of obj.findings) {
      if (!f.title || !f.category) continue; // skip malformed
      result.findings.push({
        category: String(f.category || 'unknown'),
        title: String(f.title || '').slice(0, 200),
        description: String(f.description || ''),
        priority: ['high', 'medium', 'low'].includes(f.priority) ? f.priority : 'medium',
        tasks: Array.isArray(f.tasks) ? f.tasks.map(String) : [],
        actionable: Boolean(f.actionable),
        metric: f.metric ? String(f.metric) : undefined,
      });
    }
  }

  return result;
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
