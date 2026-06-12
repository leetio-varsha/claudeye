/**
 * test/retention-heavy.test.js — Heavy-session retention & ingest dedup (#116).
 *
 * Issue: https://github.com/leetio-varsha/claudeye/issues/116
 * Covers:
 *  - pruneHeavySessions: deletes only old low-importance obs in heavy sessions;
 *    keeps decisions, importance >= 0.5, git-commit, light sessions, recent obs.
 *  - isConsecutiveDuplicate: back-to-back identical Bash/Read events detected,
 *    non-consecutive re-runs are NOT flagged.
 *  - hasDuplicateDecision: identical rationale within a session detected.
 *  - recordDbSize / db_size_log: growth math across day gaps.
 *
 * Follows the repo convention (see regression-retention.test.js): replicates
 * the SQL contracts against a raw better-sqlite3 DB instead of importing
 * db.js, which would touch ~/.claudeye and may hit native-binding issues in
 * the CI sandbox.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const TEST_DIR = join(tmpdir(), 'claudeye-retention-heavy-test-' + Date.now());
const TEST_DB  = join(TEST_DIR, 'test.db');

let db;

// ── Replicas of #116 contracts (mirror src/db.js) ───────────────────────────

function pruneHeavySessions(db, { olderThanDays = 7, obsThreshold = 300, dryRun = false } = {}) {
  const cutoff = new Date(Date.now() - olderThanDays * 86_400_000)
    .toISOString().replace('T', ' ').slice(0, 19);

  const heavySessions = db.prepare(`
    SELECT session_id FROM observations
    GROUP BY session_id HAVING COUNT(*) > ?
  `).all(obsThreshold).map(r => r.session_id);

  if (heavySessions.length === 0) return { sessions: 0, pruned: 0, dryRun };

  const placeholders = heavySessions.map(() => '?').join(',');
  const whereSql = `
    session_id IN (${placeholders})
      AND created_at < ?
      AND importance < 0.5
      AND decision_rationale IS NULL
      AND tool != 'git-commit'
  `;
  const candidates = db.prepare(`SELECT COUNT(*) AS n FROM observations WHERE ${whereSql}`)
    .get(...heavySessions, cutoff).n;

  if (dryRun || candidates === 0) return { sessions: heavySessions.length, pruned: candidates, dryRun };

  db.prepare(`DELETE FROM observations WHERE ${whereSql}`).run(...heavySessions, cutoff);
  return { sessions: heavySessions.length, pruned: candidates, dryRun: false };
}

function isConsecutiveDuplicate(db, { sessionId, tool, rawInput }) {
  if (!sessionId || !tool || !rawInput) return false;
  const last = db.prepare(`
    SELECT tool, raw_input FROM observations
    WHERE session_id = ? ORDER BY id DESC LIMIT 1
  `).get(sessionId);
  if (!last || last.tool !== tool || last.raw_input == null) return false;
  return last.raw_input === String(rawInput).slice(0, 2000);
}

function hasDuplicateDecision(db, sessionId, rationale) {
  if (!sessionId || !rationale) return false;
  return !!db.prepare(`
    SELECT 1 FROM observations
    WHERE session_id = ? AND decision_rationale = ? LIMIT 1
  `).get(sessionId, rationale);
}

function recordDbSize(db, sizeMB, day) {
  const prev = db.prepare(`
    SELECT day, size_mb FROM db_size_log WHERE day < ? ORDER BY day DESC LIMIT 1
  `).get(day);
  db.prepare(`
    INSERT INTO db_size_log (day, size_mb) VALUES (?, ?)
    ON CONFLICT(day) DO UPDATE SET size_mb = excluded.size_mb
  `).run(day, sizeMB);
  let growthMbPerDay = null, daysSpan = null;
  if (prev) {
    daysSpan = Math.max(1, Math.round((Date.parse(day) - Date.parse(prev.day)) / 86_400_000));
    growthMbPerDay = +((sizeMB - prev.size_mb) / daysSpan).toFixed(2);
  }
  return { day, sizeMB, growthMbPerDay, prevDay: prev?.day ?? null, daysSpan };
}

// ── Fixtures ────────────────────────────────────────────────────────────────

function insertObs(db, { session, tool = 'Bash', importance = 0.3, rationale = null, daysAgo = 10, rawInput = null }) {
  const createdAt = new Date(Date.now() - daysAgo * 86_400_000)
    .toISOString().replace('T', ' ').slice(0, 19);
  db.prepare(`
    INSERT INTO observations (session_id, tool, summary, importance, decision_rationale, raw_input, created_at)
    VALUES (?, ?, 'test obs', ?, ?, ?, ?)
  `).run(session, tool, importance, rationale, rawInput, createdAt);
}

before(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  db = new Database(TEST_DB);
  db.exec(`
    CREATE TABLE observations (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  TEXT NOT NULL,
      tool        TEXT NOT NULL,
      summary     TEXT NOT NULL,
      raw_input   TEXT,
      importance  REAL NOT NULL DEFAULT 0.5,
      decision_rationale TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE db_size_log (
      day        TEXT PRIMARY KEY,
      size_mb    REAL NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
});

after(() => {
  try { db.close(); rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe('#116 pruneHeavySessions', () => {
  it('prunes only old low-importance obs in heavy sessions, keeps everything else', () => {
    // Heavy session: 12 obs (threshold 10)
    for (let i = 0; i < 8; i++) insertObs(db, { session: 'heavy', importance: 0.3, daysAgo: 10 });
    insertObs(db, { session: 'heavy', importance: 0.3, daysAgo: 1 });                       // recent → keep
    insertObs(db, { session: 'heavy', importance: 0.8, daysAgo: 10 });                      // high importance → keep
    insertObs(db, { session: 'heavy', importance: 0.3, rationale: 'chose X', daysAgo: 10 }); // decision → keep
    insertObs(db, { session: 'heavy', tool: 'git-commit', importance: 0.3, daysAgo: 10 });  // git-commit → keep
    // Light session: 3 old low-importance obs → untouched
    for (let i = 0; i < 3; i++) insertObs(db, { session: 'light', importance: 0.3, daysAgo: 10 });

    const result = pruneHeavySessions(db, { olderThanDays: 7, obsThreshold: 10 });

    assert.equal(result.sessions, 1, 'only the heavy session qualifies');
    assert.equal(result.pruned, 8, 'only old low-importance non-decision obs pruned');
    assert.equal(
      db.prepare(`SELECT COUNT(*) AS n FROM observations WHERE session_id = 'heavy'`).get().n,
      4, 'recent + high-importance + decision + git-commit survive'
    );
    assert.equal(
      db.prepare(`SELECT COUNT(*) AS n FROM observations WHERE session_id = 'light'`).get().n,
      3, 'light session untouched'
    );
  });

  it('dry-run counts without deleting', () => {
    db.prepare('DELETE FROM observations').run();
    for (let i = 0; i < 12; i++) insertObs(db, { session: 'h2', importance: 0.3, daysAgo: 10 });
    const result = pruneHeavySessions(db, { olderThanDays: 7, obsThreshold: 10, dryRun: true });
    assert.equal(result.pruned, 12);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM observations').get().n, 12, 'nothing deleted');
  });

  it('returns zeros when no heavy sessions exist', () => {
    db.prepare('DELETE FROM observations').run();
    insertObs(db, { session: 's1', importance: 0.3, daysAgo: 10 });
    const result = pruneHeavySessions(db, { olderThanDays: 7, obsThreshold: 10 });
    assert.deepEqual({ sessions: result.sessions, pruned: result.pruned }, { sessions: 0, pruned: 0 });
  });
});

describe('#116 isConsecutiveDuplicate', () => {
  it('detects back-to-back identical tool+raw_input', () => {
    db.prepare('DELETE FROM observations').run();
    insertObs(db, { session: 's', tool: 'Bash', rawInput: '{"command":"npm test"}', daysAgo: 0 });
    assert.equal(isConsecutiveDuplicate(db, { sessionId: 's', tool: 'Bash', rawInput: '{"command":"npm test"}' }), true);
  });

  it('does not flag different input, different tool, or non-consecutive repeats', () => {
    assert.equal(isConsecutiveDuplicate(db, { sessionId: 's', tool: 'Bash', rawInput: '{"command":"ls"}' }), false, 'different input');
    assert.equal(isConsecutiveDuplicate(db, { sessionId: 's', tool: 'Read', rawInput: '{"command":"npm test"}' }), false, 'different tool');
    // Interleave another obs → repeat is no longer consecutive
    insertObs(db, { session: 's', tool: 'Edit', rawInput: '{"file":"a.js"}', daysAgo: 0 });
    assert.equal(isConsecutiveDuplicate(db, { sessionId: 's', tool: 'Bash', rawInput: '{"command":"npm test"}' }), false, 'non-consecutive');
  });

  it('is scoped to the session and safe on empty/missing values', () => {
    assert.equal(isConsecutiveDuplicate(db, { sessionId: 'other', tool: 'Bash', rawInput: '{"command":"npm test"}' }), false);
    assert.equal(isConsecutiveDuplicate(db, { sessionId: 's', tool: 'Bash', rawInput: null }), false);
    assert.equal(isConsecutiveDuplicate(db, { sessionId: null, tool: 'Bash', rawInput: 'x' }), false);
  });
});

describe('#116 hasDuplicateDecision', () => {
  it('detects identical rationale within a session, not across sessions', () => {
    db.prepare('DELETE FROM observations').run();
    insertObs(db, { session: 'd1', rationale: 'Chose SQLite over Postgres for zero-config', daysAgo: 0 });
    assert.equal(hasDuplicateDecision(db, 'd1', 'Chose SQLite over Postgres for zero-config'), true);
    assert.equal(hasDuplicateDecision(db, 'd1', 'A different decision'), false);
    assert.equal(hasDuplicateDecision(db, 'd2', 'Chose SQLite over Postgres for zero-config'), false, 'other session not affected');
    assert.equal(hasDuplicateDecision(db, 'd1', null), false);
  });
});

describe('#116 recordDbSize / db_size_log', () => {
  it('returns null growth on first record, computes mb/day across gaps, upserts same day', () => {
    const r1 = recordDbSize(db, 100.0, '2026-06-10');
    assert.equal(r1.growthMbPerDay, null, 'no previous day → null');

    const r2 = recordDbSize(db, 103.0, '2026-06-11');
    assert.equal(r2.growthMbPerDay, 3.0);
    assert.equal(r2.daysSpan, 1);

    // 2-day gap: (113 - 103) / 2 = 5 MB/day
    const r3 = recordDbSize(db, 113.0, '2026-06-13');
    assert.equal(r3.growthMbPerDay, 5.0);
    assert.equal(r3.daysSpan, 2);

    // Same-day re-run upserts, doesn't duplicate
    recordDbSize(db, 114.0, '2026-06-13');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM db_size_log').get().n, 3);
    assert.equal(db.prepare(`SELECT size_mb FROM db_size_log WHERE day = '2026-06-13'`).get().size_mb, 114.0);
  });
});
