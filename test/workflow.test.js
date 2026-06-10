/**
 * test/workflow.test.js — Self-Improving Workflow Engine (#28), slice 1
 *
 * Tests: classifyObservation heuristics + getTimeAllocation gap math
 * (db injected — no dependency on ~/.claudeye)
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { unlinkSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { classifyObservation, getTimeAllocation, GAP_CAP_MS, CATEGORIES } from '../src/workflow.js';

const TEST_DIR = join(tmpdir(), 'claudeye-workflow-test-' + Date.now());
const TEST_DB  = join(TEST_DIR, 'test.db');

let db;

// helper: ISO-ish local datetime string at fixed offsets from a base
const base = Date.now() - 60 * 60 * 1000; // 1h ago — inside any window
const at = (offsetSec) => new Date(base + offsetSec * 1000).toISOString().replace('T', ' ').slice(0, 19);

before(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  db = new Database(TEST_DB);
  db.exec(`
    CREATE TABLE observations (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  TEXT    NOT NULL,
      project     TEXT    NOT NULL,
      tool        TEXT    NOT NULL,
      summary     TEXT    NOT NULL,
      tags        TEXT    NOT NULL DEFAULT '[]',
      created_at  TEXT    NOT NULL,
      duration_ms INTEGER
    );
  `);
});

after(() => {
  db?.close();
  try { unlinkSync(TEST_DB); } catch {}
  try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
});

describe('classifyObservation', () => {
  it('tags win over tool: Edit with error tag → debug', () => {
    assert.equal(classifyObservation('Edit', '["error","bugfix"]', 'fix null check'), 'debug');
  });
  it('review tag → review', () => {
    assert.equal(classifyObservation('Bash', '["pr-review"]', 'gh pr view 12'), 'review');
  });
  it('Edit on .md file → docs', () => {
    assert.equal(classifyObservation('Edit', '[]', 'update README.md usage section'), 'docs');
  });
  it('plain Edit → code', () => {
    assert.equal(classifyObservation('Edit', '[]', 'add retry to fetchUser'), 'code');
  });
  it('Read/Grep → research', () => {
    assert.equal(classifyObservation('Read', '[]', 'read src/db.js'), 'research');
    assert.equal(classifyObservation('Grep', '[]', 'search getDb'), 'research');
  });
  it('Bash git/deploy → ops, Bash tests → debug', () => {
    assert.equal(classifyObservation('Bash', '[]', 'git push origin main'), 'ops');
    assert.equal(classifyObservation('Bash', '[]', 'npm test — 3 failures'), 'debug');
  });
  it('always returns a known category', () => {
    assert.ok(CATEGORIES.includes(classifyObservation('SomethingNew', null, null)));
  });
});

describe('getTimeAllocation', () => {
  before(() => {
    const ins = db.prepare(`
      INSERT INTO observations (session_id, project, tool, summary, tags, created_at, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    // session A (/proj1): code 120s gap → research 60s gap → debug tail (duration 30s)
    ins.run('A', '/proj1', 'Edit', 'add feature',        '[]', at(0),   null);
    ins.run('A', '/proj1', 'Read', 'read file',          '[]', at(120), null);
    ins.run('A', '/proj1', 'Bash', 'npm test fails',     '[]', at(180), 30000);
    // session A: huge gap (2h) — must be capped at GAP_CAP_MS
    ins.run('A', '/proj1', 'Edit', 'more code',          '[]', at(7380), null); // 7200s after previous
    // session B (/proj2): single obs, no duration → TAIL fallback (60s)
    ins.run('B', '/proj2', 'Bash', 'git push origin',    '[]', at(0), null);
    // import tool — must be excluded
    ins.run('C', '/proj1', 'git-commit', 'imported commit', '[]', at(0), null);
  });

  it('excludes import tools', () => {
    const res = getTimeAllocation({ days: 30, db });
    assert.equal(res.observations, 5, 'git-commit excluded');
  });

  it('caps long gaps at GAP_CAP_MS', () => {
    const res = getTimeAllocation({ days: 30, db });
    // total = 120s (code) + 60s (research) + cap 900s? NO — debug obs gap to next
    // is 7200s → capped at 900s; last code obs tail 60s; B ops 60s
    const expectedMs = 120000 + 60000 + GAP_CAP_MS + 60000 + 60000;
    assert.equal(res.total_hours, +(expectedMs / 3600000).toFixed(2));
  });

  it('percentages sum to ~100', () => {
    const res = getTimeAllocation({ days: 30, db });
    const sum = res.categories.reduce((s, c) => s + c.pct, 0);
    assert.ok(Math.abs(sum - 100) < 0.5, `pct sum ${sum}`);
  });

  it('filters by project', () => {
    const res = getTimeAllocation({ days: 30, project: '/proj2', db });
    assert.equal(res.observations, 1);
    assert.equal(res.sessions, 1);
    assert.equal(res.categories[0].category, 'ops');
    assert.equal(res.categories[0].pct, 100);
  });

  it('counts sessions and categories correctly', () => {
    const res = getTimeAllocation({ days: 30, db });
    assert.equal(res.sessions, 2);
    const cats = Object.fromEntries(res.categories.map(c => [c.category, c]));
    assert.equal(cats.code.observations, 2);
    assert.equal(cats.research.observations, 1);
    assert.equal(cats.debug.observations, 1);
    assert.equal(cats.ops.observations, 1);
  });

  it('empty window returns zeroes without crashing', () => {
    const res = getTimeAllocation({ days: 30, project: '/nope', db });
    assert.equal(res.observations, 0);
    assert.equal(res.total_hours, 0);
    assert.deepEqual(res.categories, []);
  });
});
