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
import { existsSync, mkdirSync } from 'fs';
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

  migrate(_db);
  return _db;
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
  if (project) {
    return db.prepare(`
      SELECT o.id, o.summary, o.tags, o.importance, o.created_at, o.project, e.vector
      FROM observations o JOIN embeddings e ON e.observation_id = o.id
      WHERE o.project = ? ORDER BY o.created_at DESC LIMIT ?
    `).all(project, limit);
  }
  return db.prepare(`
    SELECT o.id, o.summary, o.tags, o.importance, o.created_at, o.project, e.vector
    FROM observations o JOIN embeddings e ON e.observation_id = o.id
    ORDER BY o.created_at DESC LIMIT ?
  `).all(limit);
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
      SELECT o.id, o.summary, o.tags, o.importance, o.created_at, o.project,
             bm25(fts_obs) AS fts_score
      FROM fts_obs
      JOIN observations o ON o.id = fts_obs.rowid
      WHERE fts_obs MATCH ? AND o.project = ?
      ORDER BY fts_score LIMIT ?
    `).all(ftsQuery, project, limit);
  }
  return db.prepare(`
    SELECT o.id, o.summary, o.tags, o.importance, o.created_at, o.project,
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
