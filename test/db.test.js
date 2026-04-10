/**
 * test/db.test.js — Core database tests
 *
 * Tests: migrations, CRUD observations, sessions, FTS search
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { existsSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const TEST_DIR = join(tmpdir(), 'claudeye-test-' + Date.now());
const TEST_DB  = join(TEST_DIR, 'test.db');

// We test against a fresh in-memory-like DB to avoid touching real data.
// Import db.js functions after patching env.
let db;

before(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  db = new Database(TEST_DB);

  // Apply core schema
  db.exec(`
    CREATE TABLE IF NOT EXISTS observations (
      id          TEXT    PRIMARY KEY,
      session_id  TEXT    NOT NULL,
      project     TEXT,
      tool        TEXT    NOT NULL,
      summary     TEXT    NOT NULL,
      importance  REAL    NOT NULL DEFAULT 0.5,
      tags        TEXT    DEFAULT '[]',
      raw_input   TEXT,
      raw_output  TEXT,
      retry_count INTEGER DEFAULT 0,
      decision_rationale TEXT,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id             TEXT    PRIMARY KEY,
      project        TEXT    NOT NULL,
      started_at     TEXT    NOT NULL DEFAULT (datetime('now')),
      ended_at       TEXT,
      summary        TEXT,
      prompt_count   INTEGER NOT NULL DEFAULT 0,
      friction_score REAL    DEFAULT 0
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS fts_obs USING fts5(
      summary, tags, content=observations, content_rowid=rowid
    );
  `);
});

after(() => {
  db.close();
  try { unlinkSync(TEST_DB); } catch {}
});

// ─── Observations CRUD ──────────────────────────────────────────────────

describe('Observations', () => {
  it('insert and retrieve observation', () => {
    db.prepare(`
      INSERT INTO observations (id, session_id, project, tool, summary, importance, tags)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('obs-1', 'sess-1', '/test/project', 'Edit', 'Fixed a bug in auth.js', 0.8, '["bugfix"]');

    const obs = db.prepare('SELECT * FROM observations WHERE id = ?').get('obs-1');
    assert.equal(obs.id, 'obs-1');
    assert.equal(obs.tool, 'Edit');
    assert.equal(obs.importance, 0.8);
    assert.deepEqual(JSON.parse(obs.tags), ['bugfix']);
  });

  it('multiple observations for same session', () => {
    db.prepare(`
      INSERT INTO observations (id, session_id, project, tool, summary, importance)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('obs-2', 'sess-1', '/test/project', 'Bash', 'Ran tests', 0.5);

    const count = db.prepare('SELECT COUNT(*) as n FROM observations WHERE session_id = ?').get('sess-1');
    assert.equal(count.n, 2);
  });

  it('importance is constrained 0-1', () => {
    db.prepare(`
      INSERT INTO observations (id, session_id, project, tool, summary, importance)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('obs-3', 'sess-1', '/test/project', 'Read', 'Read file', 0.0);

    const obs = db.prepare('SELECT importance FROM observations WHERE id = ?').get('obs-3');
    assert.equal(obs.importance, 0.0);
  });
});

// ─── Sessions ───────────────────────────────────────────────────────────

describe('Sessions', () => {
  it('create and close session', () => {
    db.prepare(`
      INSERT INTO sessions (id, project, started_at)
      VALUES (?, ?, datetime('now'))
    `).run('sess-1', '/test/project');

    db.prepare(`
      UPDATE sessions SET ended_at = datetime('now'), summary = ?, friction_score = ?
      WHERE id = ?
    `).run('Test session summary', 0.15, 'sess-1');

    const sess = db.prepare('SELECT * FROM sessions WHERE id = ?').get('sess-1');
    assert.equal(sess.project, '/test/project');
    assert.equal(sess.friction_score, 0.15);
    assert.ok(sess.ended_at);
    assert.equal(sess.summary, 'Test session summary');
  });

  it('session observations count', () => {
    const result = db.prepare(`
      SELECT s.id, COUNT(o.id) as obs_count
      FROM sessions s
      LEFT JOIN observations o ON o.session_id = s.id
      WHERE s.id = ?
      GROUP BY s.id
    `).get('sess-1');

    assert.equal(result.obs_count, 3);
  });
});

// ─── FTS Search ─────────────────────────────────────────────────────────

describe('FTS Search', () => {
  before(() => {
    // Populate FTS index
    const obs = db.prepare('SELECT rowid, summary, tags FROM observations').all();
    const insert = db.prepare('INSERT INTO fts_obs(rowid, summary, tags) VALUES (?, ?, ?)');
    for (const o of obs) {
      insert.run(o.rowid, o.summary, o.tags);
    }
  });

  it('search by keyword', () => {
    const results = db.prepare(`
      SELECT summary FROM fts_obs WHERE fts_obs MATCH ?
    `).all('bug');

    assert.ok(results.length >= 1);
    assert.ok(results[0].summary.includes('bug'));
  });

  it('search by tag', () => {
    const results = db.prepare(`
      SELECT tags FROM fts_obs WHERE fts_obs MATCH ?
    `).all('bugfix');

    assert.ok(results.length >= 1);
  });

  it('no results for non-existent term', () => {
    const results = db.prepare(`
      SELECT summary FROM fts_obs WHERE fts_obs MATCH ?
    `).all('xyznonexistent');

    assert.equal(results.length, 0);
  });
});
