/**
 * src/behavioral-advisor.js — Claude-powered behavioral advisor (#87)
 *
 * Отличие от `src/advisor.js` (который тоже зовёт Claude):
 *   - advisor.js   → general findings, ориентирован на ML/model/plugin разрезы
 *   - behavioral.js→ поведенческие паттерны + конкретные предложения автоматизаций
 *                    с implementation draft, пишет в таблицу `advises` с дедупом
 *                    через observation_hash и памятью о dismissed советах.
 *
 * Философия: advisor не просто говорит «длинные сессии = плохо», а:
 *   1. Observation — паттерн поведения (не метрика)
 *   2. Why         — конкретный impact (квота/контекст/качество/время)
 *   3. Proposal    — hook/script/scheduler, который это решит
 *   4. Implementation — черновик кода или CLI
 *   5. Confidence  — low/medium/high
 */

import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { buildAdvisorPayload } from './analytics.js';
import { getDb } from './db.js';
import { resolveClaude } from './compress.js';

const CLAUDE_BIN = resolveClaude();

// ─── System prompt ────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a behavioral advisor analyzing how a specific developer uses Claude Code.

Your job: surface BEHAVIORAL PATTERNS (not metric thresholds) and propose concrete automations the developer can implement.

HARD REQUIREMENTS — response MUST be a valid JSON object, no markdown, no preamble:

{
  "advises": [
    {
      "category": "quota" | "time-of-day" | "model" | "hotspot" | "repeat-fix" | "context-switch" | "tooling" | "handoff" | "issue-lifecycle" | "meta",
      "observation": "2-3 sentences describing the behavior pattern in plain language (not metrics)",
      "why":         "2-3 sentences explaining concrete impact on quota, context quality, time, or reliability",
      "proposal":    "1-2 sentences proposing a specific hook/script/scheduler/CLI change",
      "code_draft":  "optional: code snippet, CLI command, or file path — at least a concrete entry point",
      "confidence":  "low" | "medium" | "high"
    }
  ],
  "summary": "one-sentence meta-summary"
}

RULES:
- Return 3–7 advises, ordered by confidence (high first).
- Each advise describes BEHAVIOR, not a metric. Bad: "2 sessions exceeded 250 prompts". Good: "You routinely hold multi-hour sessions in entravel-fe that grow past 250 prompts, letting context accumulate beyond the useful horizon."
- The "proposal" MUST be a concrete automation — a hook name, a CLI command, a scheduler, or a script path. Never generic advice like "be careful".
- If data lacks signal for a dimension, skip it. Do NOT invent findings.
- Reference real project names and real numbers when supporting the observation.
- RESPECT dismissed history: if data.dismissed_categories contains a category, AVOID proposing the same kind of advice unless there's genuinely new evidence.
- RESPECT user preferences: if data.acceptance_stats suggests user prefers scripts over hooks (or vice versa), favor that.
- "code_draft" is optional but strongly preferred — at minimum a file path or CLI command the user can run.`;

// ─── Data augmentation ───────────────────────────────────────────────────

/**
 * Compute additional behavioral signals that standard advisor payload misses.
 */
function buildBehavioralPayload(days = 14) {
  const db = getDb();
  const base = buildAdvisorPayload(days);

  // Session length distribution
  const sessionLength = db.prepare(`
    SELECT
      COUNT(*)                    AS total_sessions,
      ROUND(AVG(prompt_count),1)  AS avg_prompts,
      MAX(prompt_count)           AS max_prompts,
      SUM(CASE WHEN prompt_count >= 250 THEN 1 ELSE 0 END) AS sessions_ge_250,
      SUM(CASE WHEN prompt_count >= 100 THEN 1 ELSE 0 END) AS sessions_ge_100,
      SUM(CASE WHEN prompt_count < 10 THEN 1 ELSE 0 END)   AS sessions_lt_10
    FROM sessions
    WHERE started_at >= datetime('now', '-' || ? || ' days')
      AND id NOT LIKE 'import-git-%'
  `).get(days);

  // Time-of-day friction (UTC hour buckets)
  const timeOfDay = db.prepare(`
    SELECT
      strftime('%H', started_at)   AS hour_utc,
      ROUND(AVG(friction_score),3) AS avg_friction,
      COUNT(*)                     AS n
    FROM sessions
    WHERE started_at >= datetime('now', '-' || ? || ' days')
      AND friction_score > 0
    GROUP BY hour_utc
    HAVING n >= 3
    ORDER BY hour_utc
  `).all(days);

  // Project switching per day
  const projectSwitching = db.prepare(`
    SELECT
      DATE(started_at) AS day,
      COUNT(DISTINCT project) AS distinct_projects
    FROM sessions
    WHERE started_at >= datetime('now', '-' || ? || ' days')
      AND id NOT LIKE 'import-git-%'
    GROUP BY day
    ORDER BY day DESC
    LIMIT 14
  `).all(days);

  // Model + io ratio — which sessions are read-heavy vs write-heavy
  const modelRatios = db.prepare(`
    SELECT
      model,
      COUNT(*) AS n,
      ROUND(AVG(token_input * 1.0 / NULLIF(token_output, 0)), 1) AS avg_io_ratio,
      ROUND(AVG(token_input), 0)  AS avg_tokens_in,
      ROUND(AVG(token_output), 0) AS avg_tokens_out
    FROM sessions
    WHERE started_at >= datetime('now', '-' || ? || ' days')
      AND token_input IS NOT NULL
      AND model IS NOT NULL
    GROUP BY model
  `).all(days);

  // Past advise feedback — what user accepted/dismissed
  const acceptanceStats = db.prepare(`
    SELECT
      category,
      SUM(CASE WHEN status = 'accepted' OR status = 'applied' THEN 1 ELSE 0 END) AS accepted,
      SUM(CASE WHEN status = 'dismissed' THEN 1 ELSE 0 END) AS dismissed,
      COUNT(*) AS total
    FROM advises
    WHERE created_at >= datetime('now', '-90 days')
    GROUP BY category
  `).all();

  const dismissedHashes = db.prepare(`
    SELECT observation_hash FROM advises
    WHERE status = 'dismissed' AND dismissed_at >= datetime('now', '-90 days')
  `).all().map(r => r.observation_hash);

  const dismissedCategories = db.prepare(`
    SELECT category, COUNT(*) AS n
    FROM advises
    WHERE status = 'dismissed' AND dismissed_at >= datetime('now', '-30 days')
    GROUP BY category
    HAVING n >= 2
  `).all().map(r => r.category);

  // Repeat-fix detection — same file edited repeatedly with errors.
  // raw_input isn't always valid JSON (truncated to 2000 chars), so guard with json_valid.
  const repeatFixes = db.prepare(`
    SELECT
      project,
      CASE WHEN json_valid(raw_input) THEN json_extract(raw_input, '$.file_path') END AS file_path,
      COUNT(*) AS edits,
      SUM(CASE WHEN tags LIKE '%error%' THEN 1 ELSE 0 END) AS error_edits
    FROM observations
    WHERE created_at >= datetime('now', '-' || ? || ' days')
      AND tool IN ('Edit', 'Write')
      AND raw_input LIKE '%file_path%'
      AND json_valid(raw_input)
    GROUP BY project, file_path
    HAVING edits >= 4 AND error_edits >= 2 AND file_path IS NOT NULL
    ORDER BY edits DESC
    LIMIT 10
  `).all(days);

  return {
    ...base,
    behavioral: {
      session_length: sessionLength,
      time_of_day_friction: timeOfDay,
      project_switching_per_day: projectSwitching,
      model_io_ratios: modelRatios,
      repeat_fixes: repeatFixes,
    },
    feedback: {
      acceptance_stats: acceptanceStats,
      dismissed_categories: dismissedCategories,
      dismissed_hashes_count: dismissedHashes.length,
    },
  };
}

// ─── Hash for dedup ───────────────────────────────────────────────────────

function observationHash(category, observation) {
  // Normalize: lowercase, strip numbers/dates, keep key nouns/verbs
  const normalized = observation
    .toLowerCase()
    .replace(/\d+/g, '')
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3)
    .sort()
    .slice(0, 20)
    .join(' ');
  return createHash('sha256').update(`${category}|${normalized}`).digest('hex').slice(0, 16);
}

// ─── Parse Claude JSON output ─────────────────────────────────────────────

function parseBehavioralJSON(raw) {
  let text = raw.trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) text = jsonMatch[0];

  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed.advises)) {
      return { advises: [], summary: parsed.summary || '', _parseError: 'missing advises array' };
    }
    // Validate + normalize each advise
    const advises = [];
    for (const a of parsed.advises) {
      if (!a.category || !a.observation || !a.why || !a.proposal) continue;
      advises.push({
        category:    String(a.category),
        observation: String(a.observation).slice(0, 2000),
        why:         String(a.why).slice(0, 2000),
        proposal:    String(a.proposal).slice(0, 2000),
        code_draft:  a.code_draft ? String(a.code_draft).slice(0, 4000) : null,
        confidence:  ['low','medium','high'].includes(a.confidence) ? a.confidence : 'medium',
      });
    }
    return { advises, summary: String(parsed.summary || '') };
  } catch (e) {
    return { advises: [], summary: '', _parseError: e.message, _raw: raw.slice(0, 500) };
  }
}

// ─── Main entry ───────────────────────────────────────────────────────────

/**
 * Generate behavioral advises by calling Claude CLI with enriched payload.
 * Writes non-duplicate advises to the `advises` table.
 *
 * @param {object} opts
 * @param {number} opts.days — lookback window (default 14)
 * @param {boolean} opts.dryRun — don't write to DB, just return parsed result
 * @returns {Promise<{ generated: number, written: number, duplicates: number, advises: Array, parseError?: string }>}
 */
export async function generateBehavioralAdvises({ days = 14, dryRun = false } = {}) {
  const payload = buildBehavioralPayload(days);

  if (payload.overview.total_sessions < 5) {
    return {
      generated: 0, written: 0, duplicates: 0, advises: [],
      note: 'Not enough session data yet.',
    };
  }

  const userPrompt = `Analyze my Claude Code usage for the last ${days} days and return behavioral advises.

DATA:
${JSON.stringify(payload, null, 2)}`;

  const fullPrompt = `${SYSTEM_PROMPT}\n\n${userPrompt}`;

  const result = spawnSync(CLAUDE_BIN, ['--print', '-'], {
    input:    fullPrompt,
    encoding: 'utf8',
    timeout:  180_000, // 3 min — behavioral analysis can take longer
  });

  if (result.status !== 0) {
    throw new Error(`Claude CLI failed (status=${result.status}): ${result.stderr?.slice(0, 500)}`);
  }

  const parsed = parseBehavioralJSON(result.stdout);
  if (parsed._parseError) {
    return {
      generated: 0, written: 0, duplicates: 0, advises: [],
      parseError: parsed._parseError,
      raw: parsed._raw,
    };
  }

  if (dryRun) {
    return {
      generated: parsed.advises.length,
      written:   0,
      duplicates: 0,
      advises: parsed.advises,
      summary: parsed.summary,
    };
  }

  // Write to DB with dedup
  const db = getDb();
  const insert = db.prepare(`
    INSERT INTO advises (category, observation, why, proposal, code_draft, confidence,
                         observation_hash, source, payload_window)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'behavioral-advisor', ?)
  `);
  const existsStmt = db.prepare(`
    SELECT id, status FROM advises
    WHERE observation_hash = ?
      AND created_at >= datetime('now', '-60 days')
  `);

  let written = 0;
  let duplicates = 0;
  const writtenAdvises = [];

  for (const a of parsed.advises) {
    const hash = observationHash(a.category, a.observation);
    const existing = existsStmt.get(hash);
    if (existing) {
      duplicates++;
      continue;
    }
    const info = insert.run(
      a.category, a.observation, a.why, a.proposal, a.code_draft, a.confidence,
      hash, `${days}d`
    );
    writtenAdvises.push({ id: info.lastInsertRowid, ...a });
    written++;
  }

  return {
    generated:  parsed.advises.length,
    written,
    duplicates,
    advises:    writtenAdvises,
    summary:    parsed.summary,
  };
}
