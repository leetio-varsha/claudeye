/**
 * test/auto-issues.test.js — Tests for auto-issue creation logic
 *
 * Tests: deduplication, issue formatting, trend detection logic.
 * Does NOT call GitHub API.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ─── Deduplication logic (extracted from auto-issues.js) ────────────────

function isDuplicate(issue, existingIssues) {
  const titleLower = issue.title.toLowerCase();
  for (const existing of existingIssues) {
    const existingLower = existing.title.toLowerCase();
    if (existingLower === titleLower) return true;
    if (existingLower.includes('[auto]') && titleLower.includes('[auto]')) {
      const coreA = titleLower.replace('[auto] ', '').split(':')[0];
      const coreB = existingLower.replace('[auto] ', '').split(':')[0];
      if (coreA === coreB) return true;
    }
  }
  return false;
}

describe('Issue Deduplication', () => {
  const existing = [
    { title: '[auto] auth.service.ts: hotspot score 0.37', number: 42 },
    { title: '[auto] monorepo: friction растёт 3 дня подряд (+0.05)', number: 43 },
    { title: 'Manual issue about performance', number: 44 },
  ];

  it('detects exact duplicate', () => {
    assert.ok(isDuplicate(
      { title: '[auto] auth.service.ts: hotspot score 0.37' },
      existing
    ));
  });

  it('detects same-prefix duplicate with different details', () => {
    assert.ok(isDuplicate(
      { title: '[auto] auth.service.ts: hotspot score 0.45' },
      existing
    ));
  });

  it('does not flag unrelated auto issue', () => {
    assert.ok(!isDuplicate(
      { title: '[auto] db.service.ts: hotspot score 0.5' },
      existing
    ));
  });

  it('does not flag manual issues as duplicates of auto issues', () => {
    assert.ok(!isDuplicate(
      { title: '[auto] performance optimization needed' },
      existing
    ));
  });

  it('handles case insensitivity', () => {
    assert.ok(isDuplicate(
      { title: '[AUTO] Auth.Service.ts: hotspot score 0.37' },
      existing
    ));
  });

  it('handles empty existing list', () => {
    assert.ok(!isDuplicate({ title: '[auto] new issue' }, []));
  });
});

// ─── Issue formatting (patternToIssue logic) ────────────────────────────

function patternToIssue(finding) {
  const categoryLabels = {
    'repeat-fix': 'tech-debt',
    'hotspot': 'performance',
    'time-sink': 'improvement',
    'friction-trend': 'monitoring',
    'tool-friction': 'improvement',
  };

  const severityEmoji = { high: '🔴', medium: '🟡', low: '🟢' };

  let body = `**Категория:** ${finding.category}\n`;
  body += `**Серьёзность:** ${severityEmoji[finding.severity] || '•'} ${finding.severity}\n`;
  body += `**Проект:** ${finding.project}\n\n`;
  body += `## Описание\n\n${finding.description}\n\n`;
  body += `## Рекомендация\n\n${finding.action}\n\n`;

  return {
    title: `[auto] ${finding.title}`,
    body,
    labels: [categoryLabels[finding.category] || 'improvement'].filter(Boolean),
    priority: finding.severity,
  };
}

describe('Issue Formatting', () => {
  it('formats hotspot finding correctly', () => {
    const issue = patternToIssue({
      category: 'hotspot',
      severity: 'high',
      title: 'auth.service.ts: hotspot score 0.37',
      description: 'File edited 28 times with errors',
      project: 'astrosphere',
      action: 'Refactor this module',
    });
    assert.match(issue.title, /\[auto\]/);
    assert.match(issue.body, /Категория.*hotspot/);
    assert.match(issue.body, /🔴 high/);
    assert.deepEqual(issue.labels, ['performance']);
  });

  it('formats friction-trend finding', () => {
    const issue = patternToIssue({
      category: 'friction-trend',
      severity: 'medium',
      title: 'monorepo: friction rising',
      description: 'Friction increased for 3 days',
      project: 'monorepo',
      action: 'Investigate recent changes',
    });
    assert.deepEqual(issue.labels, ['monitoring']);
    assert.match(issue.body, /🟡 medium/);
  });

  it('handles unknown category gracefully', () => {
    const issue = patternToIssue({
      category: 'unknown-category',
      severity: 'low',
      title: 'test',
      description: 'desc',
      project: 'proj',
      action: 'act',
    });
    assert.deepEqual(issue.labels, ['improvement']);
  });
});

// ─── Friction trend detection logic ─────────────────────────────────────

function isRisingTrend(days) {
  if (days.length < 3) return false;
  const recent = days.slice(-3);
  return recent[0].friction < recent[1].friction && recent[1].friction < recent[2].friction;
}

// ─── Local DB dedup + persistence (#83) ─────────────────────────────────

describe('Auto-Issues Local DB persistence (#83)', () => {
  const TEST_DIR = join(tmpdir(), 'claudeye-auto-issues-' + Date.now());
  const TEST_DB  = join(TEST_DIR, 'test.db');
  let db;

  before(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    db = new Database(TEST_DB);
    // Mirror production schema for `issues` (see src/db.js:_migrateAnalytics)
    db.exec(`
      CREATE TABLE IF NOT EXISTS issues (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        project       TEXT    NOT NULL,
        title         TEXT    NOT NULL,
        status        TEXT    NOT NULL DEFAULT 'open',
        opened_at     TEXT    NOT NULL DEFAULT (datetime('now')),
        resolved_at   TEXT,
        session_ids   TEXT    NOT NULL DEFAULT '[]',
        obs_ids       TEXT    NOT NULL DEFAULT '[]',
        complexity    REAL,
        resolution_ms INTEGER,
        gh_issue_number INTEGER,
        gh_repo         TEXT,
        source          TEXT DEFAULT 'advisor',
        category        TEXT
      );
    `);
  });

  after(() => {
    db.close();
    try { unlinkSync(TEST_DB); } catch {}
  });

  // Inline helpers mirroring db.js (avoid importing singleton which binds to ~/.claudeye/mem.db)
  function saveAutoIssue(opts) {
    return db.prepare(`
      INSERT INTO issues (project, title, status, session_ids, obs_ids, complexity, gh_issue_number, gh_repo, source, category)
      VALUES (?, ?, 'open', ?, ?, ?, ?, ?, ?, ?)
    `).run(
      opts.project,
      opts.title.slice(0, 300),
      JSON.stringify(opts.sessionIds || []),
      JSON.stringify(opts.obsIds || []),
      opts.complexity ?? null,
      opts.ghIssueNumber ?? null,
      opts.ghRepo ?? null,
      opts.source || 'auto-issues',
      opts.category ?? null,
    ).lastInsertRowid;
  }

  function findRecentIssueByTitle({ project, title, days = 7 }) {
    const core = title.toLowerCase().replace(/^\[auto\]\s*/, '').split(':')[0].trim();
    if (!core) return null;
    return db.prepare(`
      SELECT id, gh_issue_number, opened_at, title, status
      FROM issues
      WHERE project = ?
        AND opened_at >= datetime('now', '-' || ? || ' days')
        AND (LOWER(title) = ? OR LOWER(title) LIKE ?)
      ORDER BY opened_at DESC
      LIMIT 1
    `).get(project, days, title.toLowerCase(), `%${core}%`) || null;
  }

  it('saves auto-issue with gh_issue_number, source and category', () => {
    const id = saveAutoIssue({
      project:       'astrosphere',
      title:         '[auto] auth.service.ts: hotspot score 0.37',
      ghIssueNumber: 42,
      ghRepo:        'leetio-varsha/claudeye',
      category:      'hotspot',
      sessionIds:    ['sess-a', 'sess-b'],
      obsIds:        [1, 2, 3],
      complexity:    0.37,
      source:        'auto-issues',
    });
    assert.ok(id > 0);

    const row = db.prepare('SELECT * FROM issues WHERE id = ?').get(id);
    assert.equal(row.project, 'astrosphere');
    assert.equal(row.gh_issue_number, 42);
    assert.equal(row.gh_repo, 'leetio-varsha/claudeye');
    assert.equal(row.category, 'hotspot');
    assert.equal(row.source, 'auto-issues');
    assert.equal(row.status, 'open');
    assert.deepEqual(JSON.parse(row.session_ids), ['sess-a', 'sess-b']);
    assert.deepEqual(JSON.parse(row.obs_ids), [1, 2, 3]);
  });

  it('findRecentIssueByTitle finds exact-title match within window', () => {
    const hit = findRecentIssueByTitle({
      project: 'astrosphere',
      title:   '[auto] auth.service.ts: hotspot score 0.37',
      days:    7,
    });
    assert.ok(hit);
    assert.equal(hit.gh_issue_number, 42);
  });

  it('findRecentIssueByTitle finds same-prefix fuzzy match', () => {
    // same core (auth.service.ts), different score
    const hit = findRecentIssueByTitle({
      project: 'astrosphere',
      title:   '[auto] auth.service.ts: hotspot score 0.99',
      days:    7,
    });
    assert.ok(hit);
    assert.equal(hit.gh_issue_number, 42);
  });

  it('findRecentIssueByTitle ignores different project', () => {
    const miss = findRecentIssueByTitle({
      project: 'other-project',
      title:   '[auto] auth.service.ts: hotspot score 0.37',
      days:    7,
    });
    assert.equal(miss, null);
  });

  it('findRecentIssueByTitle ignores issues outside window', () => {
    // Insert one with old opened_at
    db.prepare(`
      INSERT INTO issues (project, title, status, opened_at, session_ids, obs_ids, source, gh_issue_number)
      VALUES ('astrosphere', '[auto] old-stuff: hotspot score 0.1', 'open', datetime('now', '-30 days'), '[]', '[]', 'auto-issues', 99)
    `).run();
    const miss = findRecentIssueByTitle({
      project: 'astrosphere',
      title:   '[auto] old-stuff: hotspot score 0.2',
      days:    7,
    });
    assert.equal(miss, null);
  });
});

describe('Friction Trend Detection', () => {
  it('detects 3-day rising trend', () => {
    assert.ok(isRisingTrend([
      { day: '2026-04-10', friction: 0.10 },
      { day: '2026-04-11', friction: 0.12 },
      { day: '2026-04-12', friction: 0.15 },
    ]));
  });

  it('does not flag flat trend', () => {
    assert.ok(!isRisingTrend([
      { day: '2026-04-10', friction: 0.12 },
      { day: '2026-04-11', friction: 0.12 },
      { day: '2026-04-12', friction: 0.12 },
    ]));
  });

  it('does not flag declining trend', () => {
    assert.ok(!isRisingTrend([
      { day: '2026-04-10', friction: 0.15 },
      { day: '2026-04-11', friction: 0.12 },
      { day: '2026-04-12', friction: 0.10 },
    ]));
  });

  it('handles fewer than 3 data points', () => {
    assert.ok(!isRisingTrend([
      { day: '2026-04-11', friction: 0.10 },
      { day: '2026-04-12', friction: 0.15 },
    ]));
  });

  it('only checks last 3 days of longer series', () => {
    assert.ok(isRisingTrend([
      { day: '2026-04-08', friction: 0.20 }, // declining
      { day: '2026-04-09', friction: 0.15 }, // declining
      { day: '2026-04-10', friction: 0.10 }, // then rising
      { day: '2026-04-11', friction: 0.12 },
      { day: '2026-04-12', friction: 0.15 },
    ]));
  });
});
