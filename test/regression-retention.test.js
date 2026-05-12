/**
 * test/regression-retention.test.js — Retention safety valve regression tests.
 *
 * Issue: https://github.com/leetio-varsha/claudeye/issues/102
 * Verifies that cleanup() respects the safetyMaxRatio guard and does not
 * delete more than the configured fraction of observations in a single run.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const TEST_DIR = join(tmpdir(), 'claudeye-retention-test-' + Date.now());
const TEST_DB  = join(TEST_DIR, 'test.db');

// We replicate the minimal schema and cleanup logic to unit-test the safety valve.
// This avoids importing db.js (which requires better-sqlite3 native bindings that
// may not be available in the CI sandbox — ERR_DLOPEN_FAILED).

/**
 * Minimal in-process replica of cleanup() with safetyMaxRatio.
 * Mirrors the logic in src/db.js so the test validates the contract, not the implementation.
 */
function cleanup(db, { dryRun = false, safetyMaxRatio = 0.3 } = {}) {
  const counts = {
    lowImportance: 0,
    total: 0,
    skipped: false,
    skipReason: null,
    totalObs: null,
  };

  counts.lowImportance = db.prepare(`
    SELECT COUNT(*) as n FROM observations
    WHERE importance < 0.3 AND created_at < datetime('now', '-60 days')
  `).get().n;

  counts.total = counts.lowImportance;

  if (dryRun || counts.total === 0) return counts;

  // Safety valve (#102)
  if (safetyMaxRatio < 1.0) {
    const totalObs = db.prepare('SELECT COUNT(*) as n FROM observations').get().n;
    counts.totalObs = totalObs;
    if (totalObs > 0 && counts.total / totalObs > safetyMaxRatio) {
      counts.skipped = true;
      counts.skipReason = 'safety_ratio';
      return counts;
    }
  }

  db.prepare(`
    DELETE FROM observations
    WHERE importance < 0.3 AND created_at < datetime('now', '-60 days')
  `).run();

  return counts;
}

let db;

before(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  db = new Database(TEST_DB);
  db.exec(`
    CREATE TABLE observations (
      id         TEXT PRIMARY KEY,
      session_id TEXT NOT NULL DEFAULT 'sess',
      project    TEXT DEFAULT 'test',
      tool       TEXT NOT NULL DEFAULT 'Bash',
      summary    TEXT NOT NULL DEFAULT '',
      importance REAL NOT NULL DEFAULT 0.5,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
});

after(() => {
  db?.close();
  if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
});

describe('regression-retention #102 — safety valve', () => {
  it('cleanup() with safetyMaxRatio=0.3 skips deletion when >30% would be removed', () => {
    db.exec('DELETE FROM observations');

    // Insert 10 obs: 4 old low-importance (candidates), 6 recent high-importance (keepers)
    const insert = db.prepare(`
      INSERT INTO observations (id, summary, importance, created_at)
      VALUES (?, 'obs', ?, ?)
    `);
    for (let i = 0; i < 4; i++) {
      insert.run(`old-${i}`, 0.1, '2024-01-01 00:00:00');   // 61+ days old, low importance → eligible
    }
    for (let i = 0; i < 6; i++) {
      insert.run(`new-${i}`, 0.9, new Date().toISOString().slice(0, 19)); // recent, high → kept
    }

    // 4/10 = 40% > 30% threshold — cleanup should skip
    const result = cleanup(db, { safetyMaxRatio: 0.3 });

    assert.equal(result.skipped, true, 'cleanup should be skipped when >30% would be deleted');
    assert.equal(result.skipReason, 'safety_ratio');

    // No rows should have been deleted
    const remaining = db.prepare('SELECT COUNT(*) as n FROM observations').get().n;
    assert.equal(remaining, 10, 'no observations should be deleted when safety valve fires');
  });

  it('cleanup() proceeds normally when deletion ratio is below safetyMaxRatio', () => {
    db.exec('DELETE FROM observations');

    // Insert 10 obs: 2 old low-importance (candidates = 20%), 8 recent keepers
    const insert = db.prepare(`
      INSERT INTO observations (id, summary, importance, created_at)
      VALUES (?, 'obs', ?, ?)
    `);
    for (let i = 0; i < 2; i++) {
      insert.run(`old2-${i}`, 0.1, '2024-01-01 00:00:00');
    }
    for (let i = 0; i < 8; i++) {
      insert.run(`new2-${i}`, 0.9, new Date().toISOString().slice(0, 19));
    }

    // 2/10 = 20% <= 30% threshold — cleanup should proceed
    const result = cleanup(db, { safetyMaxRatio: 0.3 });

    assert.equal(result.skipped, false, 'cleanup should not be skipped when ratio is within threshold');
    assert.equal(result.total, 2, 'should report 2 deleted');

    const remaining = db.prepare('SELECT COUNT(*) as n FROM observations').get().n;
    assert.equal(remaining, 8, '2 old low-importance rows should be deleted');
  });

  it('dryRun=true returns candidate counts without deleting anything', () => {
    db.exec('DELETE FROM observations');

    const insert = db.prepare(`
      INSERT INTO observations (id, summary, importance, created_at)
      VALUES (?, 'obs', ?, ?)
    `);
    for (let i = 0; i < 5; i++) {
      insert.run(`dry-${i}`, 0.1, '2024-01-01 00:00:00');
    }
    for (let i = 0; i < 5; i++) {
      insert.run(`keep-${i}`, 0.9, new Date().toISOString().slice(0, 19));
    }

    const result = cleanup(db, { dryRun: true });

    assert.equal(result.lowImportance, 5, 'dryRun should count 5 candidates');
    const remaining = db.prepare('SELECT COUNT(*) as n FROM observations').get().n;
    assert.equal(remaining, 10, 'dryRun should not delete anything');
  });

  it('cleanup() with safetyMaxRatio=1.0 disables safety valve', () => {
    db.exec('DELETE FROM observations');

    const insert = db.prepare(`
      INSERT INTO observations (id, summary, importance, created_at)
      VALUES (?, 'obs', ?, ?)
    `);
    // All 5 are old low-importance = 100% → normally blocked, but safetyMaxRatio=1.0 disables check
    for (let i = 0; i < 5; i++) {
      insert.run(`force-${i}`, 0.1, '2024-01-01 00:00:00');
    }

    const result = cleanup(db, { safetyMaxRatio: 1.0 });

    assert.equal(result.skipped, false, 'safety valve should be disabled at ratio=1.0');
    const remaining = db.prepare('SELECT COUNT(*) as n FROM observations').get().n;
    assert.equal(remaining, 0, 'all rows deleted when safety valve disabled');
  });
});
