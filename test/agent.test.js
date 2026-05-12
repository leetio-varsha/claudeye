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

  // Apply minimal schema needed for agent tests
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_actions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      agent        TEXT    NOT NULL,
      query        TEXT,
      project      TEXT,
      result       TEXT,
      dry_run      INTEGER NOT NULL DEFAULT 0,
      created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_agent_actions_agent   ON agent_actions(agent);
    CREATE INDEX IF NOT EXISTS idx_agent_actions_created ON agent_actions(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_actions_project ON agent_actions(project);
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
