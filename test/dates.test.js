/**
 * test/dates.test.js — local-date helpers (#112)
 *
 * Регрессия: monday.toISOString().slice(0,10) конвертировал локальную дату
 * в UTC — при TZ=UTC+N и времени < N:00 week_start съезжал на воскресенье
 * (в БД были дубликаты: week_start=2026-05-24 рядом с 2026-05-25).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { localYMD, lastMondayLocal } from '../src/dates.js';

// ─── localYMD ─────────────────────────────────────────────────────────────

test('localYMD: formats local components, not UTC', () => {
  // Полночь+11 минут локального времени. В UTC+3 toISOString дал бы вчера.
  const d = new Date(2026, 4, 26, 0, 11, 0); // 26 May 2026, 00:11 local
  assert.equal(localYMD(d), '2026-05-26');
});

test('localYMD: pads month and day', () => {
  assert.equal(localYMD(new Date(2026, 0, 5)), '2026-01-05');
});

test('localYMD: differs from toISOString shortly after local midnight in TZ east of UTC', () => {
  const d = new Date(2026, 4, 26, 0, 11, 0);
  const iso = d.toISOString().slice(0, 10);
  if (d.getTimezoneOffset() < 0) {
    // TZ east of UTC (e.g. Kyiv): это ровно сценарий бага #112
    assert.notEqual(localYMD(d), iso);
  } else {
    // UTC/запад: значения совпадают — хелпер не хуже
    assert.equal(localYMD(d), iso);
  }
});

// ─── lastMondayLocal ──────────────────────────────────────────────────────

test('lastMondayLocal: Tuesday 00:11 local → Monday of same week (bug #112 repro)', () => {
  // 2026-05-26 — вторник. Старый код в UTC+3 возвращал '2026-05-24' (воскресенье!).
  const d = new Date(2026, 4, 26, 0, 11, 0);
  assert.equal(lastMondayLocal(d), '2026-05-25');
});

test('lastMondayLocal: Monday → same day', () => {
  assert.equal(lastMondayLocal(new Date(2026, 5, 1, 9, 0)), '2026-06-01');
});

test('lastMondayLocal: Sunday → previous Monday', () => {
  assert.equal(lastMondayLocal(new Date(2026, 4, 31, 23, 59)), '2026-05-25');
});

test('lastMondayLocal: always returns a Monday', () => {
  for (let i = 0; i < 14; i++) {
    const d = new Date(2026, 4, 20 + i, 1, 30);
    const ymd = lastMondayLocal(d);
    const [y, m, day] = ymd.split('-').map(Number);
    assert.equal(new Date(y, m - 1, day).getDay(), 1, `${ymd} is not a Monday (input day offset ${i})`);
  }
});

test('lastMondayLocal: crosses month boundary', () => {
  // 2026-06-03 (среда) → понедельник 2026-06-01
  assert.equal(lastMondayLocal(new Date(2026, 5, 3, 12, 0)), '2026-06-01');
  // 2026-05-01 (пятница) → понедельник 2026-04-27
  assert.equal(lastMondayLocal(new Date(2026, 4, 1, 12, 0)), '2026-04-27');
});
