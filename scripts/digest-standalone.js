#!/usr/bin/env node
/**
 * digest-standalone.mjs — Standalone weekly digest generator
 *
 * Runs independently of the main claudeye CLI to avoid TCC restrictions
 * when executed from launchd. This script is copied to ~/.claudeye/
 * and accesses only ~/.claudeye/mem.db (no ~/Documents access needed).
 *
 * Fix for #65: TCC blocks launchd from reading ~/Documents.
 *
 * NOTE: Copied as .mjs to ~/.claudeye/ to work regardless of package.json type.
 */

import { createRequire } from 'module';
import { spawnSync, execFileSync, execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// Resolve claude binary the same way src/compress.js does — avoids the
// hardcoded-'claude' bug that caused #85 in the hook path. Without this,
// launchd-spawned digests can fail silently when `claude` is not on PATH.
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

// Use better-sqlite3 from ~/.claudeye/node_modules/ (avoids TCC on ~/Documents)
const _require = createRequire(join(homedir(), '.claudeye', 'package.json'));
const Database = _require('better-sqlite3');

const DATA_DIR = join(homedir(), '.claudeye');
const DB_PATH  = join(DATA_DIR, 'mem.db');

// ─── Minimal analytics (no imports from ~/Documents) ─────────────────────

function getDb() {
  return new Database(DB_PATH);
}

function buildMinimalPayload(db, days = 7) {
  const overview = db.prepare(`
    SELECT
      COUNT(DISTINCT s.id)          AS total_sessions,
      COUNT(o.id)                   AS total_observations,
      COUNT(DISTINCT s.project)     AS total_projects,
      AVG(s.friction_score)         AS avg_friction,
      AVG(s.duration_ms) / 60000.0  AS avg_session_min
    FROM sessions s
    LEFT JOIN observations o ON o.session_id = s.id
    WHERE s.started_at >= datetime('now', '-' || ? || ' days')
  `).get(days);

  const topProjects = db.prepare(`
    SELECT
      s.project,
      COUNT(DISTINCT s.id) AS sessions,
      AVG(s.friction_score) AS avg_friction
    FROM sessions s
    WHERE s.started_at >= datetime('now', '-' || ? || ' days')
      AND s.id NOT LIKE 'import-git-%'
    GROUP BY s.project
    ORDER BY sessions DESC
    LIMIT 5
  `).all(days);

  const topTags = db.prepare(`
    SELECT tags FROM observations
    WHERE created_at >= datetime('now', '-' || ? || ' days')
      AND tags IS NOT NULL
  `).all(days);

  // Parse and count tags
  const tagCounts = {};
  for (const row of topTags) {
    try {
      const tags = JSON.parse(row.tags);
      for (const t of tags) {
        tagCounts[t] = (tagCounts[t] || 0) + 1;
      }
    } catch {}
  }

  const weeklyTrend = db.prepare(`
    SELECT
      strftime('%Y-W%W', started_at) AS week,
      COUNT(*) AS sessions,
      AVG(friction_score) AS avg_friction
    FROM sessions
    WHERE started_at >= datetime('now', '-42 days')
      AND id NOT LIKE 'import-git-%'
    GROUP BY week
    ORDER BY week
  `).all();

  // File hotspots
  const hotspots = db.prepare(`
    SELECT
      CASE
        WHEN raw_input LIKE '%/%' THEN
          substr(raw_input, instr(raw_input, '/') + 1, 200)
        ELSE raw_input
      END AS file_hint,
      COUNT(*) AS occurrences,
      AVG(importance) AS avg_importance,
      project
    FROM observations
    WHERE created_at >= datetime('now', '-' || ? || ' days')
      AND raw_input IS NOT NULL
      AND tool IN ('Edit', 'Write', 'Bash')
      AND importance >= 0.5
    GROUP BY file_hint, project
    HAVING occurrences >= 3
    ORDER BY occurrences DESC
    LIMIT 10
  `).all(days);

  return {
    period_days: days,
    generated_at: new Date().toISOString(),
    overview,
    top_projects: topProjects.map(p => ({
      project: p.project?.split('/').pop() || 'unknown',
      sessions: p.sessions,
      avg_friction: +(p.avg_friction || 0).toFixed(2),
    })),
    weekly_trend: weeklyTrend,
    top_tags: Object.entries(tagCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([tag, n]) => ({ tag, n })),
    hotspots,
  };
}

// ─── Digest generation ───────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a senior developer advisor writing a weekly digest of Claude Code usage.
Give specific, data-driven recommendations. Be direct and opinionated. Reference numbers.
Structure: Key Patterns, Top Recommendations, One Big Change.
Keep under 400 words. Dense, useful.`;

async function generateDigest() {
  const db = getDb();

  // Check Monday of current week
  const now = new Date();
  const day = now.getDay();
  const monday = new Date(now);
  monday.setDate(now.getDate() - (day === 0 ? 6 : day - 1));
  const weekStart = monday.toISOString().slice(0, 10);

  // Check if already exists
  try {
    const existing = db.prepare('SELECT id FROM digests WHERE week_start = ?').get(weekStart);
    if (existing) {
      console.error(`[digest] Already exists for week ${weekStart}`);
      return null;
    }
  } catch {} // table might not exist yet

  const stats = buildMinimalPayload(db, 7);

  if (stats.overview.total_sessions === 0) {
    console.error('[digest] No sessions this week');
    return null;
  }

  console.error(`[digest] Generating for week of ${weekStart}...`);

  const userPrompt = `Analyze my Claude Code usage for the last 7 days.\n\nDATA:\n${JSON.stringify(stats, null, 2)}`;
  const fullPrompt = `${SYSTEM_PROMPT}\n\n${userPrompt}`;

  const result = spawnSync(CLAUDE_BIN, ['--print', '-'], {
    input: fullPrompt,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH || ''}` },
  });

  if (result.status !== 0) {
    console.error(`[digest] Claude CLI failed: ${result.stderr}`);
    return null;
  }

  const report = result.stdout;

  // Ensure digests table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS digests (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      week_start TEXT    NOT NULL UNIQUE,
      report     TEXT    NOT NULL,
      raw_stats  TEXT,
      created_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );
  `);

  db.prepare(`
    INSERT OR REPLACE INTO digests (week_start, report, raw_stats)
    VALUES (?, ?, ?)
  `).run(weekStart, report, JSON.stringify(stats));

  console.error(`[digest] Saved for week ${weekStart}`);
  return report;
}

// ─── Main ────────────────────────────────────────────────────────────────

try {
  await generateDigest();
} catch (e) {
  console.error(`[digest] Fatal: ${e.message}`);
  process.exit(1);
}
