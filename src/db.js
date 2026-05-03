/**
 * db.js — SQLite database with FTS5 + vector blob storage
 *
 * Schema:
 *  observations  — compressed AI summaries of tool usage events
 *  embeddings    — Float32Array blobs (1 per observation)
 *  sessions      — session metadata
 *  fts_obs       — FTS5 virtual table over observations
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync, statSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const DATA_DIR = join(homedir(), '.claudeye');
const DB_PATH  = join(DATA_DIR, 'mem.db');
export const ARCHIVE_PATH = join(DATA_DIR, 'archive.db');
export { DB_PATH, DATA_DIR };

let _db = null;

export function getDb() {
  if (_db) return _db;

  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

  _db = new Database(DB_PATH, { verbose: null });
  _db.pragma('journal_mode = WAL');
  _db.pragma('synchronous = NORMAL');
  _db.pragma('foreign_keys = ON');
  _db.pragma('busy_timeout = 5000');  // Wait up to 5s on locked DB instead of failing

  migrate(_db);
  // Run analytics schema migration (adds columns + tables for digests, issues, etc.)
  _migrateAnalytics(_db);
  return _db;
}

/**
 * Analytics schema migration — runs synchronously at DB init.
 * This is the single source of truth for analytics DDL (#58).
 */
function _migrateAnalytics(db) {
  try {
    const addColumnIfMissing = (table, column, type) => {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all();
      if (!cols.some(c => c.name === column)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      }
    };

    addColumnIfMissing('sessions', 'model',          'TEXT');
    addColumnIfMissing('sessions', 'plugins',        "TEXT DEFAULT '[]'");
    addColumnIfMissing('sessions', 'skills',         "TEXT DEFAULT '[]'");
    addColumnIfMissing('sessions', 'duration_ms',    'INTEGER');
    addColumnIfMissing('sessions', 'token_input',    'INTEGER');
    addColumnIfMissing('sessions', 'token_output',   'INTEGER');
    addColumnIfMissing('sessions', 'friction_score', 'REAL DEFAULT 0');
    addColumnIfMissing('sessions', 'outcome',        'TEXT');
    addColumnIfMissing('observations', 'retry_count', 'INTEGER DEFAULT 0');
    addColumnIfMissing('observations', 'duration_ms', 'INTEGER');
    addColumnIfMissing('observations', 'decision_rationale', 'TEXT');  // #25 Decision Memory

    db.exec(`
      CREATE TABLE IF NOT EXISTS issues (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        project       TEXT    NOT NULL,
        title         TEXT    NOT NULL,
        status        TEXT    NOT NULL DEFAULT 'open',
        opened_at     TEXT    NOT NULL DEFAULT (datetime('now')),
        resolved_at   TEXT,
        session_ids   TEXT    NOT NULL DEFAULT '[]',
        obs_ids       TEXT    NOT NULL DEFAULT '[]',
        complexity    REAL,
        resolution_ms INTEGER
      );
    `);

    // #83: track GitHub issue number for auto-created issues to dedup locally & enable sync
    addColumnIfMissing('issues', 'gh_issue_number', 'INTEGER');
    addColumnIfMissing('issues', 'gh_repo',         'TEXT');
    addColumnIfMissing('issues', 'source',          "TEXT DEFAULT 'advisor'");  // 'advisor' | 'auto-issues' | 'manual'
    addColumnIfMissing('issues', 'category',        'TEXT');

    try {
      db.exec(`CREATE INDEX IF NOT EXISTS idx_issues_gh_number ON issues(gh_issue_number)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_issues_project_status ON issues(project, status)`);
    } catch { /* non-critical */ }

    db.exec(`
      CREATE TABLE IF NOT EXISTS digests (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        week_start  TEXT    NOT NULL UNIQUE,
        report      TEXT    NOT NULL,
        raw_stats   TEXT    NOT NULL,
        created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS session_ratings (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT    NOT NULL REFERENCES sessions(id),
        rating     INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
        note       TEXT,
        created_at TEXT    NOT NULL DEFAULT (datetime('now'))
      );

      -- Effort classifications (#63)
      CREATE TABLE IF NOT EXISTS effort_classifications (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id      TEXT    NOT NULL,
        project         TEXT    NOT NULL,
        suggested_effort TEXT   NOT NULL CHECK(suggested_effort IN ('low', 'medium', 'high')),
        confidence      REAL   NOT NULL DEFAULT 0.5,
        reason          TEXT,
        prompt_word_count INTEGER,
        created_at      TEXT   NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_effort_session ON effort_classifications(session_id);
      CREATE INDEX IF NOT EXISTS idx_effort_created ON effort_classifications(created_at DESC);

      -- Error budget tracking (#31)
      CREATE TABLE IF NOT EXISTS hook_errors (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        hook       TEXT    NOT NULL,
        error_type TEXT    NOT NULL,
        message    TEXT,
        project    TEXT,
        created_at TEXT    NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_hook_errors_created ON hook_errors(created_at DESC);

      -- Injection statistics (#90) — track RAG "tax" per prompt so we can see
      -- the cost curve over time and drive a budget gate. One row per prompt
      -- for which inject-hook emitted context.
      CREATE TABLE IF NOT EXISTS injection_stats (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id    TEXT    NOT NULL,
        project       TEXT    NOT NULL,
        bytes         INTEGER NOT NULL,
        tokens_est    INTEGER NOT NULL,
        sections_json TEXT    NOT NULL DEFAULT '[]',   -- [{name, count, bytes}]
        budget_hit    INTEGER NOT NULL DEFAULT 0,      -- 1 if budget gate triggered truncation
        created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_injection_session ON injection_stats(session_id);
      CREATE INDEX IF NOT EXISTS idx_injection_created ON injection_stats(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_injection_project ON injection_stats(project);

      -- Behavioral advises (#87) — Claude-powered behavioral recommendations
      -- Distinct from 'insights' (rule-based) and 'issues' (GitHub-synced).
      -- Each row = one concrete behavioral observation with proposed automation.
      CREATE TABLE IF NOT EXISTS advises (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
        category         TEXT    NOT NULL,              -- quota|time-of-day|model|hotspot|repeat-fix|context-switch|tooling|handoff|issue-lifecycle|meta
        observation      TEXT    NOT NULL,              -- what behavior was noticed (prose, not metric)
        why              TEXT    NOT NULL,              -- why it matters — concrete impact
        proposal         TEXT    NOT NULL,              -- proposed automation / change
        code_draft       TEXT,                          -- optional: code snippet, CLI command, or file path
        confidence       TEXT    NOT NULL DEFAULT 'medium' CHECK(confidence IN ('low','medium','high')),
        status           TEXT    NOT NULL DEFAULT 'new' CHECK(status IN ('new','dismissed','accepted','applied','shown')),
        observation_hash TEXT    NOT NULL,              -- stable hash of category+observation for dedup
        source           TEXT    NOT NULL DEFAULT 'behavioral-advisor',  -- 'behavioral-advisor' | 'automation-advisor' | 'manual'
        payload_window   TEXT,                          -- '7d' | '30d' | etc
        shown_at         TEXT,                          -- last time injected into SessionStart
        dismissed_at     TEXT,
        dismissed_reason TEXT,
        accepted_at      TEXT,
        applied_at       TEXT                           -- when user actually implemented the proposal
      );
      CREATE INDEX IF NOT EXISTS idx_advises_status      ON advises(status);
      CREATE INDEX IF NOT EXISTS idx_advises_hash        ON advises(observation_hash);
      CREATE INDEX IF NOT EXISTS idx_advises_created     ON advises(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_advises_status_conf ON advises(status, confidence);

      -- Agent actions (#20) — log of all Agent v1 runs for feedback loop
      CREATE TABLE IF NOT EXISTS agent_actions (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        agent        TEXT    NOT NULL,              -- 'cross-repo-context' | 'pr-review'
        query        TEXT,                          -- user query or diff summary
        project      TEXT,                          -- project where agent ran
        result       TEXT,                          -- JSON: { results_count, top_projects, ... }
        dry_run      INTEGER NOT NULL DEFAULT 0,    -- 1 if dry-run mode
        created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_agent_actions_agent   ON agent_actions(agent);
      CREATE INDEX IF NOT EXISTS idx_agent_actions_created ON agent_actions(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_agent_actions_project ON agent_actions(project);
    `);
  } catch (err) {
    console.error('[mem:db] analytics migration failed:', err.message);
  }
}

export function migrate(db = getDb()) {
  db.exec(`
    -- Core schema version tracking
    CREATE TABLE IF NOT EXISTS schema_versions (
      version    INTEGER PRIMARY KEY,
      applied_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    -- Sessions
    CREATE TABLE IF NOT EXISTS sessions (
      id           TEXT    PRIMARY KEY,
      project      TEXT    NOT NULL,
      started_at   TEXT    NOT NULL DEFAULT (datetime('now')),
      ended_at     TEXT,
      summary      TEXT,
      prompt_count INTEGER NOT NULL DEFAULT 0
    );

    -- Observations (compressed summaries of tool events)
    CREATE TABLE IF NOT EXISTS observations (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      project     TEXT    NOT NULL,
      tool        TEXT    NOT NULL,
      summary     TEXT    NOT NULL,   -- AI-compressed summary
      raw_input   TEXT,               -- original tool input (truncated)
      raw_output  TEXT,               -- original tool output (truncated)
      tags        TEXT    NOT NULL DEFAULT '[]',  -- JSON array
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      importance  REAL    NOT NULL DEFAULT 0.5    -- 0.0–1.0, set by AI
    );

    -- Vector embeddings (Float32Array stored as BLOB, dim=1536)
    CREATE TABLE IF NOT EXISTS embeddings (
      observation_id INTEGER PRIMARY KEY REFERENCES observations(id) ON DELETE CASCADE,
      vector         BLOB    NOT NULL,
      model          TEXT    NOT NULL DEFAULT 'text-embedding-3-small',
      created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    -- FTS5 virtual table (synced via triggers)
    CREATE VIRTUAL TABLE IF NOT EXISTS fts_obs USING fts5(
      summary,
      tags,
      project UNINDEXED,
      content='observations',
      content_rowid='id',
      tokenize='porter unicode61'
    );

    -- Keep FTS in sync
    CREATE TRIGGER IF NOT EXISTS obs_ai AFTER INSERT ON observations BEGIN
      INSERT INTO fts_obs(rowid, summary, tags, project)
      VALUES (new.id, new.summary, new.tags, new.project);
    END;

    CREATE TRIGGER IF NOT EXISTS obs_au AFTER UPDATE ON observations BEGIN
      INSERT INTO fts_obs(fts_obs, rowid, summary, tags, project)
      VALUES ('delete', old.id, old.summary, old.tags, old.project);
      INSERT INTO fts_obs(rowid, summary, tags, project)
      VALUES (new.id, new.summary, new.tags, new.project);
    END;

    CREATE TRIGGER IF NOT EXISTS obs_ad AFTER DELETE ON observations BEGIN
      INSERT INTO fts_obs(fts_obs, rowid, summary, tags, project)
      VALUES ('delete', old.id, old.summary, old.tags, old.project);
    END;

    -- Indexes
    CREATE INDEX IF NOT EXISTS idx_obs_project    ON observations(project);
    CREATE INDEX IF NOT EXISTS idx_obs_session    ON observations(session_id);
    CREATE INDEX IF NOT EXISTS idx_obs_created_at ON observations(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_obs_importance ON observations(importance DESC);
  `);

  console.error('[mem:db] migrations applied');
}

// ─── Observations ────────────────────────────────────────────────────────────

export function saveObservation({ sessionId, project, tool, summary, rawInput, rawOutput, tags = [], importance = 0.5, decisionRationale = null, durationMs = null }) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO observations (session_id, project, tool, summary, raw_input, raw_output, tags, importance, decision_rationale, duration_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(sessionId, project, tool, summary,
    rawInput?.slice(0, 2000) ?? null,
    rawOutput?.slice(0, 2000) ?? null,
    JSON.stringify(tags),
    importance,
    decisionRationale,
    durationMs
  );
  return result.lastInsertRowid;
}

/**
 * Persist an embedding for an observation.
 *
 * @param {number} observationId
 * @param {Float32Array} float32Array   — vector data
 * @param {string} [model]              — embedding model name (optional).
 *                                        If omitted, DB default `text-embedding-3-small` is used,
 *                                        preserving prior behavior.
 *                                        Used for multi-provider tracking (#41).
 */
export function saveEmbedding(observationId, float32Array, model = null) {
  const db = getDb();
  const buf = Buffer.from(float32Array.buffer);
  if (model) {
    db.prepare(`
      INSERT OR REPLACE INTO embeddings (observation_id, vector, model)
      VALUES (?, ?, ?)
    `).run(observationId, buf, model);
  } else {
    db.prepare(`
      INSERT OR REPLACE INTO embeddings (observation_id, vector)
      VALUES (?, ?)
    `).run(observationId, buf);
  }
}

export function getObservationsWithEmbeddings(project = null, limit = 500) {
  const db = getDb();
  // Balanced sampling: cap git-commit observations to prevent them drowning hook data.
  // Load up to `limit` hook observations + up to 50 git-commit observations.
  const GIT_CAP = 50;
  if (project) {
    return db.prepare(`
      SELECT * FROM (
        SELECT o.id, o.summary, o.tool, o.tags, o.importance, o.decision_rationale, o.created_at, o.project, e.vector
        FROM observations o JOIN embeddings e ON e.observation_id = o.id
        WHERE o.project = ? AND o.tool != 'git-commit'
        ORDER BY o.created_at DESC LIMIT ?
      )
      UNION ALL
      SELECT * FROM (
        SELECT o.id, o.summary, o.tool, o.tags, o.importance, o.decision_rationale, o.created_at, o.project, e.vector
        FROM observations o JOIN embeddings e ON e.observation_id = o.id
        WHERE o.project = ? AND o.tool = 'git-commit'
        ORDER BY o.created_at DESC LIMIT ?
      )
    `).all(project, limit, project, GIT_CAP);
  }
  return db.prepare(`
    SELECT * FROM (
      SELECT o.id, o.summary, o.tool, o.tags, o.importance, o.decision_rationale, o.created_at, o.project, e.vector
      FROM observations o JOIN embeddings e ON e.observation_id = o.id
      WHERE o.tool != 'git-commit'
      ORDER BY o.created_at DESC LIMIT ?
    )
    UNION ALL
    SELECT * FROM (
      SELECT o.id, o.summary, o.tool, o.tags, o.importance, o.decision_rationale, o.created_at, o.project, e.vector
      FROM observations o JOIN embeddings e ON e.observation_id = o.id
      WHERE o.tool = 'git-commit'
      ORDER BY o.created_at DESC LIMIT ?
    )
  `).all(limit, GIT_CAP);
}

export function getRecentObservations(project = null, limit = 10) {
  const db = getDb();
  if (project) {
    return db.prepare(`
      SELECT id, summary, tool, tags, importance, decision_rationale, created_at, project
      FROM observations WHERE project = ?
      ORDER BY importance DESC, created_at DESC LIMIT ?
    `).all(project, limit);
  }
  return db.prepare(`
    SELECT id, summary, tool, tags, importance, decision_rationale, created_at, project
    FROM observations
    ORDER BY importance DESC, created_at DESC LIMIT ?
  `).all(limit);
}

export function ftsSearch(query, project = null, limit = 20) {
  const db = getDb();
  const safe = query.replace(/[^\w\s]/g, ' ').trim();
  if (!safe) return [];
  // Use OR to find documents matching ANY word (better recall for context injection)
  const ftsQuery = safe.split(/\s+/).filter(Boolean).join(' OR ');
  if (project) {
    return db.prepare(`
      SELECT o.id, o.summary, o.tool, o.tags, o.importance, o.decision_rationale, o.created_at, o.project,
             bm25(fts_obs) AS fts_score
      FROM fts_obs
      JOIN observations o ON o.id = fts_obs.rowid
      WHERE fts_obs MATCH ? AND o.project = ?
      ORDER BY fts_score LIMIT ?
    `).all(ftsQuery, project, limit);
  }
  return db.prepare(`
    SELECT o.id, o.summary, o.tool, o.tags, o.importance, o.decision_rationale, o.created_at, o.project,
           bm25(fts_obs) AS fts_score
    FROM fts_obs
    JOIN observations o ON o.id = fts_obs.rowid
    WHERE fts_obs MATCH ?
    ORDER BY fts_score LIMIT ?
  `).all(ftsQuery, limit);
}

// ─── Sessions ────────────────────────────────────────────────────────────────

export function upsertSession(id, project, { model = null } = {}) {
  getDb().prepare(`
    INSERT INTO sessions (id, project, model) VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET prompt_count = prompt_count + 1, model = COALESCE(?, model)
  `).run(id, project, model, model);
}

export function closeSession(id, summary, { computeFriction = null, model = null, tokenInput = null, tokenOutput = null } = {}) {
  const db = getDb();
  const frictionScore = computeFriction ? computeFriction(id) : 0;

  // Compute duration_ms from started_at → now (#81)
  // NOTE: sessions table uses started_at (not created_at — that's on observations)
  const session = db.prepare('SELECT started_at FROM sessions WHERE id = ?').get(id);
  const durationMs = session?.started_at
    ? Math.max(0, Date.now() - new Date(session.started_at.replace(' ', 'T') + 'Z').getTime())
    : null;

  db.prepare(`
    UPDATE sessions
    SET ended_at = datetime('now'),
        summary = ?,
        friction_score = ?,
        duration_ms = ?,
        model = COALESCE(?, model),
        token_input = COALESCE(?, token_input),
        token_output = COALESCE(?, token_output)
    WHERE id = ?
  `).run(summary, frictionScore, durationMs, model, tokenInput, tokenOutput, id);
}

// ─── Orphaned session cleanup (#60) ────────────────────────────────────────

/**
 * Close sessions that were never ended (Stop hook didn't fire).
 * - import-git sessions: close immediately with summary
 * - Real sessions older than maxAgeHours: close with "[auto-closed]" summary
 *
 * Called from `claudeye cleanup` and as fallback from save-hook/inject-hook.
 *
 * @param {object} opts
 * @param {number} opts.maxAgeHours — close real sessions older than this (default 4)
 * @param {boolean} opts.dryRun
 * @returns {{ importSessions: number, realSessions: number, total: number }}
 */
export function closeOrphanedSessions({ maxAgeHours = 4, dryRun = false, computeFriction = null } = {}) {
  const db = getDb();

  // Count import-git sessions that were never closed
  const importCount = db.prepare(`
    SELECT COUNT(*) as n FROM sessions
    WHERE id LIKE 'import-git-%' AND ended_at IS NULL
  `).get().n;

  // Count real sessions older than maxAgeHours
  const realCount = db.prepare(`
    SELECT COUNT(*) as n FROM sessions
    WHERE id NOT LIKE 'import-git-%'
      AND ended_at IS NULL
      AND started_at < datetime('now', '-' || ? || ' hours')
  `).get(maxAgeHours).n;

  if (dryRun) return { importSessions: importCount, realSessions: realCount, total: importCount + realCount };

  if (importCount > 0) {
    // Compute friction for each import session before closing
    if (computeFriction) {
      const ids = db.prepare(`SELECT id FROM sessions WHERE id LIKE 'import-git-%' AND ended_at IS NULL`).all();
      const stmt = db.prepare(`UPDATE sessions SET ended_at = started_at, summary = '[auto-closed] Git import session', friction_score = ? WHERE id = ?`);
      for (const { id } of ids) stmt.run(computeFriction(id), id);
    } else {
      db.prepare(`
        UPDATE sessions
        SET ended_at = started_at, summary = '[auto-closed] Git import session'
        WHERE id LIKE 'import-git-%' AND ended_at IS NULL
      `).run();
    }
  }

  if (realCount > 0) {
    if (computeFriction) {
      // Compute friction per session before closing
      const ids = db.prepare(`
        SELECT id FROM sessions
        WHERE id NOT LIKE 'import-git-%' AND ended_at IS NULL
          AND started_at < datetime('now', '-' || ? || ' hours')
      `).all(maxAgeHours);
      const stmt = db.prepare(`
        UPDATE sessions
        SET ended_at = COALESCE(
          (SELECT MAX(created_at) FROM observations WHERE session_id = ?),
          datetime(started_at, '+1 hour')
        ),
        summary = '[auto-closed] Session not ended by Stop hook',
        friction_score = ?
        WHERE id = ?
      `);
      for (const { id } of ids) stmt.run(id, computeFriction(id), id);
    } else {
      // For real sessions, set ended_at to last observation time or started_at + 1h
      db.prepare(`
        UPDATE sessions
        SET ended_at = COALESCE(
          (SELECT MAX(created_at) FROM observations WHERE session_id = sessions.id),
          datetime(started_at, '+1 hour')
        ),
        summary = '[auto-closed] Session not ended by Stop hook'
        WHERE id NOT LIKE 'import-git-%'
          AND ended_at IS NULL
          AND started_at < datetime('now', '-' || ? || ' hours')
      `).run(maxAgeHours);
    }
  }

  return { importSessions: importCount, realSessions: realCount, total: importCount + realCount };
}

// ─── Effort classifications (#63) ────────────────────────────────────────────

export function saveEffortClassification({ sessionId, project, effort, confidence, reason, promptWordCount }) {
  try {
    getDb().prepare(`
      INSERT INTO effort_classifications (session_id, project, suggested_effort, confidence, reason, prompt_word_count)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(sessionId, project, effort, confidence, reason || null, promptWordCount || null);
  } catch {
    // Non-critical — don't break the hook
  }
}

export function getEffortStats(days = 30) {
  const db = getDb();

  const distribution = db.prepare(`
    SELECT suggested_effort, COUNT(*) as count, AVG(confidence) as avg_confidence
    FROM effort_classifications
    WHERE created_at >= date('now', '-' || ? || ' days')
    GROUP BY suggested_effort
    ORDER BY count DESC
  `).all(days);

  const byProject = db.prepare(`
    SELECT
      project,
      suggested_effort,
      COUNT(*) as count
    FROM effort_classifications
    WHERE created_at >= date('now', '-' || ? || ' days')
    GROUP BY project, suggested_effort
    ORDER BY project, count DESC
  `).all(days);

  const dailyTrend = db.prepare(`
    SELECT
      date(created_at) as day,
      suggested_effort,
      COUNT(*) as count
    FROM effort_classifications
    WHERE created_at >= date('now', '-' || ? || ' days')
    GROUP BY day, suggested_effort
    ORDER BY day ASC
  `).all(days);

  const total = distribution.reduce((sum, d) => sum + d.count, 0);
  const suboptimal = distribution.filter(d => d.suggested_effort !== 'high').reduce((sum, d) => sum + d.count, 0);

  return {
    distribution,
    byProject,
    dailyTrend,
    total,
    suboptimal,
    suboptimalPercent: total > 0 ? +((suboptimal / total) * 100).toFixed(1) : 0,
  };
}

// ─── Error tracking ────────────────────────────────────────────────────────

export function logHookError(hook, errorType, message, project = null) {
  try {
    getDb().prepare(`
      INSERT INTO hook_errors (hook, error_type, message, project)
      VALUES (?, ?, ?, ?)
    `).run(hook, errorType, (message || '').slice(0, 1000), project);
  } catch {
    // If DB itself is broken, just stderr
    console.error(`[mem:error] ${new Date().toISOString()} ${hook} ${errorType}: ${message}`);
  }
}

export function getErrorStats(days = 7) {
  const db = getDb();
  return {
    byHook: db.prepare(`
      SELECT hook, error_type, COUNT(*) as count
      FROM hook_errors
      WHERE created_at >= date('now', '-' || ? || ' days')
        AND error_type != 'info'
      GROUP BY hook, error_type ORDER BY count DESC
    `).all(days),
    recent: db.prepare(`
      SELECT * FROM hook_errors ORDER BY created_at DESC LIMIT 10
    `).all(),
    total: db.prepare(`
      SELECT COUNT(*) as n FROM hook_errors WHERE created_at >= date('now', '-' || ? || ' days') AND error_type != 'info'
    `).get(days).n,
  };
}

/**
 * Health-oriented error snapshot (#89).
 * Focus on last 24h (actionable) with 7-day trend context so that stale
 * spikes from an already-fixed bug don't keep painting health red forever.
 *
 * @returns {{
 *   last24h:  number,   // errors in the last 24h
 *   last7d:   number,   // errors in the last 7 days
 *   trend:    'growing' | 'decaying' | 'flat',
 *   perDay:   Array<{ day: string, n: number }>,  // last 7 days, descending
 *   byHook:   Array<{ hook: string, error_type: string, count: number }>,  // last 24h
 * }}
 */
export function getErrorHealthSnapshot() {
  const db = getDb();
  const last24h = db.prepare(`
    SELECT COUNT(*) as n FROM hook_errors
    WHERE created_at >= datetime('now', '-1 day') AND error_type != 'info'
  `).get().n;
  const last7d = db.prepare(`
    SELECT COUNT(*) as n FROM hook_errors
    WHERE created_at >= datetime('now', '-7 days') AND error_type != 'info'
  `).get().n;
  const perDay = db.prepare(`
    SELECT substr(created_at, 1, 10) as day, COUNT(*) as n
    FROM hook_errors
    WHERE created_at >= datetime('now', '-7 days') AND error_type != 'info'
    GROUP BY day
    ORDER BY day DESC
  `).all();
  const byHook = db.prepare(`
    SELECT hook, error_type, COUNT(*) as count
    FROM hook_errors
    WHERE created_at >= datetime('now', '-1 day') AND error_type != 'info'
    GROUP BY hook, error_type ORDER BY count DESC
  `).all();

  // Trend: compare last 24h rate vs previous 6 days average
  const prev6AvgPerDay = last7d - last24h > 0 ? (last7d - last24h) / 6 : 0;
  let trend = 'flat';
  if (prev6AvgPerDay === 0 && last24h > 0)      trend = 'growing';
  else if (prev6AvgPerDay === 0 && last24h === 0) trend = 'flat';
  else if (last24h > prev6AvgPerDay * 1.5)        trend = 'growing';
  else if (last24h < prev6AvgPerDay * 0.5)        trend = 'decaying';

  return { last24h, last7d, trend, perDay, byHook };
}

// ─── Cowork noise cleanup (#93) ─────────────────────────────────────────────

/**
 * Remove Cowork-sourced observations that match the noise/dedup rules we
 * enforce at import time (#93). Run after updating the importer so already-
 * ingested sessions stop bloating the DB.
 *
 * @param {object} opts
 * @param {boolean} opts.dryRun — count rows without deleting.
 * @returns {{ noise: number, duplicates: number, total: number }}
 */
export function cleanupCoworkNoise({ dryRun = false } = {}) {
  const db = getDb();

  // 1. Noise observations that match the import-time filter.
  const noiseWhere = `
    tags LIKE '%"cowork"%'
    AND (
      (tool = 'TodoWrite' AND raw_input LIKE '%"todos":[]%')
      OR (tool IN ('mcp__computer-use__screenshot',
                   'mcp__scheduled-tasks__list_scheduled_tasks',
                   'mcp__session_info__list_sessions',
                   'mcp__computer-use__list_granted_applications')
          AND (raw_input IS NULL OR raw_input = '' OR raw_input = '{}' OR raw_input = '""'))
      OR (tool = 'CoworkUserPrompt'
          AND LOWER(TRIM(COALESCE(raw_input, ''))) IN
              ('да','нет','ок','ok','yes','no','продолжай','go','next',
               'далее','дальше','no response requested.','no response requested'))
      OR (tool = 'CoworkAssistantText' AND LENGTH(COALESCE(raw_output,'')) < 20)
    )
  `;

  const noise = db.prepare(`SELECT COUNT(*) as n FROM observations WHERE ${noiseWhere}`).get().n;

  // 2. Duplicates inside a Cowork session: same session_id + tool + raw_input,
  // keep the first occurrence (lowest id), delete the rest.
  const dupSql = `
    id IN (
      SELECT id FROM (
        SELECT id,
               ROW_NUMBER() OVER (
                 PARTITION BY session_id, tool, COALESCE(raw_input, '')
                 ORDER BY id
               ) AS rn
        FROM observations
        WHERE tags LIKE '%"cowork"%'
          AND session_id LIKE 'cowork-%'
          AND tool NOT IN ('CoworkUserPrompt', 'CoworkAssistantText')
      ) WHERE rn > 1
    )
  `;
  const duplicates = db.prepare(`SELECT COUNT(*) as n FROM observations WHERE ${dupSql}`).get().n;
  const total = noise + duplicates;

  if (dryRun || total === 0) return { noise, duplicates, total };

  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM observations WHERE ${noiseWhere}`).run();
    db.prepare(`DELETE FROM observations WHERE ${dupSql}`).run();
  });
  tx();

  return { noise, duplicates, total };
}

// ─── Injection stats (#90) ──────────────────────────────────────────────────

/**
 * Record a single inject-hook invocation. One row per prompt for which
 * inject-hook produced context (regardless of budget outcome).
 *
 * Called from the hook itself — must not throw.
 */
export function saveInjectionStat({
  sessionId,
  project,
  bytes,
  tokensEst,
  sections = [],
  budgetHit = false,
}) {
  try {
    getDb().prepare(`
      INSERT INTO injection_stats (session_id, project, bytes, tokens_est, sections_json, budget_hit)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(sessionId, project, bytes, tokensEst, JSON.stringify(sections), budgetHit ? 1 : 0);
  } catch (err) {
    // Non-critical — inject-hook must not fail because of stats.
    console.error('[mem:inject-stats] failed:', err.message);
  }
}

/**
 * Aggregated injection stats for the last N days.
 *
 * Returns:
 *   totalPrompts   — prompts that triggered context injection
 *   avgBytes       — arithmetic mean
 *   p50, p95, p99  — percentile of tokens_est (what a fresh budget should aim at)
 *   maxBytes       — largest single injection
 *   budgetHits     — prompts where the budget gate clamped context
 *   perProject     — top 10 projects by avg bytes
 *   perSection     — avg bytes per section name across all injections
 */
export function getInjectionStats({ days = 7, project = null } = {}) {
  const db = getDb();
  const params = { d: '-' + days + ' days' };
  const projFilter = project ? ' AND project = @p' : '';
  if (project) params.p = project;

  const rows = db.prepare(`
    SELECT bytes, tokens_est, sections_json, budget_hit, project
    FROM injection_stats
    WHERE created_at >= datetime('now', @d)${projFilter}
    ORDER BY tokens_est ASC
  `).all(params);

  if (!rows.length) {
    return { totalPrompts: 0, avgBytes: 0, p50: 0, p95: 0, p99: 0, maxBytes: 0,
             budgetHits: 0, perProject: [], perSection: [] };
  }

  const pct = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))];
  const tokens = rows.map(r => r.tokens_est);

  const sectionTotals = new Map();  // name → { bytesSum, occurrences }
  const projectTotals = new Map();  // project → { bytesSum, count }
  let budgetHits = 0, totalBytes = 0, maxBytes = 0;

  for (const r of rows) {
    totalBytes += r.bytes;
    maxBytes = Math.max(maxBytes, r.bytes);
    if (r.budget_hit) budgetHits++;

    const pj = projectTotals.get(r.project) || { bytesSum: 0, count: 0 };
    pj.bytesSum += r.bytes; pj.count++;
    projectTotals.set(r.project, pj);

    try {
      const sections = JSON.parse(r.sections_json || '[]');
      for (const s of sections) {
        const acc = sectionTotals.get(s.name) || { bytesSum: 0, count: 0 };
        acc.bytesSum += s.bytes || 0;
        acc.count++;
        sectionTotals.set(s.name, acc);
      }
    } catch { /* ignore malformed JSON */ }
  }

  return {
    totalPrompts: rows.length,
    avgBytes: Math.round(totalBytes / rows.length),
    p50: pct(tokens, 0.5),
    p95: pct(tokens, 0.95),
    p99: pct(tokens, 0.99),
    maxBytes,
    budgetHits,
    perProject: [...projectTotals.entries()]
      .map(([p, v]) => ({ project: p, avgBytes: Math.round(v.bytesSum / v.count), count: v.count }))
      .sort((a, b) => b.avgBytes - a.avgBytes)
      .slice(0, 10),
    perSection: [...sectionTotals.entries()]
      .map(([name, v]) => ({ name, avgBytes: Math.round(v.bytesSum / v.count), count: v.count }))
      .sort((a, b) => b.avgBytes - a.avgBytes),
  };
}

// ─── Issues tracking (#83) ──────────────────────────────────────────────────

/**
 * Persist an auto-created GitHub issue to local `issues` table.
 * Enables local dedup + stats for #16 advisor and #28 self-improvement loop.
 *
 * @param {object} opts
 * @param {string} opts.project       — project name/path
 * @param {string} opts.title         — issue title (matches GH title)
 * @param {number|null} opts.ghIssueNumber
 * @param {string|null} opts.ghRepo
 * @param {string|null} opts.category — 'hotspot' | 'friction-trend' | ...
 * @param {string[]} opts.sessionIds  — related sessions
 * @param {number[]} opts.obsIds      — related observations
 * @param {number|null} opts.complexity
 * @param {string} opts.source        — 'auto-issues' | 'advisor' | 'manual'
 * @returns {number} id of inserted row
 */
export function saveAutoIssue({
  project,
  title,
  ghIssueNumber = null,
  ghRepo = null,
  category = null,
  sessionIds = [],
  obsIds = [],
  complexity = null,
  source = 'auto-issues',
}) {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO issues (project, title, status, session_ids, obs_ids, complexity, gh_issue_number, gh_repo, source, category)
    VALUES (?, ?, 'open', ?, ?, ?, ?, ?, ?, ?)
  `).run(
    project,
    title.slice(0, 300),
    JSON.stringify(sessionIds),
    JSON.stringify(obsIds),
    complexity,
    ghIssueNumber,
    ghRepo,
    source,
    category
  );
  return result.lastInsertRowid;
}

/**
 * Check if an auto-issue with same project+title (or near-match) was opened
 * recently. Used by auto-issues.js to dedup before calling `gh`.
 *
 * @param {object} opts
 * @param {string} opts.project
 * @param {string} opts.title
 * @param {number} opts.days — lookback window (default 7)
 * @returns {{id: number, gh_issue_number: number|null, opened_at: string} | null}
 */
export function findRecentIssueByTitle({ project, title, days = 7 }) {
  const db = getDb();
  // Strip "[auto] " and everything after first colon for fuzzy match
  const core = title.toLowerCase().replace(/^\[auto\]\s*/, '').split(':')[0].trim();
  if (!core) return null;
  return db.prepare(`
    SELECT id, gh_issue_number, opened_at, title, status
    FROM issues
    WHERE project = ?
      AND opened_at >= datetime('now', '-' || ? || ' days')
      AND (LOWER(title) = ? OR LOWER(title) LIKE ?)
    ORDER BY opened_at DESC
    LIMIT 1
  `).get(project, days, title.toLowerCase(), `%${core}%`) || null;
}

/**
 * Mark auto-issue resolved based on GitHub issue number (called from sync job).
 */
export function markIssueResolvedByGhNumber(ghIssueNumber, ghRepo = null) {
  const db = getDb();
  const row = db.prepare(`
    SELECT id, opened_at FROM issues
    WHERE gh_issue_number = ? AND (gh_repo = ? OR ? IS NULL) AND status = 'open'
    LIMIT 1
  `).get(ghIssueNumber, ghRepo, ghRepo);
  if (!row) return false;
  const resolutionMs = Math.max(0, Date.now() - new Date(row.opened_at + 'Z').getTime());
  db.prepare(`
    UPDATE issues
    SET status = 'resolved', resolved_at = datetime('now'), resolution_ms = ?
    WHERE id = ?
  `).run(resolutionMs, row.id);
  return true;
}

/**
 * Stats for auto-issues — used by weekly digest (#83).
 */
export function getAutoIssueStats(days = 30) {
  const db = getDb();
  const created = db.prepare(`
    SELECT COUNT(*) as n FROM issues
    WHERE source = 'auto-issues' AND opened_at >= datetime('now', '-' || ? || ' days')
  `).get(days).n;
  const resolved = db.prepare(`
    SELECT COUNT(*) as n FROM issues
    WHERE source = 'auto-issues' AND resolved_at >= datetime('now', '-' || ? || ' days')
  `).get(days).n;
  const avgResolutionDays = db.prepare(`
    SELECT AVG(resolution_ms) as avg_ms FROM issues
    WHERE source = 'auto-issues' AND resolved_at IS NOT NULL
      AND resolved_at >= datetime('now', '-' || ? || ' days')
  `).get(days).avg_ms;
  const byCategory = db.prepare(`
    SELECT category, COUNT(*) as n FROM issues
    WHERE source = 'auto-issues' AND opened_at >= datetime('now', '-' || ? || ' days')
    GROUP BY category ORDER BY n DESC
  `).all(days);
  return {
    created,
    resolved,
    open: Math.max(0, created - resolved),
    avgResolutionDays: avgResolutionDays ? +(avgResolutionDays / (1000 * 60 * 60 * 24)).toFixed(1) : null,
    byCategory,
  };
}

// ─── Cleanup / Retention ────────────────────────────────────────────────────

/**
 * Tiered retention cleanup.
 *
 * Policy:
 *  - importance < 0.3  → keep 60 days
 *  - importance 0.3–0.7 → keep 180 days
 *  - importance >= 0.7  → keep 365 days
 *  - git-commit with importance < 0.5 → keep newest 50 per project, delete rest older than 14 days
 *
 * Embeddings cascade-delete via FK. FTS5 syncs via triggers.
 *
 * @param {object} opts
 * @param {boolean} opts.dryRun  — if true, return counts without deleting
 * @param {boolean} opts.vacuum  — if true, run VACUUM after cleanup (reclaims disk space)
 * @returns {{ lowImportance: number, medImportance: number, highImportance: number, gitCommit: number, total: number }}
 */
export function cleanup({ dryRun = false, vacuum = false } = {}) {
  const db = getDb();

  const counts = {
    lowImportance: 0,
    medImportance: 0,
    highImportance: 0,
    gitCommit: 0,
    hookErrors: 0,
    total: 0,
  };

  // hook_errors retention: delete entries older than 30 days.
  // These are diagnostic rows that pile up indefinitely and distort health checks
  // long after the underlying bug is fixed. See issue #89.
  counts.hookErrors = db.prepare(`
    SELECT COUNT(*) as n FROM hook_errors
    WHERE created_at < datetime('now', '-30 days')
  `).get().n;

  // Count candidates per tier
  counts.lowImportance = db.prepare(`
    SELECT COUNT(*) as n FROM observations
    WHERE importance < 0.3
      AND created_at < datetime('now', '-60 days')
  `).get().n;

  counts.medImportance = db.prepare(`
    SELECT COUNT(*) as n FROM observations
    WHERE importance >= 0.3 AND importance < 0.7
      AND created_at < datetime('now', '-180 days')
  `).get().n;

  counts.highImportance = db.prepare(`
    SELECT COUNT(*) as n FROM observations
    WHERE importance >= 0.7
      AND created_at < datetime('now', '-365 days')
  `).get().n;

  // Git-commit: keep newest 50 per project (matches search GIT_CAP), delete rest older than 14 days
  counts.gitCommit = db.prepare(`
    SELECT COUNT(*) as n FROM observations
    WHERE tool = 'git-commit'
      AND importance < 0.5
      AND created_at < datetime('now', '-14 days')
      AND id NOT IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (PARTITION BY project ORDER BY created_at DESC) as rn
          FROM observations WHERE tool = 'git-commit'
        ) WHERE rn <= 50
      )
  `).get().n;

  counts.total = counts.lowImportance + counts.medImportance + counts.highImportance + counts.gitCommit + counts.hookErrors;

  if (dryRun || counts.total === 0) return counts;

  // Execute deletions in a transaction
  const run = db.transaction(() => {
    db.prepare(`
      DELETE FROM observations
      WHERE importance < 0.3
        AND created_at < datetime('now', '-60 days')
    `).run();

    db.prepare(`
      DELETE FROM observations
      WHERE importance >= 0.3 AND importance < 0.7
        AND created_at < datetime('now', '-180 days')
    `).run();

    db.prepare(`
      DELETE FROM observations
      WHERE importance >= 0.7
        AND created_at < datetime('now', '-365 days')
    `).run();

    db.prepare(`
      DELETE FROM observations
      WHERE tool = 'git-commit'
        AND importance < 0.5
        AND created_at < datetime('now', '-14 days')
        AND id NOT IN (
          SELECT id FROM (
            SELECT id, ROW_NUMBER() OVER (PARTITION BY project ORDER BY created_at DESC) as rn
            FROM observations WHERE tool = 'git-commit'
          ) WHERE rn <= 50
        )
    `).run();

    // hook_errors retention (#89): diagnostic rows only useful for a rolling window.
    db.prepare(`
      DELETE FROM hook_errors WHERE created_at < datetime('now', '-30 days')
    `).run();
  });
  run();

  if (vacuum) {
    db.exec('VACUUM');
  }

  return counts;
}

/**
 * Compact: strip raw data and prune embeddings from old low-value observations.
 *
 * Main savings come from embeddings (6KB each = 64% of total DB size).
 * Observations stay searchable via FTS5 — only vector search is affected.
 *
 * Policy (#76 — aggressive thresholds to control DB growth):
 *  - git-commit embeddings beyond newest 50/project → DELETE (search caps at 50)
 *  - Low importance (<0.5) embeddings older than 7 days → DELETE
 *  - raw_input/raw_output for git-commit > 3 days → NULL
 *  - raw_input/raw_output for importance <0.5 > 7 days → NULL
 *
 * @param {object} opts
 * @param {boolean} opts.dryRun
 * @returns {{ embeddingsPruned: number, rawCompacted: number, total: number }}
 */
/**
 * Read compact-related settings from ~/.claudeye/settings.json.
 * All fields are optional — defaults used if missing or unparseable.
 *
 * @returns {{ embeddingRetentionDays: number, embeddingRetentionDaysHigh: number }}
 *   embeddingRetentionDays     — delete embeddings for importance < 0.5 older than N days (default 7)
 *   embeddingRetentionDaysHigh — delete embeddings for importance < 0.8 older than N days (default 90);
 *                                set to 0 to disable this second tier.
 */
function readCompactSettings() {
  try {
    const p = join(DATA_DIR, 'settings.json');
    if (!existsSync(p)) return {};
    const cfg = JSON.parse(readFileSync(p, 'utf8'));
    const result = {};
    const low = parseInt(cfg.embedding_retention_days ?? cfg.embeddingRetentionDays, 10);
    if (Number.isFinite(low) && low > 0) result.embeddingRetentionDays = low;
    const high = parseInt(cfg.embedding_retention_days_high ?? cfg.embeddingRetentionDaysHigh, 10);
    if (Number.isFinite(high) && high >= 0) result.embeddingRetentionDaysHigh = high;
    return result;
  } catch { return {}; }
}

export function compact({ dryRun = false } = {}) {
  const db = getDb();

  // Read configurable retention windows from ~/.claudeye/settings.json (#96)
  const cfg = readCompactSettings();
  const LOW_RETENTION_DAYS  = cfg.embeddingRetentionDays     ?? 7;   // importance < 0.5
  const HIGH_RETENTION_DAYS = cfg.embeddingRetentionDaysHigh ?? 90;  // importance < 0.8 (second tier)

  // Count embedding prune candidates
  // Git-commit: vector search caps at 50/project (GIT_CAP in getObservationsWithEmbeddings),
  // so embeddings beyond the newest 50 per project are NEVER used — safe to prune all.
  const gitEmbCount = db.prepare(`
    SELECT COUNT(*) as n FROM embeddings WHERE observation_id IN (
      SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (PARTITION BY project ORDER BY created_at DESC) as rn
        FROM observations WHERE tool = 'git-commit'
      ) WHERE rn > 50
    )
  `).get().n;

  // Tier 1: Low-importance embeddings (< 0.5) older than LOW_RETENTION_DAYS.
  // FTS5 still works for text search, only vector similarity is lost. ~6KB/embedding.
  const lowEmbCount = db.prepare(`
    SELECT COUNT(*) as n FROM embeddings e
    JOIN observations o ON o.id = e.observation_id
    WHERE o.tool != 'git-commit'
      AND o.importance < 0.5
      AND o.created_at < datetime('now', '-' || ? || ' days')
  `).get(LOW_RETENTION_DAYS).n;

  // Tier 2: Medium-importance embeddings (0.5 ≤ importance < 0.8) older than HIGH_RETENTION_DAYS.
  // For data this old, FTS + decision_rationale provide sufficient context without the vector blob.
  const highEmbCount = HIGH_RETENTION_DAYS > 0
    ? db.prepare(`
        SELECT COUNT(*) as n FROM embeddings e
        JOIN observations o ON o.id = e.observation_id
        WHERE o.tool != 'git-commit'
          AND o.importance >= 0.5 AND o.importance < 0.8
          AND o.created_at < datetime('now', '-' || ? || ' days')
      `).get(HIGH_RETENTION_DAYS).n
    : 0;

  // Count raw data compaction candidates
  const rawCount = db.prepare(`
    SELECT COUNT(*) as n FROM observations
    WHERE (
      (tool = 'git-commit' AND created_at < datetime('now', '-3 days'))
      OR (importance < 0.5 AND created_at < datetime('now', '-' || ? || ' days'))
    )
    AND (raw_input IS NOT NULL OR raw_output IS NOT NULL)
  `).get(LOW_RETENTION_DAYS).n;

  const embeddingsPruned = gitEmbCount + lowEmbCount + highEmbCount;
  const total = embeddingsPruned + rawCount;

  if (dryRun || total === 0) return {
    embeddingsPruned, embGit: gitEmbCount, embLow: lowEmbCount, embHigh: highEmbCount,
    rawCompacted: rawCount, total,
    config: { LOW_RETENTION_DAYS, HIGH_RETENTION_DAYS },
  };

  const run = db.transaction(() => {
    // Prune git-commit embeddings beyond newest 50 per project
    db.prepare(`
      DELETE FROM embeddings WHERE observation_id IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (PARTITION BY project ORDER BY created_at DESC) as rn
          FROM observations WHERE tool = 'git-commit'
        ) WHERE rn > 50
      )
    `).run();

    // Tier 1: low-importance
    db.prepare(`
      DELETE FROM embeddings WHERE observation_id IN (
        SELECT o.id FROM observations o
        WHERE o.tool != 'git-commit'
          AND o.importance < 0.5
          AND o.created_at < datetime('now', '-' || ? || ' days')
      )
    `).run(LOW_RETENTION_DAYS);

    // Tier 2: medium-importance aged out (configurable, off by default when HIGH=90)
    if (HIGH_RETENTION_DAYS > 0) {
      db.prepare(`
        DELETE FROM embeddings WHERE observation_id IN (
          SELECT o.id FROM observations o
          WHERE o.tool != 'git-commit'
            AND o.importance >= 0.5 AND o.importance < 0.8
            AND o.created_at < datetime('now', '-' || ? || ' days')
        )
      `).run(HIGH_RETENTION_DAYS);
    }

    // Strip raw data
    db.prepare(`
      UPDATE observations SET raw_input = NULL, raw_output = NULL
      WHERE (
        (tool = 'git-commit' AND created_at < datetime('now', '-3 days'))
        OR (importance < 0.5 AND created_at < datetime('now', '-' || ? || ' days'))
      )
      AND (raw_input IS NOT NULL OR raw_output IS NOT NULL)
    `).run(LOW_RETENTION_DAYS);
  });
  run();

  return {
    embeddingsPruned, embGit: gitEmbCount, embLow: lowEmbCount, embHigh: highEmbCount,
    rawCompacted: rawCount, total,
    config: { LOW_RETENTION_DAYS, HIGH_RETENTION_DAYS },
  };
}

/**
 * Returns DB size metrics for health/monitoring.
 */
export function getDbMetrics() {
  const db = getDb();

  let fileSizeMB = 0;
  try {
    fileSizeMB = +(statSync(DB_PATH).size / 1024 / 1024).toFixed(1);
  } catch { /* file may not exist */ }

  const obsCount = db.prepare('SELECT COUNT(*) as n FROM observations').get().n;
  const embCount = db.prepare('SELECT COUNT(*) as n FROM embeddings').get().n;
  const gitCommitCount = db.prepare("SELECT COUNT(*) as n FROM observations WHERE tool = 'git-commit'").get().n;

  // Embedding dimension distribution (#53)
  const embDims = db.prepare(`
    SELECT length(vector) / 4 as dims, COUNT(*) as n
    FROM embeddings
    GROUP BY dims ORDER BY n DESC
  `).all();

  // Effective coverage: high-importance (>=0.5) non-git + top 50 git/project WITH embeddings (#75)
  const searchableObs = db.prepare(`
    SELECT COUNT(*) as n FROM observations o
    WHERE (
      (o.tool != 'git-commit' AND o.importance >= 0.5)
      OR (o.tool = 'git-commit' AND o.id IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (PARTITION BY project ORDER BY created_at DESC) as rn
          FROM observations WHERE tool = 'git-commit'
        ) WHERE rn <= 50
      ))
    )
  `).get().n;
  const searchableWithEmb = db.prepare(`
    SELECT COUNT(*) as n FROM observations o
    JOIN embeddings e ON e.observation_id = o.id
    WHERE (
      (o.tool != 'git-commit' AND o.importance >= 0.5)
      OR (o.tool = 'git-commit' AND o.id IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (PARTITION BY project ORDER BY created_at DESC) as rn
          FROM observations WHERE tool = 'git-commit'
        ) WHERE rn <= 50
      ))
    )
  `).get().n;
  const effectiveCoverage = searchableObs > 0 ? +(searchableWithEmb / searchableObs * 100).toFixed(1) : 100;

  return { fileSizeMB, obsCount, embCount, gitCommitCount, embDims, effectiveCoverage, searchableObs, searchableWithEmb };
}

// ─── Auto-Cleanup (#76) ─────────────────────────────────────────────────────

/**
 * Automatic cleanup triggered from save-hook.
 * Runs compact + cleanup when DB exceeds size threshold.
 * Designed to be cheap to call — does a quick size check first.
 *
 * @param {object} opts
 * @param {number} opts.maxSizeMB  — trigger threshold (default 100MB)
 * @returns {{ ran: boolean, compact?: object, cleanup?: object, vacuumed?: boolean }}
 */
export function autoCleanup({ maxSizeMB = 100 } = {}) {
  let fileSizeMB = 0;
  try {
    fileSizeMB = +(statSync(DB_PATH).size / 1024 / 1024).toFixed(1);
  } catch { return { ran: false }; }

  if (fileSizeMB < maxSizeMB) return { ran: false };

  const compactResult = compact({});
  const cleanupResult = cleanup({ vacuum: false });

  // VACUUM if we actually freed something
  const freed = compactResult.total + cleanupResult.total;
  let vacuumed = false;
  if (freed > 0) {
    try {
      getDb().exec('VACUUM');
      vacuumed = true;
    } catch { /* non-critical */ }
  }

  return { ran: true, compact: compactResult, cleanup: cleanupResult, vacuumed };
}

// ─── Hot/Cold archive (#30) ─────────────────────────────────────────────────

/**
 * Archive old low/medium importance observations to archive.db (Étape 2 hot/cold split).
 *
 * Policy:
 *  - Observations older than `olderThanDays` with importance < `keepImportance`
 *    are moved from mem.db (hot) → archive.db (cold).
 *  - High-importance and decisions stay in hot DB regardless of age.
 *  - Embeddings are migrated alongside observations.
 *  - hot DB is VACUUMed after migration to reclaim disk space.
 *
 * @param {object} opts
 * @param {number}  opts.olderThanDays   — cutoff in days (default 14)
 * @param {number}  opts.keepImportance  — min importance to keep in hot (default 0.7)
 * @param {boolean} opts.dryRun          — count without migrating (default false)
 * @param {boolean} opts.vacuum          — VACUUM hot DB after migration (default true)
 * @returns {{ archived: number, archivePath: string, dryRun: boolean, freedMB?: number }}
 */
export function archiveObservations({
  olderThanDays  = 14,
  keepImportance = 0.7,
  dryRun         = false,
  vacuum         = true,
} = {}) {
  const db = getDb();

  // Compute cutoff timestamp in JS to avoid SQLite datetime modifier quoting issues
  const cutoff = new Date(Date.now() - olderThanDays * 86_400_000)
    .toISOString().replace('T', ' ').slice(0, 19);

  const candidateCount = db.prepare(`
    SELECT COUNT(*) as n FROM observations
    WHERE created_at < ? AND importance < ?
  `).get(cutoff, keepImportance).n;

  if (candidateCount === 0) return { archived: 0, archivePath: ARCHIVE_PATH, dryRun };
  if (dryRun) return { archived: candidateCount, archivePath: ARCHIVE_PATH, dryRun: true };

  const sizeBefore = (() => { try { return statSync(DB_PATH).size; } catch { return 0; } })();

  // Step 1: Initialize archive.db with the FULL schema by opening it as a
  // separate Database instance and running the same migrations. This avoids
  // the "N columns but M values were supplied" error that happens when the
  // hot DB has extra columns added via ALTER TABLE migrations.
  {
    const archiveDb = new Database(ARCHIVE_PATH);
    archiveDb.pragma('journal_mode = WAL');
    archiveDb.pragma('foreign_keys = ON');
    migrate(archiveDb);
    _migrateAnalytics(archiveDb);
    archiveDb.close();
  }

  // Step 2: ATTACH archive.db and move data in a single transaction.
  // Both DBs now have identical schemas, so SELECT * works safely.
  db.exec(`ATTACH DATABASE '${ARCHIVE_PATH}' AS archive`);

  try {
    const doMigrate = db.transaction(() => {
      // 1. Copy referenced sessions (ignore if already archived)
      db.prepare(`
        INSERT OR IGNORE INTO archive.sessions
        SELECT * FROM sessions WHERE id IN (
          SELECT DISTINCT session_id FROM observations
          WHERE created_at < ? AND importance < ?
        )
      `).run(cutoff, keepImportance);

      // 2. Copy embeddings
      db.prepare(`
        INSERT OR IGNORE INTO archive.embeddings
        SELECT * FROM embeddings WHERE observation_id IN (
          SELECT id FROM observations WHERE created_at < ? AND importance < ?
        )
      `).run(cutoff, keepImportance);

      // 3. Copy observations
      db.prepare(`
        INSERT OR IGNORE INTO archive.observations
        SELECT * FROM observations WHERE created_at < ? AND importance < ?
      `).run(cutoff, keepImportance);

      // 4. Delete from hot DB (FK cascade removes embeddings; FTS triggers fire)
      db.prepare(`
        DELETE FROM observations WHERE created_at < ? AND importance < ?
      `).run(cutoff, keepImportance);
    });

    doMigrate();
  } finally {
    db.exec('DETACH DATABASE archive');
  }

  let freedMB;
  if (vacuum) {
    try {
      db.exec('VACUUM');
      const sizeAfter = (() => { try { return statSync(DB_PATH).size; } catch { return 0; } })();
      freedMB = +((sizeBefore - sizeAfter) / 1024 / 1024).toFixed(1);
    } catch { /* non-critical */ }
  }

  return { archived: candidateCount, archivePath: ARCHIVE_PATH, dryRun: false, freedMB };
}

// ─── Stats ──────────────────────────────────────────────────────────────────

export function getStats() {
  const db = getDb();
  return {
    totalObservations: db.prepare('SELECT COUNT(*) as n FROM observations').get().n,
    totalSessions:     db.prepare('SELECT COUNT(*) as n FROM sessions').get().n,
    projects:          db.prepare('SELECT project, COUNT(*) as n FROM observations GROUP BY project ORDER BY n DESC').all(),
    recentActivity:    db.prepare(`
      SELECT date(created_at) as day, COUNT(*) as n
      FROM observations
      WHERE created_at >= date('now', '-30 days')
      GROUP BY day ORDER BY day DESC
    `).all(),
  };
}
