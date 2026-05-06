#!/usr/bin/env node
/**
 * behavioral-standalone.mjs — Standalone Behavioral Advisor (#87 follow-up)
 *
 * Аналог digest-standalone.mjs / insights-standalone.mjs: standalone вариант
 * `claudeye advises generate` который не зависит от ~/Documents и работает
 * под launchd без TCC Full Disk Access.
 *
 * Why: launchd-spawned `claudeye advises generate` падает с EPERM на cli.js
 * (TCC блокирует чтение ~/Documents для launchd-процессов). Поведенческий
 * советчик 12 дней не запускался — последний advise 2026-04-22.
 *
 * Использование:
 *   node ~/.claudeye/behavioral-standalone.mjs               # 14 дней, пишет в DB
 *   node ~/.claudeye/behavioral-standalone.mjs --days 7
 *   node ~/.claudeye/behavioral-standalone.mjs --dry-run     # без записи
 *
 * Этот файл деплоится копированием в ~/.claudeye/ — runner вызывает оттуда.
 */

import { createRequire } from 'module';
import { spawnSync, execFileSync, execSync } from 'child_process';
import { existsSync, appendFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';

// ─── Paths ───────────────────────────────────────────────────────────────
const DATA_DIR = join(homedir(), '.claudeye');
const DB_PATH  = join(DATA_DIR, 'mem.db');
const LOG_PATH = join(DATA_DIR, 'logs', 'insights-heartbeat.log');

const _require = createRequire(join(DATA_DIR, 'package.json'));
const Database = _require('better-sqlite3');

function logLine(msg) {
  try { appendFileSync(LOG_PATH, `${new Date().toISOString()} ${msg}\n`); } catch {}
}

// ─── Resolve claude binary (same logic as digest-standalone.mjs) ─────────
function resolveClaude() {
  const home = homedir();
  const candidates = [
    process.env.CLAUDE_BIN,
    `${home}/.claude/local/claude`,
    `${home}/.local/bin/claude`,
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    '/usr/bin/claude',
    'claude',
  ].filter(Boolean);

  for (const c of candidates) {
    try {
      if (c === 'claude') {
        execSync('which claude', { stdio: 'ignore' });
        return c;
      }
      if (!existsSync(c)) continue;
      execFileSync(c, ['--version'], { stdio: 'ignore', timeout: 5000 });
      return c;
    } catch { /* try next */ }
  }
  return 'claude';
}

const CLAUDE_BIN = resolveClaude();

// ─── System prompt (mirror of src/behavioral-advisor.js) ─────────────────

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
- RESPECT dismissed history: if data.feedback.dismissed_categories contains a category, AVOID proposing the same kind of advice unless there's genuinely new evidence.
- RESPECT user preferences: if data.feedback.acceptance_stats suggests user prefers scripts over hooks (or vice versa), favor that.
- "code_draft" is optional but strongly preferred — at minimum a file path or CLI command the user can run.`;

// ─── Minimal payload (subset of buildAdvisorPayload, no ~/Documents needed) ─
function buildPayload(db, days) {
  const overview = db.prepare(`
    SELECT
      COUNT(DISTINCT s.id)         AS total_sessions,
      COUNT(o.id)                  AS total_observations,
      COUNT(DISTINCT s.project)    AS total_projects,
      AVG(s.friction_score)        AS avg_friction,
      AVG(s.duration_ms) / 60000.0 AS avg_session_min
    FROM sessions s
    LEFT JOIN observations o ON o.session_id = s.id
    WHERE s.started_at >= datetime('now', '-' || ? || ' days')
      AND s.id NOT LIKE 'import-git-%'
  `).get(days);

  const topProjects = db.prepare(`
    SELECT
      s.project,
      COUNT(DISTINCT s.id) AS sessions,
      AVG(s.friction_score) AS avg_friction,
      AVG(s.duration_ms) / 60000.0 AS avg_min
    FROM sessions s
    WHERE s.started_at >= datetime('now', '-' || ? || ' days')
      AND s.id NOT LIKE 'import-git-%'
    GROUP BY s.project
    ORDER BY sessions DESC
    LIMIT 5
  `).all(days).map(p => ({
    project: p.project?.split('/').pop() || 'unknown',
    sessions: p.sessions,
    avg_friction: +(p.avg_friction || 0).toFixed(2),
    avg_min: +(p.avg_min || 0).toFixed(1),
  }));

  const sessionLength = db.prepare(`
    SELECT
      COUNT(*)                    AS total_sessions,
      ROUND(AVG(prompt_count),1)  AS avg_prompts,
      MAX(prompt_count)           AS max_prompts,
      SUM(CASE WHEN prompt_count >= 250 THEN 1 ELSE 0 END) AS sessions_ge_250,
      SUM(CASE WHEN prompt_count >= 100 THEN 1 ELSE 0 END) AS sessions_ge_100,
      SUM(CASE WHEN prompt_count <  10  THEN 1 ELSE 0 END) AS sessions_lt_10
    FROM sessions
    WHERE started_at >= datetime('now', '-' || ? || ' days')
      AND id NOT LIKE 'import-git-%'
  `).get(days);

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

  const modelRatios = db.prepare(`
    SELECT
      model,
      COUNT(*) AS n,
      ROUND(AVG(token_input * 1.0 / NULLIF(token_output, 0)), 1) AS avg_io_ratio,
      ROUND(AVG(token_input), 0)  AS avg_tokens_in,
      ROUND(AVG(token_output), 0) AS avg_tokens_out,
      ROUND(AVG(friction_score), 3) AS avg_friction
    FROM sessions
    WHERE started_at >= datetime('now', '-' || ? || ' days')
      AND token_input IS NOT NULL
      AND model IS NOT NULL
    GROUP BY model
  `).all(days);

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

  const acceptanceStats = (() => {
    try {
      return db.prepare(`
        SELECT
          category,
          SUM(CASE WHEN status = 'accepted' OR status = 'applied' THEN 1 ELSE 0 END) AS accepted,
          SUM(CASE WHEN status = 'dismissed' THEN 1 ELSE 0 END) AS dismissed,
          COUNT(*) AS total
        FROM advises
        WHERE created_at >= datetime('now', '-90 days')
        GROUP BY category
      `).all();
    } catch { return []; }
  })();

  const dismissedCategories = (() => {
    try {
      return db.prepare(`
        SELECT category, COUNT(*) AS n
        FROM advises
        WHERE status = 'dismissed' AND dismissed_at >= datetime('now', '-30 days')
        GROUP BY category
        HAVING n >= 2
      `).all().map(r => r.category);
    } catch { return []; }
  })();

  return {
    period_days: days,
    generated_at: new Date().toISOString(),
    overview,
    top_projects: topProjects,
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
    },
  };
}

// ─── Hash + parse helpers (mirror of src/behavioral-advisor.js) ──────────
function observationHash(category, observation) {
  const normalized = String(observation)
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

// Brace-depth JSON extractor — avoids greedy /\{[\s\S]*\}/ overcapture.
// Same fix as compress.js and behavioral-advisor.js.
function extractFirstJson(text) {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function parseBehavioralJSON(raw) {
  let text = String(raw).trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const extracted = extractFirstJson(text);
  if (extracted) text = extracted;
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed.advises)) {
      return { advises: [], summary: parsed.summary || '', _parseError: 'missing advises array' };
    }
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
    return { advises: [], summary: '', _parseError: e.message, _raw: String(raw).slice(0, 500) };
  }
}

// ─── Main ────────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  let days = 14;
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--days' && args[i+1]) { days = parseInt(args[++i], 10) || 14; }
    else if (args[i] === '--dry-run') { dryRun = true; }
  }

  logLine(`[behavioral] start (days=${days}, dryRun=${dryRun})`);

  const db = new Database(DB_PATH);
  // Ensure advises table exists (idempotent — main DB already has it, this is for new installs)
  db.exec(`
    CREATE TABLE IF NOT EXISTS advises (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
      category        TEXT    NOT NULL,
      observation     TEXT    NOT NULL,
      why             TEXT    NOT NULL,
      proposal        TEXT    NOT NULL,
      code_draft      TEXT,
      confidence      TEXT    NOT NULL DEFAULT 'medium',
      status          TEXT    NOT NULL DEFAULT 'new',
      observation_hash TEXT,
      source          TEXT,
      payload_window  TEXT,
      shown_at        TEXT,
      dismissed_at    TEXT,
      dismissed_reason TEXT,
      accepted_at     TEXT,
      applied_at      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_advises_hash_status ON advises (observation_hash, status);
  `);

  const payload = buildPayload(db, days);

  if (payload.overview.total_sessions < 5) {
    logLine(`[behavioral] skip: only ${payload.overview.total_sessions} sessions in ${days}d`);
    db.close();
    return;
  }

  const userPrompt = `Analyze my Claude Code usage for the last ${days} days and return behavioral advises.

DATA:
${JSON.stringify(payload, null, 2)}`;

  const fullPrompt = `${SYSTEM_PROMPT}\n\n${userPrompt}`;

  logLine(`[behavioral] calling claude (binary=${CLAUDE_BIN}, prompt=${fullPrompt.length} chars)`);

  const result = spawnSync(CLAUDE_BIN, ['--print', '-'], {
    input: fullPrompt,
    encoding: 'utf8',
    timeout: 180_000,
    env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH || ''}` },
  });

  if (result.status !== 0) {
    logLine(`[behavioral] claude CLI failed (status=${result.status}): ${(result.stderr || '').slice(0, 500)}`);
    db.close();
    process.exit(1);
  }

  const parsed = parseBehavioralJSON(result.stdout);
  if (parsed._parseError) {
    logLine(`[behavioral] parse error: ${parsed._parseError} — raw: ${(parsed._raw || '').slice(0, 200)}`);
    db.close();
    process.exit(1);
  }

  if (dryRun) {
    console.log(JSON.stringify({
      generated: parsed.advises.length,
      written: 0,
      duplicates: 0,
      advises: parsed.advises,
      summary: parsed.summary,
    }, null, 2));
    logLine(`[behavioral] dry-run finish: ${parsed.advises.length} generated`);
    db.close();
    return;
  }

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

  let written = 0, duplicates = 0;
  for (const a of parsed.advises) {
    const hash = observationHash(a.category, a.observation);
    if (existsStmt.get(hash)) { duplicates++; continue; }
    insert.run(a.category, a.observation, a.why, a.proposal, a.code_draft, a.confidence, hash, `${days}d`);
    written++;
  }

  logLine(`[behavioral] finish: ${parsed.advises.length} generated, ${written} written, ${duplicates} dupes`);
  db.close();
}

main().catch(e => {
  logLine(`[behavioral] FATAL: ${e.message}`);
  console.error(e);
  process.exit(1);
});
