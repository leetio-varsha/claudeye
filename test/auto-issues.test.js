/**
 * test/auto-issues.test.js — Tests for auto-issue creation logic
 *
 * Tests: deduplication, issue formatting, trend detection logic.
 * Does NOT call GitHub API.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

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
