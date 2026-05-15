/**
 * test/invariants.test.js — Unit tests for invariants module (#99)
 *
 * Uses in-memory SQLite to test each invariant check in isolation.
 * Не зависит от ~/.claudeye — все данные создаются в памяти.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

// ─── Minimal DB setup (mirrors _migrateAnalytics + migrate) ─────────────────

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE sessions (
      id           TEXT PRIMARY KEY,
      project      TEXT NOT NULL,
      started_at   TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at     TEXT,
      summary      TEXT,
      prompt_count INTEGER NOT NULL DEFAULT 0,
      model        TEXT,
      duration_ms  INTEGER,
      token_input  INTEGER,
      friction_score REAL DEFAULT 0
    );
    CREATE TABLE observations (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  TEXT NOT NULL,
      project     TEXT NOT NULL,
      tool        TEXT NOT NULL,
      summary     TEXT NOT NULL,
      raw_input   TEXT,
      raw_output  TEXT,
      tags        TEXT NOT NULL DEFAULT '[]',
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      importance  REAL NOT NULL DEFAULT 0.5,
      decision_rationale TEXT
    );
    CREATE TABLE embeddings (
      observation_id INTEGER PRIMARY KEY,
      vector         BLOB NOT NULL,
      model          TEXT NOT NULL DEFAULT 'text-embedding-3-small',
      created_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE digests (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      week_start TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE insights (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      date       TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE advises (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      category         TEXT NOT NULL,
      observation      TEXT NOT NULL,
      why              TEXT NOT NULL,
      proposal         TEXT NOT NULL,
      code_draft       TEXT,
      confidence       TEXT NOT NULL DEFAULT 'medium',
      status           TEXT NOT NULL DEFAULT 'new',
      observation_hash TEXT NOT NULL,
      source           TEXT NOT NULL DEFAULT 'behavioral-advisor'
    );
    CREATE TABLE hook_errors (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      hook       TEXT NOT NULL,
      error_type TEXT NOT NULL DEFAULT 'error',
      message    TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE agent_actions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      agent      TEXT NOT NULL,
      query      TEXT,
      project    TEXT,
      result     TEXT,
      dry_run    INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE invariant_checks (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      run_date    TEXT NOT NULL,
      all_green   INTEGER NOT NULL DEFAULT 0,
      green_count INTEGER NOT NULL DEFAULT 0,
      red_count   INTEGER NOT NULL DEFAULT 0,
      violations  TEXT NOT NULL DEFAULT '[]',
      result_json TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX idx_invariant_checks_date ON invariant_checks(run_date);
    CREATE TABLE injection_stats (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      tokens_used INTEGER NOT NULL,
      bytes_used  INTEGER,
      section     TEXT,
      project     TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

// Import the module functions directly (bypasses getDb() lazy-load)
// We use dynamic import to get the raw check functions, but since they're
// not exported individually, we test via checkInvariants() with injected db.
import { checkInvariants, saveInvariantRun, getStabilityStreak } from '../src/invariants.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function addSession(db, { id = 's1', project = '/test', ended = true, model = 'claude-sonnet', duration = 1000, tokens = 100, friction = 0.5 } = {}) {
  db.prepare(`
    INSERT INTO sessions (id, project, started_at, ended_at, model, duration_ms, token_input, friction_score)
    VALUES (?, ?, datetime('now', '-1 hour'), ?, ?, ?, ?, ?)
  `).run(id, project, ended ? datetime('now') : null, model, duration, tokens, friction);
}

function datetime(expr) {
  // Simplified — return ISO string. In tests we use literal strings.
  return new Date().toISOString().slice(0, 19);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('invariants module', () => {

  describe('checkInvariants() — returns structured result', () => {
    it('returns correct shape on empty DB', async () => {
      const db = makeDb();
      const result = await checkInvariants(db);

      assert.ok(typeof result.all_green === 'boolean', 'has all_green boolean');
      assert.ok(typeof result.checked === 'number', 'has checked count');
      assert.ok(Array.isArray(result.violations), 'violations is array');
      assert.ok(Array.isArray(result.checks), 'checks is array');
      assert.ok(result.checks.length > 0, 'at least one check ran');

      for (const c of result.checks) {
        assert.ok(['green', 'red', 'skipped'].includes(c.status), `${c.id} has valid status: ${c.status}`);
        assert.ok(typeof c.id === 'string' && c.id.length > 0, `${c.id} has valid id`);
        assert.ok(typeof c.detail === 'string', `${c.id} has detail string`);
      }
    });

    it('all_green is false when violations exist', async () => {
      const db = makeDb();
      // Empty DB → many checks will be red or skipped → at least some red
      const result = await checkInvariants(db);
      // DATA-3 (embedding coverage) would be skipped on empty, but SCHED-1..3 should be red
      const redChecks = result.checks.filter(c => c.status === 'red');
      assert.ok(!result.all_green || redChecks.length === 0, 'all_green consistent with violations');
      assert.deepStrictEqual(result.violations, result.checks.filter(c => c.status === 'red').map(c => c.id));
    });
  });

  describe('SCHED-3 — digest freshness', () => {
    it('green when digest within last 7 days', async () => {
      const db = makeDb();
      db.prepare("INSERT INTO digests (week_start, created_at) VALUES (?, datetime('now', '-2 days'))").run('2026-05-05');
      const result = await checkInvariants(db);
      const sched3 = result.checks.find(c => c.id === 'SCHED-3');
      assert.strictEqual(sched3.status, 'green', 'fresh digest should be green');
    });

    it('red when digest is stale (>7 days)', async () => {
      const db = makeDb();
      db.prepare("INSERT INTO digests (week_start, created_at) VALUES (?, datetime('now', '-10 days'))").run('2026-04-28');
      const result = await checkInvariants(db);
      const sched3 = result.checks.find(c => c.id === 'SCHED-3');
      assert.strictEqual(sched3.status, 'red', 'stale digest should be red');
    });
  });

  describe('DATA-1 — git-commit ratio', () => {
    it('green when git-commit ≤10%', async () => {
      const db = makeDb();
      const sid = 's-data1';
      db.prepare("INSERT INTO sessions (id, project, ended_at) VALUES (?, '/test', datetime('now'))").run(sid);
      // 1 git-commit + 10 real obs
      db.prepare("INSERT INTO observations (session_id, project, tool, summary, created_at) VALUES (?, '/test', 'git-commit', 'commit', datetime('now'))").run(sid);
      for (let i = 0; i < 10; i++) {
        db.prepare("INSERT INTO observations (session_id, project, tool, summary, created_at) VALUES (?, '/test', 'Edit', ?, datetime('now'))").run(sid, `edit ${i}`);
      }
      const result = await checkInvariants(db);
      const data1 = result.checks.find(c => c.id === 'DATA-1');
      assert.strictEqual(data1.status, 'green', `git-commit at ~9% should be green, got: ${data1.detail}`);
    });

    it('red when git-commit >10%', async () => {
      const db = makeDb();
      const sid = 's-data1-red';
      db.prepare("INSERT INTO sessions (id, project, ended_at) VALUES (?, '/test', datetime('now'))").run(sid);
      // 5 git-commits + 3 real obs = 62.5% git
      for (let i = 0; i < 5; i++) {
        db.prepare("INSERT INTO observations (session_id, project, tool, summary, created_at) VALUES (?, '/test', 'git-commit', ?, datetime('now'))").run(sid, `commit ${i}`);
      }
      for (let i = 0; i < 3; i++) {
        db.prepare("INSERT INTO observations (session_id, project, tool, summary, created_at) VALUES (?, '/test', 'Edit', ?, datetime('now'))").run(sid, `edit ${i}`);
      }
      const result = await checkInvariants(db);
      const data1 = result.checks.find(c => c.id === 'DATA-1');
      assert.strictEqual(data1.status, 'red', `git-commit at 62% should be red, got: ${data1.detail}`);
    });
  });

  describe('INFRA-2 — hook errors', () => {
    it('green when hook errors ≤20 in last 7d', async () => {
      const db = makeDb();
      for (let i = 0; i < 5; i++) {
        db.prepare("INSERT INTO hook_errors (hook, error_type, created_at) VALUES ('save-hook', 'error', datetime('now'))").run();
      }
      const result = await checkInvariants(db);
      const infra2 = result.checks.find(c => c.id === 'INFRA-2');
      assert.strictEqual(infra2.status, 'green', `5 errors should be green, got: ${infra2.detail}`);
    });

    it('red when hook errors >20', async () => {
      const db = makeDb();
      for (let i = 0; i < 25; i++) {
        db.prepare("INSERT INTO hook_errors (hook, error_type, created_at) VALUES ('save-hook', 'error', datetime('now'))").run();
      }
      const result = await checkInvariants(db);
      const infra2 = result.checks.find(c => c.id === 'INFRA-2');
      assert.strictEqual(infra2.status, 'red', `25 errors should be red, got: ${infra2.detail}`);
    });
  });

  describe('SCHEMA-1 — all tables exist', () => {
    it('green when all required tables present', async () => {
      const db = makeDb();
      const result = await checkInvariants(db);
      const schema1 = result.checks.find(c => c.id === 'SCHEMA-1');
      assert.strictEqual(schema1.status, 'green', `all tables should be present, got: ${schema1.detail}`);
    });
  });

  describe('TRACK-3 — decision rationale', () => {
    it('green when at least one decision this week', async () => {
      const db = makeDb();
      const sid = 's-track3';
      db.prepare("INSERT INTO sessions (id, project, ended_at) VALUES (?, '/test', datetime('now'))").run(sid);
      db.prepare("INSERT INTO observations (session_id, project, tool, summary, decision_rationale, created_at) VALUES (?, '/test', 'Edit', 'summary', 'chose SQLite over Postgres', datetime('now'))").run(sid);
      const result = await checkInvariants(db);
      const track3 = result.checks.find(c => c.id === 'TRACK-3');
      assert.strictEqual(track3.status, 'green', `decision present should be green, got: ${track3.detail}`);
    });

    it('red when no decisions this week', async () => {
      const db = makeDb();
      const result = await checkInvariants(db);
      const track3 = result.checks.find(c => c.id === 'TRACK-3');
      assert.strictEqual(track3.status, 'red', 'no decisions should be red');
    });
  });

});

describe('saveInvariantRun + getStabilityStreak', () => {
  it('streak=0 on empty table', () => {
    const db = makeDb();
    const streak = getStabilityStreak(db);
    assert.strictEqual(streak.streak, 0);
    assert.strictEqual(streak.lastRunDate, null);
    assert.strictEqual(streak.mvpGate, false);
  });

  it('streak=1 after one all-green run', async () => {
    const db = makeDb();
    db.prepare(`
      INSERT INTO invariant_checks (run_date, all_green, green_count, red_count, violations)
      VALUES (date('now'), 1, 10, 0, '[]')
    `).run();
    const streak = getStabilityStreak(db);
    assert.strictEqual(streak.streak, 1);
  });

  it('streak breaks on red day', () => {
    const db = makeDb();
    // 3 consecutive green, then 1 red
    db.prepare("INSERT INTO invariant_checks (run_date, all_green, green_count, red_count, violations) VALUES (date('now', '-3 days'), 1, 10, 0, '[]')").run();
    db.prepare("INSERT INTO invariant_checks (run_date, all_green, green_count, red_count, violations) VALUES (date('now', '-2 days'), 1, 10, 0, '[]')").run();
    db.prepare("INSERT INTO invariant_checks (run_date, all_green, green_count, red_count, violations) VALUES (date('now', '-1 days'), 0, 8, 2, '[\"SCHED-1\",\"DATA-3\"]')").run();
    db.prepare("INSERT INTO invariant_checks (run_date, all_green, green_count, red_count, violations) VALUES (date('now'), 1, 10, 0, '[]')").run();
    const streak = getStabilityStreak(db);
    // Only today is green (yesterday was red)
    assert.strictEqual(streak.streak, 1, 'streak should be 1 because yesterday was red');
  });

  it('mvpGate true after 14 consecutive green days', () => {
    const db = makeDb();
    for (let i = 13; i >= 0; i--) {
      db.prepare(`
        INSERT INTO invariant_checks (run_date, all_green, green_count, red_count, violations)
        VALUES (date('now', '-${i} days'), 1, 10, 0, '[]')
      `).run();
    }
    const streak = getStabilityStreak(db);
    assert.strictEqual(streak.streak, 14);
    assert.strictEqual(streak.mvpGate, true);
  });
});
