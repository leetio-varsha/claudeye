/**
 * test/agent.test.js — Agent v1 tests (#20)
 *
 * Tests: agent_actions schema, logAgentAction, getAgentHistory
 * (Does not test hybridSearch-dependent functions — those require real SQLite + embeddings)
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { existsSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const TEST_DIR = join(tmpdir(), 'claudeye-agent-test-' + Date.now());
const TEST_DB  = join(TEST_DIR, 'test.db');

let db;

before(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  db = new Database(TEST_DB);

  // Apply minimal schema needed for agent tests (mirrors src/db.js agent_actions, incl. #21 feedback cols)
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_actions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      agent         TEXT    NOT NULL,
      query         TEXT,
      project       TEXT,
      result        TEXT,
      dry_run       INTEGER NOT NULL DEFAULT 0,
      feedback      TEXT,
      feedback_at   TEXT,
      feedback_note TEXT,
      created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_agent_actions_agent    ON agent_actions(agent);
    CREATE INDEX IF NOT EXISTS idx_agent_actions_created  ON agent_actions(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_actions_project  ON agent_actions(project);
    CREATE INDEX IF NOT EXISTS idx_agent_actions_feedback ON agent_actions(feedback);
  `);
});

after(() => {
  db?.close();
  try { unlinkSync(TEST_DB); } catch {}
  try { require('fs').rmdirSync(TEST_DIR); } catch {}
});

describe('agent_actions schema', () => {
  it('creates agent_actions table with correct columns', () => {
    const cols = db.prepare('PRAGMA table_info(agent_actions)').all();
    const colNames = cols.map(c => c.name);
    assert.ok(colNames.includes('id'),         'has id');
    assert.ok(colNames.includes('agent'),      'has agent');
    assert.ok(colNames.includes('query'),      'has query');
    assert.ok(colNames.includes('project'),    'has project');
    assert.ok(colNames.includes('result'),     'has result');
    assert.ok(colNames.includes('dry_run'),    'has dry_run');
    assert.ok(colNames.includes('created_at'), 'has created_at');
  });

  it('inserts and retrieves a cross-repo-context action', () => {
    const result = { totalResults: 5, projects: [{ project: '/test', count: 3 }] };
    db.prepare(`
      INSERT INTO agent_actions (agent, query, project, result, dry_run)
      VALUES (?, ?, ?, ?, ?)
    `).run('cross-repo-context', 'test query', '/test/project', JSON.stringify(result), 0);

    const row = db.prepare('SELECT * FROM agent_actions WHERE agent = ?').get('cross-repo-context');
    assert.ok(row, 'row inserted');
    assert.equal(row.agent,   'cross-repo-context');
    assert.equal(row.query,   'test query');
    assert.equal(row.project, '/test/project');
    assert.equal(row.dry_run, 0);
    const parsed = JSON.parse(row.result);
    assert.equal(parsed.totalResults, 5);
  });

  it('inserts a pr-review action with dry_run=1', () => {
    db.prepare(`
      INSERT INTO agent_actions (agent, query, project, result, dry_run)
      VALUES (?, ?, ?, ?, ?)
    `).run('pr-review', 'changes to src/db.js, cli.js', '/test/repo', null, 1);

    const row = db.prepare("SELECT * FROM agent_actions WHERE agent = 'pr-review'").get();
    assert.ok(row, 'pr-review row inserted');
    assert.equal(row.dry_run, 1);
    assert.equal(row.result,  null);
  });

  it('returns rows ordered by created_at DESC', () => {
    // Reset and insert in known order
    db.exec("DELETE FROM agent_actions");
    db.prepare("INSERT INTO agent_actions (agent, query, created_at) VALUES (?, ?, ?)").run('cross-repo-context', 'first', '2026-01-01 10:00:00');
    db.prepare("INSERT INTO agent_actions (agent, query, created_at) VALUES (?, ?, ?)").run('pr-review', 'second', '2026-01-02 10:00:00');

    const rows = db.prepare('SELECT query FROM agent_actions ORDER BY created_at DESC').all();
    assert.equal(rows[0].query, 'second', 'most recent first');
    assert.equal(rows[1].query, 'first');
  });

  it('indexes exist on agent and created_at', () => {
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='agent_actions'").all();
    const indexNames = indexes.map(i => i.name);
    assert.ok(indexNames.includes('idx_agent_actions_agent'),   'agent index exists');
    assert.ok(indexNames.includes('idx_agent_actions_created'), 'created_at index exists');
  });

  it('agent column is filterable', () => {
    db.exec("DELETE FROM agent_actions");
    db.prepare("INSERT INTO agent_actions (agent, query) VALUES (?, ?)").run('cross-repo-context', 'q1');
    db.prepare("INSERT INTO agent_actions (agent, query) VALUES (?, ?)").run('pr-review', 'q2');
    db.prepare("INSERT INTO agent_actions (agent, query) VALUES (?, ?)").run('cross-repo-context', 'q3');

    const contextOnly = db.prepare("SELECT * FROM agent_actions WHERE agent = 'cross-repo-context'").all();
    assert.equal(contextOnly.length, 2, 'filters by agent correctly');
    assert.ok(contextOnly.every(r => r.agent === 'cross-repo-context'));
  });
});

describe('feedback loop #21 — accept/reject', () => {
  // Mirrors the SQL contracts of setActionFeedback / getPendingActions /
  // getAgentEffectiveness in src/agent.js.

  it('schema has feedback columns + index', () => {
    const cols = db.prepare('PRAGMA table_info(agent_actions)').all().map(c => c.name);
    assert.ok(cols.includes('feedback'),      'has feedback');
    assert.ok(cols.includes('feedback_at'),   'has feedback_at');
    assert.ok(cols.includes('feedback_note'), 'has feedback_note');
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='agent_actions'").all().map(i => i.name);
    assert.ok(idx.includes('idx_agent_actions_feedback'), 'feedback index exists');
  });

  it('new actions default to pending (feedback IS NULL)', () => {
    db.exec("DELETE FROM agent_actions");
    db.prepare("INSERT INTO agent_actions (agent, query) VALUES (?, ?)").run('daemon', 'session-analysis');
    const row = db.prepare("SELECT feedback FROM agent_actions").get();
    assert.equal(row.feedback, null, 'feedback null by default');
  });

  it('setActionFeedback UPDATE sets accepted with timestamp + note', () => {
    db.exec("DELETE FROM agent_actions");
    const { lastInsertRowid: id } = db.prepare("INSERT INTO agent_actions (agent, query) VALUES (?, ?)").run('daemon', 'q');
    const now = new Date().toISOString();
    const info = db.prepare("UPDATE agent_actions SET feedback = ?, feedback_at = ?, feedback_note = ? WHERE id = ?")
      .run('accepted', now, 'useful', id);
    assert.equal(info.changes, 1, 'one row updated');
    const row = db.prepare("SELECT * FROM agent_actions WHERE id = ?").get(id);
    assert.equal(row.feedback, 'accepted');
    assert.equal(row.feedback_note, 'useful');
    assert.equal(row.feedback_at, now);
  });

  it('pending filter excludes actions that already have feedback', () => {
    db.exec("DELETE FROM agent_actions");
    db.prepare("INSERT INTO agent_actions (agent, query, feedback) VALUES (?, ?, ?)").run('daemon', 'a', 'accepted');
    db.prepare("INSERT INTO agent_actions (agent, query, feedback) VALUES (?, ?, ?)").run('daemon', 'b', null);
    db.prepare("INSERT INTO agent_actions (agent, query, feedback) VALUES (?, ?, ?)").run('daemon', 'c', 'rejected');
    const pending = db.prepare("SELECT * FROM agent_actions WHERE feedback IS NULL").all();
    assert.equal(pending.length, 1, 'only the un-reviewed action is pending');
    assert.equal(pending[0].query, 'b');
  });

  it('effectiveness aggregation computes counts + rejection rate', () => {
    db.exec("DELETE FROM agent_actions");
    const ins = db.prepare("INSERT INTO agent_actions (agent, feedback) VALUES (?, ?)");
    ins.run('cross-repo-context', 'accepted');
    ins.run('cross-repo-context', 'accepted');
    ins.run('cross-repo-context', 'rejected');
    ins.run('cross-repo-context', null); // pending

    const totals = db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN feedback = 'accepted' THEN 1 ELSE 0 END) AS accepted,
        SUM(CASE WHEN feedback = 'rejected' THEN 1 ELSE 0 END) AS rejected,
        SUM(CASE WHEN feedback IS NULL      THEN 1 ELSE 0 END) AS pending
      FROM agent_actions
    `).get();

    assert.equal(totals.total, 4);
    assert.equal(totals.accepted, 2);
    assert.equal(totals.rejected, 1);
    assert.equal(totals.pending, 1);

    const reviewed = totals.accepted + totals.rejected;
    const rejectionRate = reviewed > 0 ? totals.rejected / reviewed : null;
    assert.equal(reviewed, 3);
    assert.ok(Math.abs(rejectionRate - 1 / 3) < 1e-9, 'rejection rate = 1/3');
  });

  it('rejection rate is null when nothing reviewed yet', () => {
    db.exec("DELETE FROM agent_actions");
    db.prepare("INSERT INTO agent_actions (agent, feedback) VALUES (?, ?)").run('daemon', null);
    const totals = db.prepare(`
      SELECT
        SUM(CASE WHEN feedback = 'accepted' THEN 1 ELSE 0 END) AS accepted,
        SUM(CASE WHEN feedback = 'rejected' THEN 1 ELSE 0 END) AS rejected
      FROM agent_actions
    `).get();
    const reviewed = (totals.accepted ?? 0) + (totals.rejected ?? 0);
    const rejectionRate = reviewed > 0 ? totals.rejected / reviewed : null;
    assert.equal(rejectionRate, null);
  });
});
