/**
 * test/import-slack.test.js — pure-helper tests for #23 Slack importer.
 *
 * No real HTTP — only noise filtering / importance / tags / thread rendering
 * that decide how Slack messages map into observations.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isNoiseMessage,
  estimateSlackImportance,
  slackTags,
  slackMessageKey,
  threadToContent,
  importSlack,
} from '../src/import-slack.js';

const LONG = 'Решили перейти на better-sqlite3 вместо node-sqlite3 — синхронный API быстрее для хуков.';

// ─── isNoiseMessage ───────────────────────────────────────────────────────

test('isNoiseMessage: system subtypes are noise', () => {
  assert.equal(isNoiseMessage({ subtype: 'channel_join', text: 'X has joined', ts: '1' }), true);
});

test('isNoiseMessage: empty and missing text are noise', () => {
  assert.equal(isNoiseMessage({ text: '   ', ts: '1' }), true);
  assert.equal(isNoiseMessage({ ts: '1' }), true);
  assert.equal(isNoiseMessage(null), true);
});

test('isNoiseMessage: short standalone message is noise', () => {
  assert.equal(isNoiseMessage({ text: 'ok thanks', ts: '1' }), true);
});

test('isNoiseMessage: short THREAD PARENT is kept (replies may hold the решение)', () => {
  const msg = { text: 'deploy сломался?', ts: '10', thread_ts: '10', reply_count: 5 };
  assert.equal(isNoiseMessage(msg), false);
});

test('isNoiseMessage: substantive message is kept', () => {
  assert.equal(isNoiseMessage({ text: LONG, ts: '1' }), false);
});

// ─── estimateSlackImportance ──────────────────────────────────────────────

test('importance: thread > standalone message', () => {
  const thread = estimateSlackImportance({ text: LONG, reply_count: 5 });
  const single = estimateSlackImportance({ text: LONG.replace('```', '') });
  assert.ok(thread > single, `${thread} should be > ${single}`);
});

test('importance: code block boosts', () => {
  const withCode = estimateSlackImportance({ text: 'fix:\n```js\nfoo()\n```' });
  const without  = estimateSlackImportance({ text: 'fix: foo()' });
  assert.ok(withCode > without);
});

test('importance: clamped to [0.1, 0.95]', () => {
  const max = estimateSlackImportance({
    text: '```code``` https://x.dev', reply_count: 100,
    reactions: [{ count: 10 }],
  });
  assert.ok(max <= 0.95);
  assert.ok(estimateSlackImportance({ text: 'hi' }) >= 0.1);
});

// ─── slackTags ────────────────────────────────────────────────────────────

test('slackTags: thread kind + channel tag, lowercased', () => {
  const tags = slackTags({ reply_count: 3 }, 'Dev Backend');
  assert.deepEqual(tags, ['slack', 'import', 'thread', 'channel:dev-backend']);
});

test('slackTags: message kind without replies', () => {
  assert.ok(slackTags({}, 'general').includes('message'));
});

// ─── slackMessageKey ──────────────────────────────────────────────────────

test('slackMessageKey: stable channel:ts key', () => {
  assert.equal(slackMessageKey('C0123', { ts: '1717575600.000100' }), 'C0123:1717575600.000100');
});

// ─── threadToContent ──────────────────────────────────────────────────────

test('threadToContent: parent + replies, parent not duplicated', () => {
  const parent = { ts: '1', user: 'U1', text: 'почему падает миграция?' };
  const replies = [
    { ts: '1', user: 'U1', text: 'почему падает миграция?' }, // Slack повторяет parent
    { ts: '2', user: 'U2', text: 'нужен WAL mode' },
  ];
  const out = threadToContent(parent, replies);
  assert.equal(out.match(/почему падает миграция/g).length, 1);
  assert.ok(out.includes('↳ U2: нужен WAL mode'));
});

test('threadToContent: caps total length', () => {
  const parent = { ts: '1', user: 'U1', text: 'x'.repeat(5000) };
  assert.ok(threadToContent(parent, []).length <= 3000);
});

// ─── importSlack guards ───────────────────────────────────────────────────

test('importSlack: throws without token', async () => {
  await assert.rejects(() => importSlack({}), /token is required/);
  await assert.rejects(() => importSlack(null), /token is required/);
});
