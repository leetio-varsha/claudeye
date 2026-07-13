/**
 * test/scheduler-status.test.js — unified scheduler status (#133)
 *
 * Covers the aggregation + formatting layer that `claudeye scheduler status`
 * and the Desktop app (Rust cmd_agents_status) both depend on. No DB access,
 * so this suite runs even where the native SQLite module cannot load.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SCHEDULERS,
  collectSchedulerStatus,
  formatSchedulerStatus,
} from '../scripts/scheduler-status.js';

// ─── registry ──────────────────────────────────────────────────────────────

test('SCHEDULERS: covers all three launchd agents in order', () => {
  assert.deepEqual(SCHEDULERS.map(s => s.key), ['insights', 'digest', 'daemon']);
  for (const s of SCHEDULERS) {
    assert.ok(s.name && s.schedule && s.module, `scheduler ${s.key} fully described`);
  }
});

// ─── collectSchedulerStatus ──────────────────────────────────────────────────

test('collectSchedulerStatus: returns one normalized entry per scheduler', async () => {
  const list = await collectSchedulerStatus();
  assert.equal(list.length, SCHEDULERS.length);
  for (const s of list) {
    // Shape is normalized regardless of host state (no plists on CI → not installed).
    assert.equal(typeof s.installed, 'boolean');
    assert.equal(typeof s.loaded, 'boolean');
    assert.ok('key' in s && 'name' in s && 'schedule' in s && 'plist' in s);
    // loaded must never be true without installed.
    if (s.loaded) assert.equal(s.installed, true);
  }
});

// ─── formatSchedulerStatus ───────────────────────────────────────────────────

const SAMPLE = [
  { key: 'insights', name: 'Daily insights', schedule: 'daily 09:00', installed: true,  loaded: true,  plist: '/x/a.plist' },
  { key: 'digest',   name: 'Weekly digest',  schedule: 'weekly (Mon)', installed: true,  loaded: false, plist: '/x/b.plist' },
  { key: 'daemon',   name: 'Agent daemon',   schedule: 'hourly',       installed: false, loaded: false, plist: null },
];

test('formatSchedulerStatus: renders each state and a running count', () => {
  const out = formatSchedulerStatus(SAMPLE);
  assert.match(out, /Daily insights\s+running/);
  assert.match(out, /Weekly digest\s+installed \(not loaded\)/);
  assert.match(out, /Agent daemon\s+not scheduled/);
  assert.match(out, /1\/3 schedulers running/);
});

test('formatSchedulerStatus: plain output has no ANSI escapes by default', () => {
  const out = formatSchedulerStatus(SAMPLE);
  // eslint-disable-next-line no-control-regex
  assert.doesNotMatch(out, /\[/);
});

test('formatSchedulerStatus: color mode uses the provided chalk instance', () => {
  const tag = (kind) => (s) => `<${kind}>${s}</${kind}>`;
  const fakeChalk = { green: tag('g'), yellow: tag('y'), red: tag('r'), gray: tag('d') };
  const out = formatSchedulerStatus(SAMPLE, { color: true, chalk: fakeChalk });
  assert.match(out, /<g>running<\/g>/);
  assert.match(out, /<y>installed \(not loaded\)<\/y>/);
  assert.match(out, /<r>not scheduled<\/r>/);
});

test('formatSchedulerStatus: all-running reports full count', () => {
  const allOn = SAMPLE.map(s => ({ ...s, installed: true, loaded: true }));
  assert.match(formatSchedulerStatus(allOn), /3\/3 schedulers running/);
});
