/**
 * test/daily-insights.test.js — Tests for daily-insights helpers (#113, #114)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractFilePath, percentile, detectHookSilence } from '../scripts/daily-insights.js';

const TH = { HOOK_SILENCE_HOURS: 72, HOOK_SILENCE_CRITICAL_HOURS: 168 };

// ─── extractFilePath (#113) ──────────────────────────────────────────────

test('extractFilePath: plain path (json_extract succeeded)', () => {
  assert.equal(
    extractFilePath('/Users/lord/Documents/Claude/Projects/Claudeye/claudeye/src/db.js'),
    '/Users/lord/Documents/Claude/Projects/Claudeye/claudeye/src/db.js'
  );
});

test('extractFilePath: plain path with spaces (Application Support)', () => {
  const p = '/Users/lord/Library/Application Support/Claude/config.json';
  assert.equal(extractFilePath(p), p);
});

test('extractFilePath: JSON prefix with file_path key', () => {
  const hint = '{"replace_all":false,"file_path":"/Users/lord/src/app.js","old_string":"x"';
  assert.equal(extractFilePath(hint), '/Users/lord/src/app.js');
});

test('extractFilePath: JSON prefix, file_path with spaces', () => {
  const hint = '{"replace_all":false,"file_path":"/Users/lord/Library/Application Support/Claude/settings.json","old_str';
  assert.equal(
    extractFilePath(hint),
    '/Users/lord/Library/Application Support/Claude/settings.json'
  );
});

test('extractFilePath: truncated JSON without closing quote — regex fallback', () => {
  const hint = '{"content":"...","path_like":"none"} /tmp/some dir/file.txt trailing';
  assert.equal(extractFilePath(hint), '/tmp/some dir/file.txt');
});

test('extractFilePath: no path at all returns null', () => {
  assert.equal(extractFilePath('{"command":"echo hello"}'), null);
  assert.equal(extractFilePath(''), null);
  assert.equal(extractFilePath(null), null);
});

test('extractFilePath: short name = last 2 segments (consumer contract)', () => {
  const p = extractFilePath('{"file_path":"/Users/lord/Library/Application Support/Claude/db/mem.db"}');
  const short = p.split('/').filter(Boolean).slice(-2).join('/');
  assert.equal(short, 'db/mem.db');
});

// ─── percentile (#123) ────────────────────────────────────────────────────
test('percentile: empty input returns 0', () => {
  assert.equal(percentile([], 90), 0);
  assert.equal(percentile(undefined, 90), 0);
});

test('percentile: p90 of 1..10 = 9', () => {
  assert.equal(percentile([1,2,3,4,5,6,7,8,9,10], 90), 9);
});

test('percentile: unsorted input is handled', () => {
  assert.equal(percentile([10,1,5,3,8], 100), 10);
});

// ─── detectHookSilence (#123) ─────────────────────────────────────────────
test('detectHookSilence: below floor → null (no alert)', () => {
  // Weekend idle: 47h gap, well under the 72h floor — the recurring FALSE-RED.
  assert.equal(detectHookSilence({ hoursSince: 47, typicalGapHours: 12, thresholds: TH }), null);
});

test('detectHookSilence: above floor but within user idle rhythm → null', () => {
  // 80h gap, but this user's p90 idle is 60h → idleBand=90h → not anomalous.
  assert.equal(detectHookSilence({ hoursSince: 80, typicalGapHours: 60, thresholds: TH }), null);
});

test('detectHookSilence: above floor and anomalous for user → warning', () => {
  // 100h gap, user p90 idle only 10h → idleBand=72h → anomalous but < 1 week.
  const r = detectHookSilence({ hoursSince: 100, typicalGapHours: 10, thresholds: TH });
  assert.deepEqual(r, { severity: 'warning', hoursSince: 100 });
});

test('detectHookSilence: ≥ critical horizon AND whole pipeline dark → critical', () => {
  // No pipelineGapHours (unknown) → treated as not-alive → real outage.
  const r = detectHookSilence({ hoursSince: 200, typicalGapHours: 999, thresholds: TH });
  assert.deepEqual(r, { severity: 'critical', hoursSince: 200 });
});

test('detectHookSilence: live-hooks dark 10d but pipeline alive → warning, NOT critical', () => {
  // The exact host scenario: only automated git-import rows for 10 days, but the
  // import/daemon pipeline showed activity ~72h ago → infra fine, user just idle.
  const r = detectHookSilence({ hoursSince: 245, typicalGapHours: 1, pipelineGapHours: 72, thresholds: TH });
  assert.deepEqual(r, { severity: 'warning', hoursSince: 245 });
});

test('detectHookSilence: live-hooks AND pipeline both dark ≥1wk → critical', () => {
  const r = detectHookSilence({ hoursSince: 245, typicalGapHours: 1, pipelineGapHours: 245, thresholds: TH });
  assert.deepEqual(r, { severity: 'critical', hoursSince: 245 });
});

test('detectHookSilence: missing typicalGapHours defaults to floor band', () => {
  // No history → idleBand = floor (72). 73h is just over → warning.
  const r = detectHookSilence({ hoursSince: 73, thresholds: TH });
  assert.deepEqual(r, { severity: 'warning', hoursSince: 73 });
});
