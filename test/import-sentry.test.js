/**
 * test/import-sentry.test.js — pure-helper tests for #23 Sentry importer.
 *
 * No real HTTP — triage / importance / tags / stacktrace extraction /
 * pagination cursor parsing that decide how Sentry issues map into observations.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  triageLevel,
  estimateSentryImportance,
  sentryTags,
  sentryIssueKey,
  extractStackFrames,
  issueToContent,
  parseNextCursor,
  importSentry,
} from '../src/import-sentry.js';

// ─── triageLevel ──────────────────────────────────────────────────────────

test('triageLevel: fatal is always high', () => {
  assert.equal(triageLevel({ level: 'fatal', count: 1, userCount: 0 }), 'high');
});

test('triageLevel: loud error (50+ events or 10+ users) is high', () => {
  assert.equal(triageLevel({ level: 'error', count: 120, userCount: 1 }), 'high');
  assert.equal(triageLevel({ level: 'error', count: 5, userCount: 15 }), 'high');
});

test('triageLevel: quiet error is medium, quiet warning is low', () => {
  assert.equal(triageLevel({ level: 'error', count: 2, userCount: 1 }), 'medium');
  assert.equal(triageLevel({ level: 'warning', count: 2, userCount: 1 }), 'low');
});

// ─── estimateSentryImportance ─────────────────────────────────────────────

test('importance: fatal+mass > error > warning, clamped to [0.1, 0.95]', () => {
  const fatal = estimateSentryImportance({ level: 'fatal', count: 500, userCount: 50 });
  const error = estimateSentryImportance({ level: 'error', count: 5, userCount: 1 });
  const warn  = estimateSentryImportance({ level: 'warning', count: 1, userCount: 0 });
  assert.ok(fatal > error && error > warn, `${fatal} > ${error} > ${warn}`);
  assert.ok(fatal <= 0.95);
  assert.ok(warn >= 0.1);
});

test('importance: regression bumps the score', () => {
  const base = estimateSentryImportance({ level: 'error', count: 5 });
  const regr = estimateSentryImportance({ level: 'error', count: 5, substatus: 'regressed' });
  assert.ok(regr > base);
});

// ─── sentryTags / sentryIssueKey ──────────────────────────────────────────

test('tags: source, level, triage, sentry-project, regression', () => {
  const tags = sentryTags({
    level: 'Error', count: 200, userCount: 20,
    project: { slug: 'My-API' }, substatus: 'regressed',
  });
  assert.ok(tags.includes('sentry'));
  assert.ok(tags.includes('level:error'));
  assert.ok(tags.includes('triage:high'));
  assert.ok(tags.includes('sentry-project:my-api'));
  assert.ok(tags.includes('regression'));
});

test('issue key is org-scoped and stable', () => {
  assert.equal(sentryIssueKey('leetio', { id: '42' }), 'leetio:42');
});

// ─── extractStackFrames ───────────────────────────────────────────────────

const EVENT = {
  entries: [
    { type: 'breadcrumbs', data: {} },
    {
      type: 'exception',
      data: {
        values: [{
          type: 'TypeError',
          value: "Cannot read properties of undefined (reading 'id')",
          stacktrace: {
            frames: [
              { function: 'node:internal', filename: 'node:events', inApp: false, lineNo: 1 },
              { function: 'handleRequest', filename: '/app/src/server.js', inApp: true, lineNo: 88 },
              { function: 'getUser', filename: '/app/src/db.js', inApp: true, lineNo: 14 },
            ],
          },
        }],
      },
    },
  ],
};

test('extractStackFrames: in-app frames only, crash site present, error header first', () => {
  const frames = extractStackFrames(EVENT);
  assert.ok(frames[0].startsWith('TypeError:'));
  assert.ok(frames.some((f) => f.includes('getUser') && f.includes('/app/src/db.js:14')));
  assert.ok(!frames.some((f) => f.includes('node:events')));
});

test('extractStackFrames: no exception entries → empty', () => {
  assert.deepEqual(extractStackFrames({ entries: [] }), []);
  assert.deepEqual(extractStackFrames(null), []);
});

// ─── issueToContent ───────────────────────────────────────────────────────

test('issueToContent: level, culprit, counts, permalink, stack', () => {
  const content = issueToContent({
    level: 'error', title: 'TypeError in handleRequest', culprit: 'handleRequest(server)',
    count: '120', userCount: 7, firstSeen: '2026-06-01', lastSeen: '2026-06-07',
    permalink: 'https://sentry.io/x/1', substatus: 'regressed',
  }, ['TypeError: boom', '  at getUser (/app/src/db.js:14)']);
  assert.ok(content.includes('[error] TypeError in handleRequest'));
  assert.ok(content.includes('culprit: handleRequest(server)'));
  assert.ok(content.includes('events: 120, users: 7'));
  assert.ok(content.includes('https://sentry.io/x/1'));
  assert.ok(content.includes('at getUser (/app/src/db.js:14)'));
});

// ─── parseNextCursor ──────────────────────────────────────────────────────

test('parseNextCursor: results="true" → cursor, results="false" → null', () => {
  const link =
    '<https://sentry.io/api/0/organizations/x/issues/?cursor=0:0:1>; rel="previous"; results="false"; cursor="0:0:1", ' +
    '<https://sentry.io/api/0/organizations/x/issues/?cursor=0:100:0>; rel="next"; results="true"; cursor="0:100:0"';
  assert.equal(parseNextCursor(link), '0:100:0');

  const last = link.replace('rel="next"; results="true"', 'rel="next"; results="false"');
  assert.equal(parseNextCursor(last), null);
  assert.equal(parseNextCursor(null), null);
});

// ─── importSentry guards ──────────────────────────────────────────────────

test('importSentry: requires token and org', async () => {
  await assert.rejects(() => importSentry({}), /token is required/);
  await assert.rejects(() => importSentry({ token: 't' }), /org slug is required/);
});
