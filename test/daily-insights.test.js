/**
 * test/daily-insights.test.js — Tests for daily-insights helpers (#113, #114)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractFilePath } from '../scripts/daily-insights.js';

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
