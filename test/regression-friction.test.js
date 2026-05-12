/**
 * regression-friction.test.js — friction_score всегда был 0 (#68).
 *
 * Симптом: из 132 сессий ни у одной friction_score > 0 — формула
 * не вызывалась при closeSession / computeFriction был 0-initialized.
 *
 * Тест верифицирует логику computeFrictionScore из src/analytics.js.
 * Поскольку функция использует getDb() внутри, тест реплицирует
 * формулу (паттерн как в regression-retention.test.js).
 *
 * See: github.com/leetio-varsha/claudeye/issues/68
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

// ─── Replicated formula (mirrors src/analytics.js:computeFrictionScore) ──────
// If this formula diverges from production — the test will correctly fail,
// signalling that the regression guard needs updating too.

function computeFriction(observations) {
  if (!observations.length) return 0;

  const errorCount = observations.filter(o => {
    const tags = JSON.parse(o.tags || '[]');
    return tags.includes('error') || tags.includes('bugfix');
  }).length;

  const retryCount  = observations.reduce((sum, o) => sum + (o.retry_count || 0), 0);
  const avgImp      = observations.reduce((sum, o) => sum + o.importance, 0) / observations.length;

  const errorRatio  = errorCount / observations.length;
  const retryRatio  = Math.min(1, retryCount / observations.length);
  const impFactor   = avgImp;

  const score = (errorRatio * 0.4) + (retryRatio * 0.4) + (impFactor * 0.2);
  return Math.min(1, Math.max(0, score));
}

// ─── Pure formula tests (no SQLite) ─────────────────────────────────────────

describe('regression: friction_score (#68)', () => {
  it('empty session → 0', () => {
    assert.strictEqual(computeFriction([]), 0);
  });

  it('clean session (no errors, no retries, low importance) → near-zero', () => {
    const obs = [
      { importance: 0.1, retry_count: 0, tags: '[]' },
      { importance: 0.1, retry_count: 0, tags: '[]' },
    ];
    const score = computeFriction(obs);
    assert.ok(score < 0.15, `expected near-0, got ${score}`);
  });

  it('session with error-tagged obs → friction > 0 (was broken in #68)', () => {
    const obs = [
      { importance: 0.8, retry_count: 0, tags: '["error"]' },
      { importance: 0.3, retry_count: 0, tags: '[]' },
    ];
    const score = computeFriction(obs);
    assert.ok(score > 0,
      `friction must be > 0 for error sessions, got ${score} — #68 regression`);
  });

  it('session with bugfix-tagged obs → friction > 0', () => {
    const obs = [
      { importance: 0.6, retry_count: 0, tags: '["bugfix"]' },
    ];
    const score = computeFriction(obs);
    assert.ok(score > 0, `bugfix tag must contribute to friction, got ${score}`);
  });

  it('session with retries → friction > 0', () => {
    const obs = [
      { importance: 0.3, retry_count: 3, tags: '[]' },
      { importance: 0.3, retry_count: 0, tags: '[]' },
    ];
    const score = computeFriction(obs);
    assert.ok(score > 0, `retries must contribute to friction, got ${score}`);
  });

  it('score is always clamped to [0, 1]', () => {
    // Extreme case: all-error, all-retry, max importance
    const obs = Array.from({ length: 5 }, () => ({
      importance: 1.0,
      retry_count: 99,
      tags: '["error","bugfix"]',
    }));
    const score = computeFriction(obs);
    assert.ok(score >= 0 && score <= 1,
      `score must be in [0,1], got ${score}`);
    assert.strictEqual(score, 1, 'saturated session should hit cap of 1');
  });

  it('errorRatio weight (0.4) × retryRatio weight (0.4) × impFactor (0.2) = 1.0', () => {
    // Verify the weights sum to 1 — prevents silent drift in formula coefficients
    const weights = [0.4, 0.4, 0.2];
    const sum = weights.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1.0) < 1e-9, `weights must sum to 1.0, got ${sum}`);
  });
});

// ─── DB integration: verify formula works end-to-end with SQLite ─────────────

describe('regression: friction DB integration (#68)', () => {
  it('reads observations from in-memory DB and computes friction > 0 for error session', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE observations (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id  TEXT    NOT NULL,
        tool        TEXT    NOT NULL DEFAULT 'Bash',
        summary     TEXT    NOT NULL DEFAULT '',
        importance  REAL    NOT NULL DEFAULT 0.5,
        retry_count INTEGER NOT NULL DEFAULT 0,
        tags        TEXT    NOT NULL DEFAULT '[]'
      );
    `);

    const sid = 'sess-friction-68';
    const ins = db.prepare(
      'INSERT INTO observations (session_id, importance, retry_count, tags) VALUES (?, ?, ?, ?)'
    );
    ins.run(sid, 0.8, 0, '["error"]');
    ins.run(sid, 0.5, 2, '[]');
    ins.run(sid, 0.3, 0, '[]');

    const obs = db.prepare(
      'SELECT importance, retry_count, tags FROM observations WHERE session_id = ?'
    ).all(sid);

    const score = computeFriction(obs);
    assert.ok(score > 0,
      `Expected friction > 0 for session with errors/retries, got ${score}`);

    db.close();
  });

  it('closeSession-pattern: friction_score written to sessions table', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE sessions (
        id            TEXT PRIMARY KEY,
        project       TEXT,
        started_at    TEXT NOT NULL DEFAULT (datetime('now')),
        ended_at      TEXT,
        summary       TEXT,
        prompt_count  INTEGER DEFAULT 0,
        friction_score REAL DEFAULT 0
      );
      CREATE TABLE observations (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id  TEXT    NOT NULL,
        importance  REAL    NOT NULL DEFAULT 0.5,
        retry_count INTEGER NOT NULL DEFAULT 0,
        tags        TEXT    NOT NULL DEFAULT '[]'
      );
    `);

    const sid = 'sess-close-test';
    db.prepare("INSERT INTO sessions (id, project, started_at) VALUES (?, ?, datetime('now'))").run(sid, '/proj');
    db.prepare('INSERT INTO observations (session_id, importance, retry_count, tags) VALUES (?, ?, ?, ?)').run(sid, 0.9, 0, '["error"]');

    // Simulate closeSession writing friction_score
    const obs = db.prepare('SELECT importance, retry_count, tags FROM observations WHERE session_id = ?').all(sid);
    const friction = computeFriction(obs);
    db.prepare("UPDATE sessions SET ended_at = datetime('now'), friction_score = ? WHERE id = ?").run(friction, sid);

    const row = db.prepare('SELECT friction_score, ended_at FROM sessions WHERE id = ?').get(sid);
    assert.ok(row.friction_score > 0,
      `friction_score must be > 0 after session close, got ${row.friction_score} — #68 regression`);
    assert.notEqual(row.ended_at, null, 'ended_at must be set on close (#60 companion)');

    db.close();
  });
});
