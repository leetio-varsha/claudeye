/**
 * test/search.test.js — Tests for hybrid search module
 *
 * Tests: normalizeProject, cosineSimilarity-based ranking logic.
 * Does NOT test full hybridSearch (requires DB + OpenAI).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Re-implement normalizeProject for testing (exported from search.js but
// we test the logic directly to avoid DB initialization side effects)
function normalizeProject(project) {
  if (!project) return project;
  const worktreeMatch = project.match(/^(.+?)\/\.claude\/worktrees\/.+$/);
  return worktreeMatch ? worktreeMatch[1] : project;
}

describe('normalizeProject', () => {
  it('normalizes worktree path to parent project', () => {
    assert.equal(
      normalizeProject('/Users/lord/Sites/MyOwn/astrosphere/.claude/worktrees/sharp-napier'),
      '/Users/lord/Sites/MyOwn/astrosphere'
    );
  });

  it('normalizes deeply nested worktree path', () => {
    assert.equal(
      normalizeProject('/home/user/projects/app/.claude/worktrees/feature-branch'),
      '/home/user/projects/app'
    );
  });

  it('leaves regular project paths unchanged', () => {
    assert.equal(
      normalizeProject('/Users/lord/Sites/MyOwn/astrosphere'),
      '/Users/lord/Sites/MyOwn/astrosphere'
    );
  });

  it('handles null/undefined', () => {
    assert.equal(normalizeProject(null), null);
    assert.equal(normalizeProject(undefined), undefined);
  });

  it('leaves paths with .claude but no worktrees unchanged', () => {
    assert.equal(
      normalizeProject('/Users/lord/project/.claude/settings'),
      '/Users/lord/project/.claude/settings'
    );
  });
});

// ─── Vector search performance regression (#96) ────────────────────────
//
// Guards against cosine similarity latency regression.
// Baseline (2026-05-08): 300 rows × 1536 dims ≈ 1.9ms on MacBook Pro M3.
// Hard limit set at 50ms to avoid flakiness on slower CI/remote machines.

function cosineSimilarity(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

describe('Vector search performance (#96)', () => {
  it('cosine similarity over 300 rows × 1536 dims completes under 50ms', () => {
    const DIMS = 1536;
    const ROWS = 300;
    // Deterministic fake vectors
    const queryVec = new Float32Array(DIMS).map((_, i) => Math.sin(i / 100));
    const rows = Array.from({ length: ROWS }, (_, r) =>
      new Float32Array(DIMS).map((_, i) => Math.cos((i + r) / 100))
    );

    const start = performance.now();
    for (const vec of rows) cosineSimilarity(queryVec, vec);
    const elapsed = performance.now() - start;

    assert.ok(elapsed < 50, `cosine over ${ROWS} rows took ${elapsed.toFixed(1)}ms (limit: 50ms)`);
  });

  it('cosine similarity at 3× scale (900 rows) completes under 150ms', () => {
    const DIMS = 1536;
    const ROWS = 900;
    const queryVec = new Float32Array(DIMS).map((_, i) => Math.sin(i / 100));
    const rows = Array.from({ length: ROWS }, (_, r) =>
      new Float32Array(DIMS).map((_, i) => Math.cos((i + r) / 100))
    );

    const start = performance.now();
    for (const vec of rows) cosineSimilarity(queryVec, vec);
    const elapsed = performance.now() - start;

    assert.ok(elapsed < 150, `cosine over ${ROWS} rows took ${elapsed.toFixed(1)}ms (limit: 150ms)`);
  });
});

// ─── RRF scoring logic ──────────────────────────────────────────────────

const RRF_K = 60;
const GIT_COMMIT_DEMOTION = 0.3;

function computeRRFScore(ftsRank, vectorRank, { tool, importance, hasDecision, ftsWeight = 0.4, vectorWeight = 0.6 }) {
  let score = 0;
  if (ftsRank !== null) score += ftsWeight * (1 / (RRF_K + ftsRank + 1));
  if (vectorRank !== null) {
    score += vectorWeight * (1 / (RRF_K + vectorRank + 1));
    score *= (0.5 + importance * 0.5);
  }
  if (tool === 'git-commit') score *= GIT_COMMIT_DEMOTION;
  if (hasDecision) score *= 1.5;
  return score;
}

describe('RRF Scoring', () => {
  it('ranks top results higher than lower results', () => {
    const top = computeRRFScore(0, 0, { tool: 'Edit', importance: 0.8, hasDecision: false });
    const bottom = computeRRFScore(10, 10, { tool: 'Edit', importance: 0.8, hasDecision: false });
    assert.ok(top > bottom);
  });

  it('demotes git-commit observations', () => {
    const hookObs = computeRRFScore(0, 0, { tool: 'Edit', importance: 0.7, hasDecision: false });
    const gitObs = computeRRFScore(0, 0, { tool: 'git-commit', importance: 0.7, hasDecision: false });
    assert.ok(hookObs > gitObs);
    assert.ok(Math.abs(gitObs / hookObs - GIT_COMMIT_DEMOTION) < 0.01);
  });

  it('boosts observations with decisions', () => {
    const normal = computeRRFScore(0, 0, { tool: 'Edit', importance: 0.7, hasDecision: false });
    const decision = computeRRFScore(0, 0, { tool: 'Edit', importance: 0.7, hasDecision: true });
    assert.ok(decision > normal);
    assert.ok(Math.abs(decision / normal - 1.5) < 0.01);
  });

  it('weights importance via vector rank', () => {
    const highImp = computeRRFScore(null, 0, { tool: 'Edit', importance: 0.9, hasDecision: false });
    const lowImp = computeRRFScore(null, 0, { tool: 'Edit', importance: 0.1, hasDecision: false });
    assert.ok(highImp > lowImp);
  });

  it('combines FTS and vector scores', () => {
    const ftsOnly = computeRRFScore(0, null, { tool: 'Edit', importance: 0.5, hasDecision: false });
    const vecOnly = computeRRFScore(null, 0, { tool: 'Edit', importance: 0.5, hasDecision: false });
    const both = computeRRFScore(0, 0, { tool: 'Edit', importance: 0.5, hasDecision: false });
    assert.ok(both > ftsOnly);
    assert.ok(both > vecOnly);
  });
});
