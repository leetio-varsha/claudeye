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

import { classifyObservation, getTimeAllocation, getBottlenecks, getPersonalBenchmarks, getWorkflowTemplates, getBeforeAfter, weekStart, trendOf, GAP_CAP_MS, CATEGORIES, CHURN_MIN_EDITS, TEMPLATE_PRESENCE } from '../src/workflow.js';

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

describe('getBottlenecks (#28 slice 2)', () => {
  let bdb;
  const BDB_PATH = join(TEST_DIR, 'bottlenecks.db');

  before(() => {
    bdb = new Database(BDB_PATH);
    bdb.exec(`
      CREATE TABLE observations (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id  TEXT NOT NULL,
        project     TEXT NOT NULL,
        tool        TEXT NOT NULL,
        summary     TEXT NOT NULL,
        tags        TEXT NOT NULL DEFAULT '[]',
        created_at  TEXT NOT NULL,
        duration_ms INTEGER
      );
      CREATE TABLE sessions (
        id             TEXT PRIMARY KEY,
        project        TEXT NOT NULL,
        started_at     TEXT NOT NULL,
        friction_score REAL DEFAULT 0
      );
    `);
    const ins = bdb.prepare(`
      INSERT INTO observations (session_id, project, tool, summary, tags, created_at, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    // Session S1: churn — src/api.js правится 3 раза (edit-test-edit цикл),
    // переходы code→debug (gap 300s — дорогой) и debug→code (gap 30s)
    ins.run('S1', '/p', 'Edit', 'fix handler in src/api.js',   '[]', at(0),    null);
    ins.run('S1', '/p', 'Bash', 'npm test — 2 failures',       '[]', at(300),  null); // code→debug, 300s
    ins.run('S1', '/p', 'Edit', 'retry fix src/api.js guard',  '[]', at(330),  null); // debug→code, 30s
    ins.run('S1', '/p', 'Bash', 'npm test — 1 failure',        '[]', at(630),  null); // code→debug, 300s
    ins.run('S1', '/p', 'Edit', 'final fix src/api.js',        '[]', at(660),  null); // debug→code, 30s
    // Session S2: один раз правится другой файл — НЕ churn
    ins.run('S2', '/p', 'Edit', 'tweak src/other.js once',     '[]', at(0),    null);

    const sess = bdb.prepare(`INSERT INTO sessions (id, project, started_at, friction_score) VALUES (?, ?, ?, ?)`);
    sess.run('S1', '/p', at(0), 0.8);
    sess.run('S2', '/p', at(0), 0.1);
  });

  after(() => {
    bdb?.close();
    try { unlinkSync(BDB_PATH); } catch {}
  });

  it('detects churn file with >= CHURN_MIN_EDITS edits in one session', () => {
    const res = getBottlenecks({ days: 30, db: bdb, minObs: 1 });
    assert.equal(res.churn_files.length, 1, 'only src/api.js is churn');
    assert.equal(res.churn_files[0].file, 'src/api.js');
    assert.equal(res.churn_files[0].edits, CHURN_MIN_EDITS);
    assert.equal(res.churn_files[0].sessions, 1);
  });

  it('ranks transitions by avg cost: code→debug (300s) above debug→code (30s)', () => {
    const res = getBottlenecks({ days: 30, db: bdb, minObs: 1 });
    const t = Object.fromEntries(res.transitions.map(x => [`${x.from}→${x.to}`, x]));
    assert.equal(t['code→debug'].avg_sec, 300);
    assert.equal(t['code→debug'].count, 2);
    assert.equal(t['debug→code'].avg_sec, 30);
    assert.equal(res.transitions[0].from, 'code');
    assert.equal(res.transitions[0].to, 'debug');
  });

  it('slow_steps: code steps slower than debug, slowdown relative to overall avg', () => {
    const res = getBottlenecks({ days: 30, db: bdb, minObs: 1 });
    const s = Object.fromEntries(res.slow_steps.map(x => [x.category, x]));
    // code: (300+30+300)/3 = 210s... wait: S1 code obs gaps 300,300 + tail 60; S2 tail 60
    assert.ok(s.code.avg_sec > s.debug.avg_sec, `code ${s.code.avg_sec}s > debug ${s.debug.avg_sec}s`);
    assert.ok(res.overall_avg_sec > 0);
    assert.ok(Math.abs(s.code.slowdown - s.code.avg_sec / res.overall_avg_sec) < 0.05);
  });

  it('friction_sessions sorted by score, dominant category attached', () => {
    const res = getBottlenecks({ days: 30, db: bdb, minObs: 1 });
    assert.equal(res.friction_sessions[0].id, 'S1');
    assert.equal(res.friction_sessions[0].friction_score, 0.8);
    assert.ok(CATEGORIES.includes(res.friction_sessions[0].dominant));
  });

  it('minObs filters thin categories from slow_steps', () => {
    const res = getBottlenecks({ days: 30, db: bdb, minObs: 10 });
    assert.deepEqual(res.slow_steps, []);
  });

  it('works without sessions table (graceful degradation)', () => {
    const res = getBottlenecks({ days: 30, db, minObs: 1 }); // основная тестовая БД без sessions
    assert.deepEqual(res.friction_sessions, []);
    assert.ok(res.observations > 0);
  });

  it('produces churn hint', () => {
    const res = getBottlenecks({ days: 30, db: bdb, minObs: 1 });
    assert.ok(res.hints.some(h => h.includes('src/api.js')), `hints: ${JSON.stringify(res.hints)}`);
  });

  it('empty window: no crash, empty lists', () => {
    const res = getBottlenecks({ days: 30, project: '/nope', db: bdb });
    assert.equal(res.observations, 0);
    assert.deepEqual(res.slow_steps, []);
    assert.deepEqual(res.transitions, []);
    assert.deepEqual(res.churn_files, []);
    assert.deepEqual(res.hints, []);
  });
});

describe('weekStart', () => {
  // June 14 2026 is a Sunday → its week's Monday is June 8.
  it('Sunday maps back to its Monday', () => {
    assert.equal(weekStart('2026-06-14'), '2026-06-08');
  });
  it('Monday maps to itself', () => {
    assert.equal(weekStart('2026-06-08'), '2026-06-08');
  });
  it('midweek maps to its Monday', () => {
    assert.equal(weekStart('2026-06-10 13:45:00'), '2026-06-08');
  });
  it('next Monday starts a new week', () => {
    assert.equal(weekStart('2026-06-15'), '2026-06-15');
  });
});

describe('trendOf', () => {
  it('rising series → up', () => assert.equal(trendOf([1, 2, 3, 4]), 'up'));
  it('falling series → down', () => assert.equal(trendOf([4, 3, 2, 1]), 'down'));
  it('flat series → flat', () => assert.equal(trendOf([5, 5, 5, 5]), 'flat'));
  it('single point → flat', () => assert.equal(trendOf([5]), 'flat'));
});

describe('getPersonalBenchmarks (#28 slice 3)', () => {
  let pdb;
  const PDB_PATH = join(TEST_DIR, 'benchmarks.db');
  // place an observation `daysAgo` in the past, at HH:MM (UTC) — minutes apart
  // → controls both ISO-week bucket and within-session gaps
  const dayAt = (daysAgo, min) => {
    const d = new Date(Date.now() - daysAgo * 86400000);
    d.setUTCHours(12, min, 0, 0);
    return d.toISOString().replace('T', ' ').slice(0, 19);
  };

  before(() => {
    pdb = new Database(PDB_PATH);
    pdb.exec(`
      CREATE TABLE observations (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id  TEXT NOT NULL,
        project     TEXT NOT NULL,
        tool        TEXT NOT NULL,
        summary     TEXT NOT NULL,
        tags        TEXT NOT NULL DEFAULT '[]',
        created_at  TEXT NOT NULL,
        duration_ms INTEGER
      );
    `);
    const ins = pdb.prepare(`
      INSERT INTO observations (session_id, project, tool, summary, tags, created_at, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    // Old week (~17 days ago): slow — 3 obs, gaps 10 min → low throughput
    ins.run('w1', '/p', 'Edit', 'work', '[]', dayAt(17, 0),  null);
    ins.run('w1', '/p', 'Edit', 'work', '[]', dayAt(17, 10), null);
    ins.run('w1', '/p', 'Edit', 'work', '[]', dayAt(17, 20), null);
    // Mid week (~10 days ago): 3 obs, gaps 5 min
    ins.run('w2', '/p', 'Edit', 'work', '[]', dayAt(10, 0),  null);
    ins.run('w2', '/p', 'Edit', 'work', '[]', dayAt(10, 5),  null);
    ins.run('w2', '/p', 'Edit', 'work', '[]', dayAt(10, 10), null);
    // Latest week (~3 days ago): fast — 4 obs, gaps 1 min → high throughput
    ins.run('w3', '/p', 'Edit', 'work', '[]', dayAt(3, 0), null);
    ins.run('w3', '/p', 'Edit', 'work', '[]', dayAt(3, 1), null);
    ins.run('w3', '/p', 'Edit', 'work', '[]', dayAt(3, 2), null);
    ins.run('w3', '/p', 'Edit', 'work', '[]', dayAt(3, 3), null);
    // import tool — must be excluded
    ins.run('w3', '/p', 'git-commit', 'imported', '[]', dayAt(3, 4), null);
  });

  after(() => {
    pdb?.close();
    try { unlinkSync(PDB_PATH); } catch {}
  });

  it('buckets into 3 ascending weeks, excludes import tools', () => {
    const res = getPersonalBenchmarks({ weeks: 8, db: pdb });
    assert.equal(res.observations, 10, 'git-commit excluded');
    assert.equal(res.weeks_data.length, 3);
    const ks = res.weeks_data.map(w => w.week);
    assert.deepEqual([...ks].sort(), ks, 'weeks ascending');
    assert.equal(res.weeks_data[2].observations, 4, 'latest week has 4 obs');
  });

  it('reports all benchmark metrics', () => {
    const res = getPersonalBenchmarks({ weeks: 8, db: pdb });
    const keys = res.benchmarks.map(b => b.metric).sort();
    assert.deepEqual(keys, ['active_hours', 'avg_session_obs', 'obs_per_hour', 'observations', 'sessions']);
  });

  it('latest week throughput beats personal average → up trend, positive delta', () => {
    const res = getPersonalBenchmarks({ weeks: 8, db: pdb });
    const tp = res.benchmarks.find(b => b.metric === 'obs_per_hour');
    assert.equal(tp.trend, 'up');
    assert.ok(tp.vs_avg_pct > 0, `vs_avg_pct ${tp.vs_avg_pct}`);
    assert.ok(tp.latest > tp.personal_avg, `latest ${tp.latest} > avg ${tp.personal_avg}`);
    assert.equal(tp.higher_is_better, true);
  });

  it('emits a throughput hint when latest is well above average', () => {
    const res = getPersonalBenchmarks({ weeks: 8, db: pdb });
    assert.ok(res.hints.some(h => /throughput/i.test(h)), `hints: ${JSON.stringify(res.hints)}`);
  });

  it('empty window: no crash, empty data', () => {
    const res = getPersonalBenchmarks({ weeks: 8, project: '/nope', db: pdb });
    assert.equal(res.observations, 0);
    assert.deepEqual(res.weeks_data, []);
    assert.deepEqual(res.hints, []);
    // benchmarks still listed, all zeroed
    assert.equal(res.benchmarks.length, 5);
    assert.ok(res.benchmarks.every(b => b.latest === 0 && b.personal_avg === 0));
  });
});

describe('getWorkflowTemplates (#28 slice 4)', () => {
  let tdb;
  const TDB_PATH = join(TEST_DIR, 'templates.db');

  // Code-type session spine: research → code → debug → review (code dominates by time)
  const codeSession = (ins, sid) => {
    ins.run(sid, '/p', 'Read', 'read src/db.js',      '[]',            at(0),   null); // research
    ins.run(sid, '/p', 'Edit', 'impl feature',        '[]',            at(60),  null); // code
    ins.run(sid, '/p', 'Edit', 'impl more',           '[]',            at(120), null); // code
    ins.run(sid, '/p', 'Bash', 'npm test — 1 fail',   '[]',            at(180), null); // debug
    ins.run(sid, '/p', 'Edit', 'fix guard',           '[]',            at(240), null); // code
    ins.run(sid, '/p', 'Bash', 'gh pr review 12',     '["pr-review"]', at(300), null); // review
  };

  before(() => {
    tdb = new Database(TDB_PATH);
    tdb.exec(`
      CREATE TABLE observations (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id  TEXT NOT NULL,
        project     TEXT NOT NULL,
        tool        TEXT NOT NULL,
        summary     TEXT NOT NULL,
        tags        TEXT NOT NULL DEFAULT '[]',
        created_at  TEXT NOT NULL,
        duration_ms INTEGER
      );
      CREATE TABLE sessions (
        id             TEXT PRIMARY KEY,
        project        TEXT NOT NULL,
        started_at     TEXT NOT NULL,
        friction_score REAL DEFAULT 0
      );
    `);
    const ins = tdb.prepare(`
      INSERT INTO observations (session_id, project, tool, summary, tags, created_at, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    codeSession(ins, 'C1');
    codeSession(ins, 'C2');
    codeSession(ins, 'C3');
    // 'ops' appears in only 1/3 sessions → presence 0.33 < TEMPLATE_PRESENCE → excluded
    ins.run('C1', '/p', 'Bash', 'git push origin main', '[]', at(360), null);

    const sess = tdb.prepare(`INSERT INTO sessions (id, project, started_at, friction_score) VALUES (?, ?, ?, ?)`);
    sess.run('C1', '/p', at(0), 0.6);
    sess.run('C2', '/p', at(0), 0.2);
    sess.run('C3', '/p', at(0), 0.4);
  });

  after(() => {
    tdb?.close();
    try { unlinkSync(TDB_PATH); } catch {}
  });

  it('groups by dominant category and recommends ordered step sequence', () => {
    const res = getWorkflowTemplates({ days: 30, db: tdb });
    assert.equal(res.templates.length, 1, 'only the code type has >= minSessions');
    const t = res.templates[0];
    assert.equal(t.type, 'code');
    assert.equal(t.sessions, 3);
    assert.deepEqual(t.sequence, ['research', 'code', 'debug', 'review'],
      `ordered by first-appearance; got ${JSON.stringify(t.sequence)}`);
  });

  it('excludes categories below TEMPLATE_PRESENCE (ops in 1/3 sessions)', () => {
    const res = getWorkflowTemplates({ days: 30, db: tdb });
    assert.ok(!res.templates[0].sequence.includes('ops'), 'ops appears in only 1/3 sessions');
    assert.ok(res.templates[0].steps.every(s => s.presence >= TEMPLATE_PRESENCE));
  });

  it('averages friction over the type', () => {
    const res = getWorkflowTemplates({ days: 30, db: tdb });
    assert.equal(res.templates[0].avg_friction, 0.4); // (0.6+0.2+0.4)/3
  });

  it('emits an ordered-sequence hint', () => {
    const res = getWorkflowTemplates({ days: 30, db: tdb });
    assert.ok(res.hints.some(h => h.includes('code') && h.includes('→')), `hints: ${JSON.stringify(res.hints)}`);
  });

  it('minSessions filters thin types', () => {
    const res = getWorkflowTemplates({ days: 30, minSessions: 4, db: tdb });
    assert.deepEqual(res.templates, []);
  });

  it('graceful degradation without sessions table → avg_friction null', () => {
    const ndb = new Database(':memory:');
    ndb.exec(`CREATE TABLE observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, project TEXT NOT NULL,
      tool TEXT NOT NULL, summary TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL, duration_ms INTEGER);`);
    const ins = ndb.prepare(`INSERT INTO observations (session_id, project, tool, summary, tags, created_at, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    codeSession(ins, 'C1'); codeSession(ins, 'C2'); codeSession(ins, 'C3');
    const res = getWorkflowTemplates({ days: 30, db: ndb });
    assert.equal(res.templates.length, 1);
    assert.equal(res.templates[0].avg_friction, null);
    ndb.close();
  });

  it('empty window: no crash, empty templates', () => {
    const res = getWorkflowTemplates({ days: 30, project: '/nope', db: tdb });
    assert.equal(res.observations, 0);
    assert.deepEqual(res.templates, []);
    assert.deepEqual(res.hints, []);
  });
});

describe('getBeforeAfter (#28 slice 5)', () => {
  let cdb;
  const CDB_PATH = join(TEST_DIR, 'compare.db');
  const PIVOT = '2026-06-01 12:00:00';
  const pivotMs = Date.parse('2026-06-01T12:00:00Z');
  const fmt = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
  const D = 86400000, S = 1000;

  before(() => {
    cdb = new Database(CDB_PATH);
    cdb.exec(`
      CREATE TABLE observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, project TEXT NOT NULL,
        tool TEXT NOT NULL, summary TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL, duration_ms INTEGER);
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, project TEXT NOT NULL, started_at TEXT NOT NULL, friction_score REAL DEFAULT 0);
      CREATE TABLE insights (
        id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT, alerts TEXT, summary TEXT, created_at TEXT NOT NULL);
    `);
    const ins = cdb.prepare(`INSERT INTO observations (session_id, project, tool, summary, tags, created_at, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    // BEFORE window (session B1): debug-heavy, 3 observations 5 days before pivot
    ins.run('B1', '/p', 'Edit', 'impl',            '[]', fmt(pivotMs - 5 * D),          null);
    ins.run('B1', '/p', 'Bash', 'npm test — fail', '[]', fmt(pivotMs - 5 * D + 120 * S), null);
    ins.run('B1', '/p', 'Bash', 'npm test — fail', '[]', fmt(pivotMs - 5 * D + 240 * S), null);
    // AFTER window (session A1): code-only, 4 observations 2 days after pivot
    for (let i = 0; i < 4; i++) ins.run('A1', '/p', 'Edit', 'impl ' + i, '[]', fmt(pivotMs + 2 * D + i * 120 * S), null);

    const sess = cdb.prepare(`INSERT INTO sessions (id, project, started_at, friction_score) VALUES (?, ?, ?, ?)`);
    sess.run('B1', '/p', fmt(pivotMs - 5 * D), 0.5);
    sess.run('A1', '/p', fmt(pivotMs + 2 * D), 0.2);

    cdb.prepare(`INSERT INTO insights (date, alerts, summary, created_at) VALUES (?, ?, ?, ?)`)
      .run('2026-06-01', '[]', 'rec', PIVOT);
  });

  after(() => {
    cdb?.close();
    try { unlinkSync(CDB_PATH); } catch {}
  });

  it('splits activity at an explicit pivot and counts each window', () => {
    const res = getBeforeAfter({ windowDays: 14, pivot: PIVOT, db: cdb });
    assert.equal(res.pivot_source, 'explicit');
    assert.ok(res.pivot.startsWith('2026-06-01'));
    assert.equal(res.before.observations, 3);
    assert.equal(res.after.observations, 4);
    assert.equal(res.before.sessions, 1);
    assert.equal(res.after.sessions, 1);
  });

  it('marks throughput/observations rising as up (neutral metric)', () => {
    const res = getBeforeAfter({ windowDays: 14, pivot: PIVOT, db: cdb });
    const obs = res.comparison.find(c => c.metric === 'observations');
    assert.equal(obs.before, 3);
    assert.equal(obs.after, 4);
    assert.equal(obs.direction, 'up');
  });

  it('reads friction as improved when it drops (lower_is_better)', () => {
    const res = getBeforeAfter({ windowDays: 14, pivot: PIVOT, db: cdb });
    const fr = res.comparison.find(c => c.metric === 'avg_friction');
    assert.equal(fr.before, 0.5);
    assert.equal(fr.after, 0.2);
    assert.equal(fr.direction, 'improved');
  });

  it('reports category shift: debug share drops after', () => {
    const res = getBeforeAfter({ windowDays: 14, pivot: PIVOT, db: cdb });
    const debug = res.category_shift.find(c => c.category === 'debug');
    assert.ok(debug, 'debug should appear in category_shift');
    assert.ok(debug.delta_pp < 0, `debug share should drop; got ${debug.delta_pp}`);
    assert.equal(debug.after, 0);
  });

  it('defaults pivot to the latest insight when none given', () => {
    const res = getBeforeAfter({ windowDays: 14, db: cdb });
    assert.equal(res.pivot_source, 'latest_insight');
    assert.ok(res.pivot.startsWith('2026-06-01'));
  });

  it('falls back to default pivot without insights table (graceful)', () => {
    const ndb = new Database(':memory:');
    ndb.exec(`CREATE TABLE observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, project TEXT NOT NULL,
      tool TEXT NOT NULL, summary TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL, duration_ms INTEGER);`);
    const res = getBeforeAfter({ windowDays: 7, db: ndb });
    assert.equal(res.pivot_source, 'default');
    assert.equal(res.before.observations, 0);
    assert.equal(res.after.observations, 0);
    assert.deepEqual(res.hints, []);
    ndb.close();
  });

  it('empty windows produce null deltas, no crash', () => {
    const res = getBeforeAfter({ windowDays: 14, pivot: PIVOT, project: '/nope', db: cdb });
    assert.equal(res.before.observations, 0);
    assert.equal(res.after.observations, 0);
    const obs = res.comparison.find(c => c.metric === 'observations');
    assert.equal(obs.direction, 'flat');
    assert.deepEqual(res.category_shift, []);
  });
});
