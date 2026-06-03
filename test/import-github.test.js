/**
 * test/import-github.test.js — pure-helper tests for #23 GitHub importer.
 *
 * No real HTTP — only the classification / importance / tag helpers
 * that decide how GitHub issues and PRs map into observations.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isPullRequest,
  estimateGitHubImportance,
  githubTags,
  githubItemKey,
  importGitHub,
} from '../src/import-github.js';

// ─── isPullRequest ────────────────────────────────────────────────────────

test('isPullRequest — true only when pull_request key present', () => {
  assert.equal(isPullRequest({ pull_request: { url: 'x' } }), true);
  assert.equal(isPullRequest({}), false);
  assert.equal(isPullRequest(null), false);
});

// ─── importance ───────────────────────────────────────────────────────────

test('estimateGitHubImportance — bug label > unlabeled issue', () => {
  const bug  = { labels: [{ name: 'bug' }] };
  const task = { labels: [] };
  assert.ok(estimateGitHubImportance(bug) > estimateGitHubImportance(task));
});

test('estimateGitHubImportance — critical boost, merged PR boost, clamped', () => {
  const critical = { labels: [{ name: 'bug' }, { name: 'P0' }] };
  const bug      = { labels: [{ name: 'bug' }] };
  assert.ok(estimateGitHubImportance(critical) > estimateGitHubImportance(bug));

  const mergedPr = { pull_request: { merged_at: '2026-06-01T00:00:00Z' }, labels: [] };
  const openPr   = { pull_request: { merged_at: null }, labels: [] };
  assert.ok(estimateGitHubImportance(mergedPr) > estimateGitHubImportance(openPr));

  const hi = estimateGitHubImportance(critical);
  assert.ok(hi >= 0.1 && hi <= 0.95);
});

test('estimateGitHubImportance — tolerates string labels and missing fields', () => {
  assert.ok(estimateGitHubImportance({ labels: ['bug'] }) > estimateGitHubImportance({}));
  const v = estimateGitHubImportance(undefined);
  assert.ok(v >= 0.1 && v <= 0.95);
});

// ─── tags ─────────────────────────────────────────────────────────────────

test('githubTags — issue tags include kind, status, labels', () => {
  const item = {
    state: 'open',
    labels: [{ name: 'Bug' }, { name: 'good first issue' }],
  };
  const tags = githubTags(item);
  assert.ok(tags.includes('github'));
  assert.ok(tags.includes('import'));
  assert.ok(tags.includes('issue'));
  assert.ok(tags.includes('status:open'));
  assert.ok(tags.includes('label:bug'));
  assert.ok(tags.includes('label:good-first-issue'));
});

test('githubTags — merged PR gets pr kind + merged status', () => {
  const pr = {
    state: 'closed',
    pull_request: { merged_at: '2026-06-01T00:00:00Z' },
    labels: [],
  };
  const tags = githubTags(pr);
  assert.ok(tags.includes('pr'));
  assert.ok(tags.includes('status:closed'));
  assert.ok(tags.includes('status:merged'));
});

test('githubTags — tolerates missing fields', () => {
  assert.deepEqual(githubTags({}), ['github', 'import', 'issue']);
});

// ─── idempotency key ──────────────────────────────────────────────────────

test('githubItemKey — stable owner/repo#number format', () => {
  assert.equal(githubItemKey('leetio-varsha/claudeye', { number: 23 }), 'leetio-varsha/claudeye#23');
});

// ─── input validation ─────────────────────────────────────────────────────

test('importGitHub — rejects missing cfg and malformed repo', async () => {
  await assert.rejects(() => importGitHub({}), /repo and token are required/);
  await assert.rejects(() => importGitHub({ repo: 'not-a-repo', token: 'x' }), /owner\/name/);
});
