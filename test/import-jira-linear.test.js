/**
 * test/import-jira-linear.test.js — pure-helper tests for #10 importers.
 *
 * We don't exercise real HTTP here — just the extraction / importance / tag
 * helpers that decide how Jira + Linear records map into observations.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  adfToText,
  estimateIssueImportance,
  issueTags,
} from '../src/import-jira.js';

import {
  linearPriorityBoost,
  estimateLinearIssueImportance,
  linearIssueTags,
} from '../src/import-linear.js';

// ─── Jira ADF extraction ──────────────────────────────────────────────────

test('adfToText — flattens nested Atlassian Document Format to plain text', () => {
  const adf = {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Hello ' }, { type: 'text', text: 'world' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'line 2' }] },
    ],
  };
  const out = adfToText(adf);
  assert.match(out, /Hello world/);
  assert.match(out, /line 2/);
});

test('adfToText — handles null / undefined / empty input', () => {
  assert.equal(adfToText(null), '');
  assert.equal(adfToText(undefined), '');
  assert.equal(adfToText({ type: 'doc', content: [] }), '');
});

test('adfToText — caps output at maxChars', () => {
  const big = { type: 'paragraph', content: [{ type: 'text', text: 'x'.repeat(5000) }] };
  assert.equal(adfToText(big, 500).length, 500);
});

// ─── Jira importance / tags ───────────────────────────────────────────────

test('estimateIssueImportance — bug + highest priority > regular task', () => {
  const bug = {
    fields: { issuetype: { name: 'Bug' }, priority: { name: 'Highest' } },
  };
  const task = {
    fields: { issuetype: { name: 'Task' }, priority: { name: 'Medium' } },
  };
  assert.ok(estimateIssueImportance(bug) > estimateIssueImportance(task));
});

test('estimateIssueImportance — clamped within [0.1, 0.95]', () => {
  const huge = {
    fields: { issuetype: { name: 'Epic' }, priority: { name: 'Blocker' } },
  };
  const low = {
    fields: { issuetype: { name: 'Chore' }, priority: { name: 'Low' } },
  };
  const hi = estimateIssueImportance(huge);
  const lo = estimateIssueImportance(low);
  assert.ok(hi <= 0.95 && hi >= 0.1);
  assert.ok(lo <= 0.95 && lo >= 0.1);
});

test('issueTags — includes core jira/import/issue tags plus metadata', () => {
  const issue = {
    fields: {
      status: { name: 'In Progress' },
      issuetype: { name: 'Bug' },
      priority: { name: 'High' },
      labels: ['backend', 'urgent'],
    },
  };
  const tags = issueTags(issue);
  assert.ok(tags.includes('jira'));
  assert.ok(tags.includes('import'));
  assert.ok(tags.includes('issue'));
  assert.ok(tags.includes('status:in-progress'));
  assert.ok(tags.includes('type:bug'));
  assert.ok(tags.includes('priority:high'));
  assert.ok(tags.includes('label:backend'));
  assert.ok(tags.includes('label:urgent'));
});

test('issueTags — tolerates missing fields', () => {
  const tags = issueTags({ fields: {} });
  assert.deepEqual(tags, ['jira', 'import', 'issue']);
});

// ─── Linear priority / importance ─────────────────────────────────────────

test('linearPriorityBoost — urgent > high > medium > low', () => {
  assert.ok(linearPriorityBoost(1) > linearPriorityBoost(2));
  assert.ok(linearPriorityBoost(2) > linearPriorityBoost(3));
  assert.ok(linearPriorityBoost(3) > linearPriorityBoost(4));
});

test('estimateLinearIssueImportance — bug label boosts above default', () => {
  const bug = {
    state: { type: 'started' },
    priority: 2,
    labels: { nodes: [{ name: 'Bug' }] },
  };
  const task = {
    state: { type: 'started' },
    priority: 3,
    labels: { nodes: [] },
  };
  assert.ok(estimateLinearIssueImportance(bug) > estimateLinearIssueImportance(task));
});

test('estimateLinearIssueImportance — canceled issues are down-weighted', () => {
  const cancelled = {
    state: { type: 'canceled' },
    priority: 3,
    labels: { nodes: [] },
  };
  const active = {
    state: { type: 'started' },
    priority: 3,
    labels: { nodes: [] },
  };
  assert.ok(estimateLinearIssueImportance(cancelled) < estimateLinearIssueImportance(active));
});

test('linearIssueTags — collects status, team, priority, labels', () => {
  const issue = {
    state: { name: 'In Review' },
    team:  { key: 'ENG' },
    priority: 2,
    labels: { nodes: [{ name: 'Bug' }, { name: 'Backend' }] },
  };
  const tags = linearIssueTags(issue);
  assert.ok(tags.includes('linear'));
  assert.ok(tags.includes('import'));
  assert.ok(tags.includes('issue'));
  assert.ok(tags.includes('status:in-review'));
  assert.ok(tags.includes('team:eng'));
  assert.ok(tags.includes('priority:2'));
  assert.ok(tags.includes('label:bug'));
  assert.ok(tags.includes('label:backend'));
});
