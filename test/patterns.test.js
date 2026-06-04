/**
 * test/patterns.test.js — Pattern detection tests
 *
 * Tests pattern detection functions against a test database
 * with known data to verify correct identification of:
 * - Repeat fixes
 * - File hotspots
 * - Time sinks
 * - Cross-session patterns
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// We can't easily mock getDb(), so we test the SQL logic directly
const TEST_DIR = join(tmpdir(), 'claudeye-patterns-test-' + Date.now());
const TEST_DB  = join(TEST_DIR, 'test.db');
let db;

before(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  db = new Database(TEST_DB);

  db.exec(`
    CREATE TABLE observations (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, project TEXT,
      tool TEXT NOT NULL, summary TEXT NOT NULL, importance REAL DEFAULT 0.5,
      tags TEXT DEFAULT '[]', raw_input TEXT, raw_output TEXT,
      retry_count INTEGER DEFAULT 0, decision_rationale TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, project TEXT NOT NULL,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at TEXT, summary TEXT, prompt_count INTEGER DEFAULT 0,
      duration_ms INTEGER, friction_score REAL DEFAULT 0
    );
  `);

  // Seed: project with repeat fixes on same file
  const insertObs = db.prepare(`
    INSERT INTO observations (id, session_id, project, tool, summary, importance, tags, raw_input, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now', ?))
  `);
  const insertSess = db.prepare(`
    INSERT INTO sessions (id, project, started_at, ended_at, friction_score, duration_ms, prompt_count)
    VALUES (?, ?, datetime('now', ?), datetime('now', ?), ?, ?, ?)
  `);

  // 3 sessions over 5 days for project A
  insertSess.run('s1', '/test/projectA', '-5 days', '-5 days', 0.3, 3600000, 50);
  insertSess.run('s2', '/test/projectA', '-3 days', '-3 days', 0.4, 7200000, 100);
  insertSess.run('s3', '/test/projectA', '-1 days', '-1 days', 0.2, 1800000, 30);

  // 2 sessions for project B (low friction)
  insertSess.run('s4', '/test/projectB', '-4 days', '-4 days', 0.05, 600000, 10);
  insertSess.run('s5', '/test/projectB', '-2 days', '-2 days', 0.08, 900000, 15);

  // Repeat fixes on auth.js in projectA (5 times across sessions)
  for (let i = 0; i < 5; i++) {
    insertObs.run(`fix-${i}`, i < 2 ? 's1' : i < 4 ? 's2' : 's3',
      '/test/projectA', 'Edit', `Fix error in auth.js attempt ${i}`,
      0.7, '["error","bugfix"]', 'file_path: /test/projectA/src/auth.js',
      `-${5 - i} days`);
  }

  // Normal observations (not fixes)
  for (let i = 0; i < 10; i++) {
    insertObs.run(`norm-${i}`, i < 5 ? 's1' : 's2',
      '/test/projectA', 'Read', `Read file ${i}`,
      0.3, '[]', `/test/projectA/src/file${i}.js`,
      `-${5 - (i % 5)} days`);
  }

  // ProjectB observations (low friction)
  for (let i = 0; i < 5; i++) {
    insertObs.run(`b-${i}`, i < 3 ? 's4' : 's5',
      '/test/projectB', 'Edit', `Edit component ${i}`,
      0.4, '[]', `/test/projectB/src/comp${i}.tsx`,
      `-${4 - i} days`);
  }
});

after(() => {
  db?.close();
  try { unlinkSync(TEST_DB); } catch {}
});

// ─── Repeat fix detection SQL ───────────────────────────────────────────

describe('Repeat Fix Detection', () => {
  it('finds files with multiple error/bugfix observations', () => {
    const rows = db.prepare(`
      SELECT raw_input AS file_hint, COUNT(*) AS fix_count,
             COUNT(DISTINCT session_id) AS across_sessions
      FROM observations
      WHERE tags LIKE '%error%' OR tags LIKE '%bugfix%'
      GROUP BY file_hint
      HAVING fix_count >= 3
      ORDER BY fix_count DESC
    `).all();

    assert.ok(rows.length >= 1);
    assert.ok(rows[0].fix_count >= 5);
    assert.ok(rows[0].across_sessions >= 2);
    assert.ok(rows[0].file_hint.includes('auth.js'));
  });

  it('does not flag files with few fixes', () => {
    const rows = db.prepare(`
      SELECT raw_input, COUNT(*) AS fix_count
      FROM observations
      WHERE tags LIKE '%error%'
      GROUP BY raw_input
      HAVING fix_count >= 10
    `).all();

    assert.equal(rows.length, 0);
  });
});

// ─── Hotspot detection SQL ──────────────────────────────────────────────

describe('File Hotspot Detection', () => {
  it('identifies high-friction file hotspots', () => {
    const rows = db.prepare(`
      SELECT o.raw_input AS file_hint, COUNT(*) AS total_ops,
             AVG(s.friction_score) AS avg_session_friction,
             SUM(CASE WHEN o.tags LIKE '%error%' THEN 1 ELSE 0 END) AS error_count
      FROM observations o
      JOIN sessions s ON s.id = o.session_id
      WHERE o.tool IN ('Edit', 'Write', 'Read', 'Bash')
      GROUP BY o.raw_input
      HAVING total_ops >= 3
      ORDER BY avg_session_friction DESC
    `).all();

    assert.ok(rows.length >= 1);
    // auth.js should be top hotspot (high friction sessions + errors)
    const authRow = rows.find(r => r.file_hint?.includes('auth.js'));
    assert.ok(authRow, 'auth.js should be a hotspot');
    assert.ok(authRow.error_count >= 5);
  });
});

// ─── Time sink detection SQL ────────────────────────────────────────────

describe('Time Sink Detection', () => {
  it('identifies projects with longest total duration', () => {
    const rows = db.prepare(`
      SELECT project, COUNT(*) AS sessions,
             SUM(duration_ms) AS total_ms,
             AVG(duration_ms) AS avg_ms,
             AVG(friction_score) AS avg_friction
      FROM sessions
      WHERE duration_ms > 0
      GROUP BY project
      ORDER BY total_ms DESC
    `).all();

    assert.ok(rows.length >= 2);
    assert.equal(rows[0].project, '/test/projectA'); // More time spent
    assert.ok(rows[0].total_ms > rows[1].total_ms);
  });

  it('duration aggregates are not inflated by observation count (#110)', () => {
    // Fixed getTimeSinks query shape: no JOIN with observations,
    // obs counted via correlated subquery.
    const rows = db.prepare(`
      SELECT s.project,
             COUNT(*)           AS sessions,
             AVG(s.duration_ms) AS avg_duration_ms,
             SUM(s.duration_ms) AS total_duration_ms,
             SUM((SELECT COUNT(*) FROM observations o WHERE o.session_id = s.id)) AS total_obs
      FROM sessions s
      WHERE s.duration_ms > 0
      GROUP BY s.project
      ORDER BY total_duration_ms DESC
    `).all();

    const a = rows.find(r => r.project === '/test/projectA');
    assert.ok(a);
    assert.equal(a.sessions, 3);
    // projectA: 3600000 + 7200000 + 1800000 — observations (15 шт) НЕ множат сумму
    assert.equal(a.total_duration_ms, 12600000);
    assert.equal(a.avg_duration_ms, 4200000);
    assert.equal(a.total_obs, 15);
  });

  it('LEFT JOIN observations inflates duration aggregates — regression guard (#110)', () => {
    // Документирует баг: старый запрос с LEFT JOIN размножает строки сессий
    const buggy = db.prepare(`
      SELECT SUM(s.duration_ms) AS total_duration_ms
      FROM sessions s
      LEFT JOIN observations o ON o.session_id = s.id
      WHERE s.project = '/test/projectA' AND s.duration_ms > 0
    `).get();

    assert.ok(buggy.total_duration_ms > 12600000,
      'buggy LEFT JOIN query should inflate totals — иначе guard потерял смысл');
  });

  it('detects high friction-to-time ratio', () => {
    const rows = db.prepare(`
      SELECT project, AVG(friction_score) AS avg_friction, AVG(duration_ms) AS avg_ms
      FROM sessions WHERE duration_ms > 0
      GROUP BY project HAVING avg_friction > 0.1
    `).all();

    assert.ok(rows.length >= 1);
    assert.equal(rows[0].project, '/test/projectA');
  });
});

// ─── Cross-session patterns SQL ─────────────────────────────────────────

describe('Cross-Session Patterns', () => {
  it('detects error observations across sessions', () => {
    const rows = db.prepare(`
      SELECT project,
             SUM(CASE WHEN tags LIKE '%error%' THEN 1 ELSE 0 END) AS total_errors,
             COUNT(DISTINCT session_id) AS sessions_with_errors
      FROM observations
      WHERE tags IS NOT NULL AND tags LIKE '%error%'
      GROUP BY project
      HAVING total_errors >= 2
    `).all();

    assert.ok(rows.length >= 1);
    assert.equal(rows[0].project, '/test/projectA');
    assert.ok(rows[0].total_errors >= 5);
    assert.ok(rows[0].sessions_with_errors >= 2);
  });
});
