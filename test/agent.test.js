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

describe('weekly agent digest #21 — getAgentDigest contracts', () => {
  // Mirrors the SQL contracts of getAgentDigest in src/agent.js:
  // window cutoff, daily volume, rejected-notes selection, recommendations.

  const DAYS = 7;
  const cutoff = () => new Date(Date.now() - DAYS * 86_400_000).toISOString();

  it('window cutoff excludes actions older than `days`', () => {
    db.exec("DELETE FROM agent_actions");
    const old    = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const recent = new Date(Date.now() -  1 * 86_400_000).toISOString();
    db.prepare("INSERT INTO agent_actions (agent, created_at) VALUES (?, ?)").run('daemon', old);
    db.prepare("INSERT INTO agent_actions (agent, created_at) VALUES (?, ?)").run('daemon', recent);

    const inWindow = db.prepare(
      "SELECT COUNT(*) AS c FROM agent_actions WHERE created_at >= ?"
    ).get(cutoff());
    assert.equal(inWindow.c, 1, 'only the recent action is in the 7d window');
  });

  it('daily volume groups by calendar day', () => {
    db.exec("DELETE FROM agent_actions");
    const d1 = new Date(Date.now() - 1 * 86_400_000).toISOString();
    const d2 = new Date(Date.now() - 2 * 86_400_000).toISOString();
    db.prepare("INSERT INTO agent_actions (agent, created_at) VALUES (?, ?)").run('daemon', d1);
    db.prepare("INSERT INTO agent_actions (agent, created_at) VALUES (?, ?)").run('daemon', d1);
    db.prepare("INSERT INTO agent_actions (agent, created_at) VALUES (?, ?)").run('daemon', d2);

    const byDay = db.prepare(`
      SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS count
      FROM agent_actions
      WHERE created_at >= ?
      GROUP BY day
      ORDER BY day ASC
    `).all(cutoff());

    assert.equal(byDay.length, 2, 'two distinct days');
    assert.equal(byDay.reduce((s, r) => s + r.count, 0), 3, 'three actions total');
  });

  it('rejected-notes selection returns only rejected rows with notes/metadata', () => {
    db.exec("DELETE FROM agent_actions");
    const now = new Date().toISOString();
    db.prepare("INSERT INTO agent_actions (agent, feedback, feedback_note, created_at) VALUES (?, ?, ?, ?)")
      .run('cross-repo-context', 'rejected', 'too noisy', now);
    db.prepare("INSERT INTO agent_actions (agent, feedback, created_at) VALUES (?, ?, ?)")
      .run('daemon', 'accepted', now);
    db.prepare("INSERT INTO agent_actions (agent, created_at) VALUES (?, ?)")
      .run('daemon', now); // pending

    const rejected = db.prepare(`
      SELECT id, agent, feedback_note, created_at
      FROM agent_actions
      WHERE feedback = 'rejected' AND created_at >= ?
      ORDER BY created_at DESC
      LIMIT 10
    `).all(cutoff());

    assert.equal(rejected.length, 1, 'only the rejected action surfaces');
    assert.equal(rejected[0].agent, 'cross-repo-context');
    assert.equal(rejected[0].feedback_note, 'too noisy');
  });

  it('recommends reducing aggressiveness when rejection rate > 50%', () => {
    db.exec("DELETE FROM agent_actions");
    const ins = db.prepare("INSERT INTO agent_actions (agent, feedback) VALUES (?, ?)");
    ins.run('daemon', 'rejected');
    ins.run('daemon', 'rejected');
    ins.run('daemon', 'accepted'); // 2/3 rejected = 67%

    const t = db.prepare(`
      SELECT
        SUM(CASE WHEN feedback = 'accepted' THEN 1 ELSE 0 END) AS accepted,
        SUM(CASE WHEN feedback = 'rejected' THEN 1 ELSE 0 END) AS rejected
      FROM agent_actions
    `).get();
    const reviewed = (t.accepted ?? 0) + (t.rejected ?? 0);
    const rejectionRate = reviewed > 0 ? t.rejected / reviewed : null;

    const recs = [];
    if (rejectionRate != null && rejectionRate > 0.5) recs.push('reduce-aggressiveness');
    assert.ok(recs.includes('reduce-aggressiveness'), 'high rejection rate triggers recommendation');
  });

  it('recommends giving feedback when nothing reviewed but actions exist', () => {
    db.exec("DELETE FROM agent_actions");
    db.prepare("INSERT INTO agent_actions (agent, feedback) VALUES (?, ?)").run('daemon', null);
    db.prepare("INSERT INTO agent_actions (agent, feedback) VALUES (?, ?)").run('daemon', null);

    const t = db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN feedback = 'accepted' THEN 1 ELSE 0 END) AS accepted,
        SUM(CASE WHEN feedback = 'rejected' THEN 1 ELSE 0 END) AS rejected
      FROM agent_actions
    `).get();
    const reviewed = (t.accepted ?? 0) + (t.rejected ?? 0);

    const recs = [];
    if (reviewed === 0 && t.total > 0) recs.push('give-feedback');
    assert.ok(recs.includes('give-feedback'), 'unreviewed backlog triggers feedback prompt');
  });
});

describe('time saved vs review time #21 — getAgentTimeSavings contracts', () => {
  // Mirrors the per-agent accepted/rejected aggregation + cost model of
  // getAgentTimeSavings in src/agent.js. Heuristics there:
  //   cross-repo-context = 8 min saved/accepted, pr-review = 12, default = 5;
  //   review cost = 1 min per reviewed (accepted+rejected) action;
  //   net = Σ(accepted × perAgent) − (reviewed × 1).

  const SAVED = { 'cross-repo-context': 8, 'pr-review': 12 };
  const DEFAULT_SAVED = 5;
  const REVIEW_MIN = 1;

  const aggregate = (sinceDays = null) => {
    const where = [];
    const args  = [];
    if (sinceDays != null) {
      where.push('created_at >= ?');
      args.push(new Date(Date.now() - sinceDays * 86_400_000).toISOString());
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = db.prepare(`
      SELECT agent,
        SUM(CASE WHEN feedback = 'accepted' THEN 1 ELSE 0 END) AS accepted,
        SUM(CASE WHEN feedback = 'rejected' THEN 1 ELSE 0 END) AS rejected
      FROM agent_actions ${whereSql} GROUP BY agent
    `).all(...args);
    let saved = 0, review = 0, accepted = 0, reviewed = 0;
    for (const r of rows) {
      const acc = r.accepted ?? 0, rej = r.rejected ?? 0, rev = acc + rej;
      saved   += acc * (SAVED[r.agent] ?? DEFAULT_SAVED);
      review  += rev * REVIEW_MIN;
      accepted += acc; reviewed += rev;
    }
    return { accepted, reviewed, estMinutesSaved: saved, estReviewMinutes: review, netMinutesSaved: saved - review };
  };

  it('only accepted actions count as time saved (rejected save nothing)', () => {
    db.exec("DELETE FROM agent_actions");
    const ins = db.prepare("INSERT INTO agent_actions (agent, feedback) VALUES (?, ?)");
    ins.run('cross-repo-context', 'accepted'); // 8 saved
    ins.run('cross-repo-context', 'rejected'); // 0 saved
    ins.run('cross-repo-context', null);        // pending — neither
    const s = aggregate();
    assert.equal(s.estMinutesSaved, 8, '1 accepted × 8 = 8 saved');
    assert.equal(s.reviewed, 2, 'accepted + rejected reviewed');
    assert.equal(s.estReviewMinutes, 2, '2 reviewed × 1 min');
    assert.equal(s.netMinutesSaved, 6, '8 saved − 2 review = 6 net');
  });

  it('uses per-agent saved-minute heuristics', () => {
    db.exec("DELETE FROM agent_actions");
    const ins = db.prepare("INSERT INTO agent_actions (agent, feedback) VALUES (?, ?)");
    ins.run('pr-review', 'accepted');          // 12
    ins.run('cross-repo-context', 'accepted'); // 8
    ins.run('mystery-agent', 'accepted');      // default 5
    const s = aggregate();
    assert.equal(s.estMinutesSaved, 12 + 8 + 5, 'per-agent heuristics summed');
    assert.equal(s.netMinutesSaved, 25 - 3, '25 saved − 3 reviewed');
  });

  it('net goes negative when reviewing outweighs accepted value', () => {
    db.exec("DELETE FROM agent_actions");
    const ins = db.prepare("INSERT INTO agent_actions (agent, feedback) VALUES (?, ?)");
    // 1 accepted default-agent (5 saved) but 8 rejected (8 review) → net negative
    ins.run('mystery-agent', 'accepted');
    for (let i = 0; i < 8; i++) ins.run('mystery-agent', 'rejected');
    const s = aggregate();
    assert.equal(s.estMinutesSaved, 5);
    assert.equal(s.estReviewMinutes, 9, '9 reviewed × 1 min');
    assert.ok(s.netMinutesSaved < 0, 'net is negative');
    assert.equal(s.netMinutesSaved, -4);
  });

  it('zero reviewed actions → zero saved and zero net', () => {
    db.exec("DELETE FROM agent_actions");
    db.prepare("INSERT INTO agent_actions (agent, feedback) VALUES (?, ?)").run('cross-repo-context', null);
    const s = aggregate();
    assert.equal(s.reviewed, 0);
    assert.equal(s.estMinutesSaved, 0);
    assert.equal(s.netMinutesSaved, 0);
  });

  it('window cutoff excludes actions older than `sinceDays`', () => {
    db.exec("DELETE FROM agent_actions");
    const old    = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const recent = new Date(Date.now() -  1 * 86_400_000).toISOString();
    db.prepare("INSERT INTO agent_actions (agent, feedback, created_at) VALUES (?, ?, ?)").run('pr-review', 'accepted', old);
    db.prepare("INSERT INTO agent_actions (agent, feedback, created_at) VALUES (?, ?, ?)").run('pr-review', 'accepted', recent);
    const s = aggregate(7);
    assert.equal(s.accepted, 1, 'only the recent accepted action is in the 7d window');
    assert.equal(s.estMinutesSaved, 12, 'one pr-review accepted = 12');
  });
});

describe('review-queue status #115 — getReviewQueueStatus contracts', () => {
  // Mirrors the SQL contract of getReviewQueueStatus in src/agent.js:
  //   pending        = COUNT WHERE feedback IS NULL (all-time)
  //   reviewedRecent = COUNT WHERE feedback IN (accepted,rejected) AND feedback_at >= cutoff

  const status = (reviewedWindowDays = 7) => {
    const pending = db.prepare(
      "SELECT COUNT(*) AS n FROM agent_actions WHERE feedback IS NULL"
    ).get().n ?? 0;
    const cutoff = new Date(Date.now() - reviewedWindowDays * 86_400_000).toISOString();
    const reviewedRecent = db.prepare(
      "SELECT COUNT(*) AS n FROM agent_actions WHERE feedback IN ('accepted','rejected') AND feedback_at >= ?"
    ).get(cutoff).n ?? 0;
    return { pending, reviewedRecent, windowDays: reviewedWindowDays };
  };

  it('counts all un-reviewed actions as pending', () => {
    db.exec("DELETE FROM agent_actions");
    const ins = db.prepare("INSERT INTO agent_actions (agent, feedback) VALUES (?, ?)");
    ins.run('daemon', null);
    ins.run('daemon', null);
    ins.run('daemon', 'accepted');
    const s = status();
    assert.equal(s.pending, 2, 'two pending, accepted one excluded');
  });

  it('reviewedRecent counts only verdicts inside the window', () => {
    db.exec("DELETE FROM agent_actions");
    const now    = new Date().toISOString();
    const old    = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const ins = db.prepare("INSERT INTO agent_actions (agent, feedback, feedback_at) VALUES (?, ?, ?)");
    ins.run('daemon', 'accepted', now);   // in window
    ins.run('daemon', 'rejected', now);   // in window
    ins.run('daemon', 'accepted', old);   // out of window
    const s = status(7);
    assert.equal(s.reviewedRecent, 2, 'only the two recent verdicts count');
  });

  it('the trigger condition: backlog with zero recent review fires', () => {
    db.exec("DELETE FROM agent_actions");
    const ins = db.prepare("INSERT INTO agent_actions (agent, feedback) VALUES (?, ?)");
    for (let i = 0; i < 60; i++) ins.run('daemon', null);
    const s = status();
    const PENDING_WARN = 50;
    const shouldWarn = s.pending >= PENDING_WARN && s.reviewedRecent === 0;
    assert.ok(shouldWarn, '60 pending / 0 reviewed → warning fires');
  });

  it('a single recent verdict clears the warning condition', () => {
    db.exec("DELETE FROM agent_actions");
    const ins = db.prepare("INSERT INTO agent_actions (agent, feedback, feedback_at) VALUES (?, ?, ?)");
    for (let i = 0; i < 60; i++) ins.run('daemon', null, null);
    ins.run('daemon', 'accepted', new Date().toISOString());
    const s = status();
    const PENDING_WARN = 50;
    const shouldWarn = s.pending >= PENDING_WARN && s.reviewedRecent === 0;
    assert.equal(shouldWarn, false, 'one recent verdict suppresses the nudge');
  });
});
