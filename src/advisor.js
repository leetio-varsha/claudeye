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
import { resolveClaude } from './compress.js';

// Same #85 root cause: hardcoded 'claude' fails when hooks run with a
// minimal PATH or the user installs via ~/.claude/local. Reuse the hardened
// resolver so advisor/digest paths don't regress independently.
const CLAUDE_BIN = resolveClaude();

const DATA_DIR = join(homedir(), '.claudeye');

// ─── System prompt ────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a senior developer advisor analyzing Claude Code usage patterns for a developer.

Your job: give specific, data-driven recommendations that will actually improve their workflow.

Rules:
- Reference specific numbers from the data. Never give generic advice.
- Be direct and opinionated. Say what you think, not what sounds safe.
- If a plugin/model is underperforming vs baseline, say so clearly.
- ALWAYS start with concrete patterns (repeat-fixes, hotspots, time sinks) if present in data.patterns
- Structure your response with these sections:
  ## 🔍 Key Patterns (start with data.patterns.findings — each one is a concrete, verified pattern)
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
- IMPORTANT: If data.patterns exists, include its findings FIRST in your response. These are concrete, verified patterns (repeat-fixes, hotspots, time sinks). Map them to the "friction" or "performance" category.
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
    const result = spawnSync(CLAUDE_BIN, [
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
    const result = spawnSync(CLAUDE_BIN, [
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

// ─── Agent learning: analyze agent actions → recommend improvements (#21) ──

const SYSTEM_PROMPT_AGENT_LEARN = `You are tuning an autonomous coding agent by analyzing its own track record.

You are given the agent's accept/reject feedback, per-agent rejection rates, an
estimate of time saved vs. time spent reviewing its output, and notes on the
actions a developer rejected. Your job: recommend concrete changes to the AGENT
ITSELF so future actions are more useful.

Rules:
- Reference the actual numbers. Never give generic advice.
- Say which agents to make MORE or LESS aggressive based on their rejection rate
  (>50% rejected → reduce aggressiveness for that agent).
- If net time saved is negative, say so plainly and propose what to stop generating.
- Use the rejected-action notes as evidence for what kinds of output are noise.
- If there is no feedback yet (all pending), say the loop can't learn until the
  developer accepts/rejects some actions — don't invent conclusions.

Structure your response:
## 📈 Verdict (is the agent net-positive on time? one line with the number)
## 🎚️ Per-Agent Tuning (more/less aggressive, with rejection rates)
## 🔇 What to stop generating (from rejected-action notes)
## 🎯 One change to make next

Keep it under 400 words. Dense, specific, no fluff.`;

const SYSTEM_PROMPT_AGENT_LEARN_JSON = `You are tuning an autonomous coding agent by analyzing its own accept/reject track record.

Respond ONLY with a valid JSON object. No markdown, no code fences.

JSON schema:
{
  "findings": [
    {
      "category": "tuning" | "noise" | "time" | "coverage",
      "title": "short title (under 80 chars)",
      "description": "2-3 sentences with specific numbers",
      "priority": "high" | "medium" | "low",
      "tasks": ["concrete change to the agent"],
      "actionable": true | false,
      "metric": "the key number behind this finding"
    }
  ],
  "summary": "one-sentence verdict on whether the agent is net-useful",
  "health_score": 0.0-1.0
}

Rules:
- Base every finding on the supplied counts/rates. Never invent data.
- rejection rate >50% for an agent → a high-priority "tuning" finding to reduce its aggressiveness.
- If net time saved is negative → a high-priority "time" finding.
- If all actions are pending (no feedback), return a single finding telling the
  developer the loop can't learn yet, summary saying so, health_score null.`;

/**
 * Analyze the agent's own action history and recommend improvements to the
 * agent (#21 — "advisor analyzes agent actions and recommends improvements").
 *
 * AUP-safe: the payload sent to Claude contains only aggregate counts, agent
 * names, rejection rates, time-saved estimates and user-written feedback notes.
 * It never includes stored query/result payloads or raw_input/raw_output.
 *
 * @param {object} opts
 * @param {number}  [opts.days]    — lookback window in days (default 30)
 * @param {boolean} [opts.stream]  — stream markdown to stdout (default true)
 * @param {'markdown'|'json'} [opts.format]
 */
export async function analyzeAgentActions({ days = 30, stream = true, format = 'markdown' } = {}) {
  const { getAgentEffectiveness, getAgentDigest, getAgentTimeSavings } = await import('./agent.js');

  const eff = getAgentEffectiveness({ sinceDays: days });

  if (eff.total === 0) {
    if (format === 'json') {
      return { findings: [], summary: 'No agent actions in this window yet.', health_score: null };
    }
    return `> No agent actions in the last ${days} days. Run the agent (or daemon) first, then \`claudeye agent learn\`.`;
  }

  const digest  = getAgentDigest({ days });
  const savings = getAgentTimeSavings({ sinceDays: days });

  // AUP-safe payload — counts, names, rates, notes only.
  const payload = {
    window_days: days,
    totals: {
      total:         eff.total,
      accepted:      eff.accepted,
      rejected:      eff.rejected,
      pending:       eff.pending,
      reviewed:      eff.reviewed,
      rejection_rate: eff.rejectionRate,
    },
    by_agent: eff.byAgent.map(a => ({
      agent: a.agent,
      total: a.total,
      accepted: a.accepted,
      rejected: a.rejected,
      pending: a.pending,
      rejection_rate: a.rejectionRate,
    })),
    time_savings: {
      est_minutes_saved:  savings.estMinutesSaved,
      est_review_minutes: savings.estReviewMinutes,
      net_minutes_saved:  savings.netMinutesSaved,
      by_agent: savings.byAgent,
    },
    rejected_action_notes: digest.rejectedNotes.map(r => ({ agent: r.agent, note: r.feedback_note })),
    auto_tuning_signal: (eff.rejectionRate != null && eff.rejectionRate > 0.5)
      ? `rejection rate ${(eff.rejectionRate * 100).toFixed(0)}% > 50% → reduce aggressiveness`
      : null,
  };

  const systemPrompt = format === 'json' ? SYSTEM_PROMPT_AGENT_LEARN_JSON : SYSTEM_PROMPT_AGENT_LEARN;
  const userPrompt = `Analyze this agent's action history over the last ${days} days and recommend improvements.

DATA:
${JSON.stringify(payload, null, 2)}`;
  const fullPrompt = `${systemPrompt}\n\n${userPrompt}`;

  if (stream && format !== 'json') {
    const result = spawnSync(CLAUDE_BIN, ['--print', '-'], {
      input: fullPrompt,
      stdio: ['pipe', 'inherit', 'pipe'],
      encoding: 'utf8',
      timeout: 120_000,
    });
    if (result.status !== 0) throw new Error(`Claude CLI failed: ${result.stderr}`);
    return null; // streamed
  }

  const result = spawnSync(CLAUDE_BIN, ['--print', '-'], {
    input: fullPrompt,
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (result.status !== 0) throw new Error(`Claude CLI failed: ${result.stderr}`);

  return format === 'json' ? parseAdvisorJSON(result.stdout) : result.stdout;
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
