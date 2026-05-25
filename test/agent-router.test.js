/**
 * test/agent-router.test.js — Routing + Control tests (#22)
 *
 * Tests:
 *   - routeTask: keyword matching → correct agent/command
 *   - routeTask: confidence scoring
 *   - routeTask: fallback for empty / unrecognized input
 *   - routeTask: contextScope assignment
 *   - scopeToQueryOpts: scope → query options
 *   - checkRateLimit: count-based enforcement
 *   - logRoutingDecisionSync: writes to agent_actions
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdirSync, rmSync } from 'fs';

import {
  routeTask,
  scopeToQueryOpts,
  checkRateLimit,
  logRoutingDecisionSync,
} from '../src/agent-router.js';

// ─── DB helper ────────────────────────────────────────────────────────────────

const TEST_DIR = join(tmpdir(), 'claudeye-router-test-' + Date.now());
const TEST_DB  = join(TEST_DIR, 'test.db');

let db;

before(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  db = new Database(TEST_DB);
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_actions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      agent      TEXT    NOT NULL,
      query      TEXT,
      project    TEXT,
      result     TEXT,
      dry_run    INTEGER NOT NULL DEFAULT 0,
      created_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );
  `);
});

after(() => {
  db?.close();
  try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
});

// ─── routeTask ────────────────────────────────────────────────────────────────

describe('routeTask', () => {
  it('routes PR-related descriptions to pr-review', () => {
    const d = routeTask('review the PR changes for auth module');
    assert.equal(d.agent,   'pr-review');
    assert.equal(d.command, 'pr-review');
    assert.ok(d.confidence >= 0.8, `confidence too low: ${d.confidence}`);
  });

  it('routes cross-repo search to cross-repo-context', () => {
    const d = routeTask('find similar patterns across other projects');
    assert.equal(d.agent,   'cross-repo-context');
    assert.equal(d.command, 'context');
    assert.ok(d.confidence >= 0.7);
  });

  it('routes session/activity to daemon session-analysis', () => {
    const d = routeTask('show me what happened in today sessions');
    assert.equal(d.agent,  'daemon');
    assert.equal(d.action, 'session-analysis');
  });

  it('routes db/storage queries to daemon db-growth-alert', () => {
    const d = routeTask('check the database size and disk growth');
    assert.equal(d.agent,  'daemon');
    assert.equal(d.action, 'db-growth-alert');
  });

  it('returns fallback for empty input', () => {
    const d = routeTask('');
    assert.ok(d.confidence < 0.5, 'should be low confidence fallback');
    assert.equal(d.command, 'search');
  });

  it('returns fallback for unrecognized input', () => {
    const d = routeTask('zxqjkmw frobnicate the quux');
    assert.ok(d.confidence < 0.6, 'should be low confidence');
  });

  it('includes a cliHint string', () => {
    const d = routeTask('find how we handled auth errors before');
    assert.ok(typeof d.cliHint === 'string' && d.cliHint.length > 0);
  });

  it('includes contextScope', () => {
    const d = routeTask('review pull request');
    assert.ok(['cross-repo', 'project', 'db', 'none'].includes(d.contextScope));
  });

  it('includes reason field', () => {
    const d = routeTask('review the pr diff');
    assert.ok(typeof d.reason === 'string' && d.reason.length > 0);
  });
});

// ─── scopeToQueryOpts ────────────────────────────────────────────────────────

describe('scopeToQueryOpts', () => {
  it('cross-repo: no project filter, limit 15', () => {
    const opts = scopeToQueryOpts('cross-repo', '/my/project');
    assert.equal(opts.project, null);
    assert.equal(opts.limit, 15);
  });

  it('project: passes currentProject, limit 20', () => {
    const opts = scopeToQueryOpts('project', '/my/project');
    assert.equal(opts.project, '/my/project');
    assert.equal(opts.limit, 20);
  });

  it('db: no project, limit 5', () => {
    const opts = scopeToQueryOpts('db');
    assert.equal(opts.project, null);
    assert.equal(opts.limit, 5);
  });

  it('none: limit 0', () => {
    const opts = scopeToQueryOpts('none');
    assert.equal(opts.limit, 0);
  });

  it('unknown scope falls back to none', () => {
    const opts = scopeToQueryOpts('mystery');
    assert.equal(opts.limit, 0);
  });
});

// ─── checkRateLimit ───────────────────────────────────────────────────────────

describe('checkRateLimit', () => {
  it('allows when no actions exist', () => {
    const result = checkRateLimit(db, 'daemon', 20);
    assert.equal(result.allowed, true);
    assert.equal(result.limit, 20);
  });

  it('blocks when count >= limit', () => {
    // Insert 3 non-dry-run daemon actions
    for (let i = 0; i < 3; i++) {
      db.prepare(`
        INSERT INTO agent_actions (agent, query, project, result, dry_run, created_at)
        VALUES ('daemon', 'test', 'session-analysis', '{}', 0, datetime('now'))
      `).run();
    }

    const result = checkRateLimit(db, 'daemon', 3);
    assert.equal(result.allowed, false);
    assert.equal(result.count, 3);
  });

  it('dry_run actions do not count toward limit', () => {
    // dry_run=1 rows should not increment the counter
    db.prepare(`
      INSERT INTO agent_actions (agent, query, project, result, dry_run, created_at)
      VALUES ('daemon', 'dry', 'session-analysis', '{}', 1, datetime('now'))
    `).run();

    // We have 3 real + 1 dry. Limit 5 → should allow.
    const result = checkRateLimit(db, 'daemon', 5);
    assert.equal(result.allowed, true);
  });

  it('agent filter isolates count', () => {
    // 'router' agent has 0 real actions
    const result = checkRateLimit(db, 'router', 1);
    assert.equal(result.allowed, true);
  });
});

// ─── logRoutingDecisionSync ───────────────────────────────────────────────────

describe('logRoutingDecisionSync', () => {
  it('inserts a row into agent_actions', () => {
    const before = db.prepare("SELECT COUNT(*) AS cnt FROM agent_actions WHERE agent = 'router'").get().cnt;

    const decision = routeTask('search for auth error handling examples');
    logRoutingDecisionSync(db, 'search for auth error handling examples', decision);

    const after = db.prepare("SELECT COUNT(*) AS cnt FROM agent_actions WHERE agent = 'router'").get().cnt;
    assert.equal(after, before + 1);
  });

  it('stored row has dry_run=1', () => {
    const row = db.prepare("SELECT * FROM agent_actions WHERE agent = 'router' ORDER BY id DESC LIMIT 1").get();
    assert.equal(row.dry_run, 1);
  });

  it('stored result contains confidence and reason', () => {
    const row = db.prepare("SELECT * FROM agent_actions WHERE agent = 'router' ORDER BY id DESC LIMIT 1").get();
    const result = JSON.parse(row.result);
    assert.ok(typeof result.confidence === 'number');
    assert.ok(typeof result.reason === 'string');
  });
});
