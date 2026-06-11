/**
 * test/agent-daemon-noop.test.js — no-op auto-resolve for daemon heartbeats (#115)
 *
 * Context: by 2026-06-10 the review queue held 278 pending actions — 100% of
 * them daemon heartbeats ("0 new sessions", "no anomaly"). A human cannot give
 * a meaningful verdict to a no-op, so they must never enter the queue.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { isNoopResult } from '../src/agent-daemon.js';

describe('isNoopResult (#115 queue noise)', () => {
  it('session-analysis with 0/0 → noop', () => {
    assert.equal(isNoopResult('session-analysis', { new_sessions: 0, new_observations: 0 }), true);
  });

  it('session-analysis with activity → NOT noop', () => {
    assert.equal(isNoopResult('session-analysis', { new_sessions: 2, new_observations: 41 }), false);
    assert.equal(isNoopResult('session-analysis', { new_sessions: 0, new_observations: 3 }), false);
  });

  it('db-growth-alert without anomaly → noop, with anomaly → NOT noop', () => {
    assert.equal(isNoopResult('db-growth-alert', { size_mb: 281, anomaly: false }), true);
    assert.equal(isNoopResult('db-growth-alert', { size_mb: 281, anomaly: null }), true);
    assert.equal(isNoopResult('db-growth-alert', { size_mb: 281, anomaly: true }), false);
  });

  it('auto-archive skipped → noop, performed → NOT noop', () => {
    assert.equal(isNoopResult('auto-archive', { skipped: true, reason: 'below_threshold' }), true);
    assert.equal(isNoopResult('auto-archive', { archived: 1200, size_mb_before: 260 }), false);
  });

  it('errors and unknown actions are never noop (deserve eyes)', () => {
    assert.equal(isNoopResult('session-analysis', { error: 'boom' }), false);
    assert.equal(isNoopResult('session-analysis', null), false);
    assert.equal(isNoopResult('something-new', { whatever: 1 }), false);
  });
});
