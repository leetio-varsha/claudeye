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
import { existsSync, mkdirSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const DATA_DIR = join(homedir(), '.claudeye');
const DB_PATH  = join(DATA_DIR, 'mem.db');

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
 * Lazy-import migrateAnalytics to avoid circular deps.
 * Falls back silently if analytics.js isn't available (e.g. minimal install).
 */
function _migrateAnalytics(db) {
  try {
    // Inline the analytics migration here to avoid async import issues.
    // This mirrors analytics.js migrateAnalytics() but runs synchronously at DB init.
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

export function saveObservation({ sessionId, project, tool, summary, rawInput, rawOutput, tags = [], importance = 0.5 }) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO observations (session_id, project, tool, summary, raw_input, raw_output, tags, importance)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(sessionId, project, tool, summary,
    rawInput?.slice(0, 2000) ?? null,
    rawOutput?.slice(0, 2000) ?? null,
    JSON.stringify(tags),
    importance
  );
  return result.lastInsertRowid;
}

export function saveEmbedding(observationId, float32Array) {
  const db = getDb();
  const buf = Buffer.from(float32Array.buffer);
  db.prepare(`
    INSERT OR REPLACE INTO embeddings (observation_id, vector)
    VALUES (?, ?)
  `).run(observationId, buf);
}

export function getObservationsWithEmbeddings(project = null, limit = 500) {
  const db = getDb();
  // Balanced sampling: cap git-commit observations to prevent them drowning hook data.
  // Load up to `limit` hook observations + up to 50 git-commit observations.
  const GIT_CAP = 50;
  if (project) {
    return db.prepare(`
      SELECT * FROM (
        SELECT o.id, o.summary, o.tool, o.tags, o.importance, o.created_at, o.project, e.vector
        FROM observations o JOIN embeddings e ON e.observation_id = o.id
        WHERE o.project = ? AND o.tool != 'git-commit'
        ORDER BY o.created_at DESC LIMIT ?
      )
      UNION ALL
      SELECT * FROM (
        SELECT o.id, o.summary, o.tool, o.tags, o.importance, o.created_at, o.project, e.vector
        FROM observations o JOIN embeddings e ON e.observation_id = o.id
        WHERE o.project = ? AND o.tool = 'git-commit'
        ORDER BY o.created_at DESC LIMIT ?
      )
    `).all(project, limit, project, GIT_CAP);
  }
  return db.prepare(`
    SELECT * FROM (
      SELECT o.id, o.summary, o.tool, o.tags, o.importance, o.created_at, o.project, e.vector
      FROM observations o JOIN embeddings e ON e.observation_id = o.id
      WHERE o.tool != 'git-commit'
      ORDER BY o.created_at DESC LIMIT ?
    )
    UNION ALL
    SELECT * FROM (
      SELECT o.id, o.summary, o.tool, o.tags, o.importance, o.created_at, o.project, e.vector
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
      SELECT id, summary, tool, tags, importance, created_at, project
      FROM observations WHERE project = ?
      ORDER BY importance DESC, created_at DESC LIMIT ?
    `).all(project, limit);
  }
  return db.prepare(`
    SELECT id, summary, tool, tags, importance, created_at, project
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
      SELECT o.id, o.summary, o.tool, o.tags, o.importance, o.created_at, o.project,
             bm25(fts_obs) AS fts_score
      FROM fts_obs
      JOIN observations o ON o.id = fts_obs.rowid
      WHERE fts_obs MATCH ? AND o.project = ?
      ORDER BY fts_score LIMIT ?
    `).all(ftsQuery, project, limit);
  }
  return db.prepare(`
    SELECT o.id, o.summary, o.tool, o.tags, o.importance, o.created_at, o.project,
           bm25(fts_obs) AS fts_score
    FROM fts_obs
    JOIN observations o ON o.id = fts_obs.rowid
    WHERE fts_obs MATCH ?
    ORDER BY fts_score LIMIT ?
  `).all(ftsQuery, limit);
}

// ─── Sessions ────────────────────────────────────────────────────────────────

export function upsertSession(id, project) {
  getDb().prepare(`
    INSERT INTO sessions (id, project) VALUES (?, ?)
    ON CONFLICT(id) DO UPDATE SET prompt_count = prompt_count + 1
  `).run(id, project);
}

export function closeSession(id, summary) {
  getDb().prepare(`
    UPDATE sessions SET ended_at = datetime('now'), summary = ? WHERE id = ?
  `).run(summary, id);
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
      FROM hook_errors WHERE created_at >= date('now', '-' || ? || ' days')
      GROUP BY hook, error_type ORDER BY count DESC
    `).all(days),
    recent: db.prepare(`
      SELECT * FROM hook_errors ORDER BY created_at DESC LIMIT 10
    `).all(),
    total: db.prepare(`
      SELECT COUNT(*) as n FROM hook_errors WHERE created_at >= date('now', '-' || ? || ' days')
    `).get(days).n,
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
 *  - git-commit with importance < 0.5 → keep newest 200 per project, delete rest older than 30 days
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
    total: 0,
  };

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

  // Git-commit: keep newest 200 per project, delete rest older than 30 days
  counts.gitCommit = db.prepare(`
    SELECT COUNT(*) as n FROM observations
    WHERE tool = 'git-commit'
      AND importance < 0.5
      AND created_at < datetime('now', '-30 days')
      AND id NOT IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (PARTITION BY project ORDER BY created_at DESC) as rn
          FROM observations WHERE tool = 'git-commit'
        ) WHERE rn <= 200
      )
  `).get().n;

  counts.total = counts.lowImportance + counts.medImportance + counts.highImportance + counts.gitCommit;

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
        AND created_at < datetime('now', '-30 days')
        AND id NOT IN (
          SELECT id FROM (
            SELECT id, ROW_NUMBER() OVER (PARTITION BY project ORDER BY created_at DESC) as rn
            FROM observations WHERE tool = 'git-commit'
          ) WHERE rn <= 200
        )
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
 * Policy:
 *  - git-commit embeddings older than 7 days, importance < 0.5 → DELETE embedding
 *    (vector search already caps git-commit at 50 newest, so old ones are never hit)
 *  - Low importance (<0.5) embeddings older than 30 days → DELETE embedding
 *  - raw_input/raw_output for git-commit >7 days → NULL
 *  - raw_input/raw_output for importance <0.5 >14 days → NULL
 *
 * @param {object} opts
 * @param {boolean} opts.dryRun
 * @returns {{ embeddingsPruned: number, rawCompacted: number, total: number }}
 */
export function compact({ dryRun = false } = {}) {
  const db = getDb();

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

  const lowEmbCount = db.prepare(`
    SELECT COUNT(*) as n FROM embeddings e
    JOIN observations o ON o.id = e.observation_id
    WHERE o.tool != 'git-commit'
      AND o.importance < 0.5
      AND o.created_at < datetime('now', '-30 days')
  `).get().n;

  // Count raw data compaction candidates
  const rawCount = db.prepare(`
    SELECT COUNT(*) as n FROM observations
    WHERE (
      (tool = 'git-commit' AND created_at < datetime('now', '-7 days'))
      OR (importance < 0.5 AND created_at < datetime('now', '-14 days'))
    )
    AND (raw_input IS NOT NULL OR raw_output IS NOT NULL)
  `).get().n;

  const embeddingsPruned = gitEmbCount + lowEmbCount;
  const total = embeddingsPruned + rawCount;

  if (dryRun || total === 0) return { embeddingsPruned, embGit: gitEmbCount, embLow: lowEmbCount, rawCompacted: rawCount, total };

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

    db.prepare(`
      DELETE FROM embeddings WHERE observation_id IN (
        SELECT o.id FROM observations o
        WHERE o.tool != 'git-commit'
          AND o.importance < 0.5
          AND o.created_at < datetime('now', '-30 days')
      )
    `).run();

    // Strip raw data
    db.prepare(`
      UPDATE observations SET raw_input = NULL, raw_output = NULL
      WHERE (
        (tool = 'git-commit' AND created_at < datetime('now', '-7 days'))
        OR (importance < 0.5 AND created_at < datetime('now', '-14 days'))
      )
      AND (raw_input IS NOT NULL OR raw_output IS NOT NULL)
    `).run();
  });
  run();

  return { embeddingsPruned, embGit: gitEmbCount, embLow: lowEmbCount, rawCompacted: rawCount, total };
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

  return { fileSizeMB, obsCount, embCount, gitCommitCount };
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
