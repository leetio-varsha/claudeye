/**
 * test/desktop-view-format.test.js — pure UI helpers of the Desktop
 * "Управление" view (#133).
 *
 * view-format.js ships as a classic browser <script> (no import/export), so we
 * execute the ACTUAL shipped file in a node:vm sandbox and exercise the real
 * exported functions — no mirror copy that could silently drift. No DOM / no
 * SQLite, so this runs even where the native module cannot load.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, '..', 'apps', 'desktop', 'ui', 'view-format.js');

function loadViewFormat() {
  const code = readFileSync(SRC, 'utf8');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  assert.ok(sandbox.ClaudeyeViewFormat, 'view-format.js exposes ClaudeyeViewFormat');
  return sandbox.ClaudeyeViewFormat;
}

const {
  schedulerViewModel, commandToast, notificationsViewModel, nativeNotification,
  parseTags, importanceSev, sessionDetailViewModel, searchViewModel, sessionExport,
} = loadViewFormat();

// ─── schedulerViewModel ──────────────────────────────────────────────────────

test('schedulerViewModel: maps the three launchd states', () => {
  const vmodel = schedulerViewModel([
    { key: 'insights', name: 'Daily insights', schedule: 'daily 09:00', installed: true, loaded: true },
    { key: 'digest', name: 'Weekly digest', schedule: 'weekly (Mon)', installed: true, loaded: false },
    { key: 'daemon', name: 'Agent daemon', schedule: 'hourly', installed: false, loaded: false },
  ]);
  assert.equal(vmodel.length, 3);
  assert.deepEqual(vmodel.map(v => v.sev), ['good', 'warn', 'bad']);
  assert.equal(vmodel[0].name, 'Daily insights');
  assert.equal(vmodel[0].schedule, 'daily 09:00');
  assert.equal(vmodel[0].state, 'running');
  assert.match(vmodel[1].state, /not loaded/);
  assert.match(vmodel[2].state, /not installed/);
});

test('schedulerViewModel: matches scheduler-status.js JSON shape', async () => {
  // Guard against drift with the canonical CLI/Rust source of the JSON.
  const { collectSchedulerStatus } = await import('../scripts/scheduler-status.js');
  const list = await collectSchedulerStatus();
  const vmodel = schedulerViewModel(list);
  assert.equal(vmodel.length, list.length);
  for (const v of vmodel) {
    assert.ok(['good', 'warn', 'bad'].includes(v.sev), `sev is a known tone: ${v.sev}`);
    assert.ok(typeof v.name === 'string' && v.name.length > 0);
    assert.ok(typeof v.state === 'string' && v.state.length > 0);
  }
});

test('schedulerViewModel: falls back to key when name missing, empty on non-array', () => {
  const vmodel = schedulerViewModel([{ key: 'daemon', installed: true, loaded: true }]);
  assert.equal(vmodel[0].name, 'daemon');
  // NB: view-format runs in a vm realm → its Array !== test-realm Array, so
  // deepStrictEqual([], []) would fail the constructor check. Assert length.
  const empty = (v) => assert.ok(Array.isArray(schedulerViewModel(v)) && schedulerViewModel(v).length === 0);
  empty(null);
  empty(undefined);
  empty('nope');
});

// ─── commandToast ────────────────────────────────────────────────────────────

test('commandToast: success strips ANSI and takes first meaningful line', () => {
  const ansi = '[1m[32m  ✓ Reindexed 42 embeddings[39m[22m\n  done';
  const t = commandToast('reindex', ansi, true);
  assert.equal(t.tone, 'good');
  assert.match(t.title, /Reindex/);
  assert.match(t.title, /done/);
  assert.equal(t.detail.includes(''), false, 'ANSI stripped');
  assert.match(t.detail, /Reindexed 42 embeddings/);
});

test('commandToast: "error:" stdout ⇒ bad tone', () => {
  const t = commandToast('cleanup', 'error: no such file', true);
  assert.equal(t.tone, 'bad');
  assert.match(t.title, /failed/);
});

test('commandToast: ok===false (invoke threw) ⇒ bad tone', () => {
  const t = commandToast('digest', 'timed out', false);
  assert.equal(t.tone, 'bad');
  assert.match(t.title, /Generate digest|digest/);
});

test('commandToast: caps very long detail', () => {
  const long = 'x'.repeat(400);
  const t = commandToast('reindex', long, true);
  assert.ok(t.detail.length <= 120, `detail capped, got ${t.detail.length}`);
  assert.match(t.detail, /…$/);
});

test('commandToast: empty output yields empty detail, still success', () => {
  const t = commandToast('reindex', '', true);
  assert.equal(t.tone, 'good');
  assert.equal(t.detail, '');
});

// ─── notificationsViewModel (#131) ───────────────────────────────────────────

test('notificationsViewModel: badge counts only actionable (crit|warn) rows', () => {
  const vmodel = notificationsViewModel([
    { sev: 'crit', title: 'DB 520 MB', hash: 'a' },
    { sev: 'warn', title: 'health 22', hash: 'b' },
    { sev: 'info', title: 'покрытие 99%', hash: 'c' },
    { sev: 'good', title: 'хуки живы', hash: 'd' },
    { sev: 'mut', title: 'плато', hash: 'e' },
  ]);
  assert.equal(vmodel.rows.length, 5, 'все не-dismissed попадают в ленту');
  assert.equal(vmodel.badge, 2, 'badge = crit + warn');
});

test('notificationsViewModel: dedup by hash keeps the first (newest) occurrence', () => {
  const vmodel = notificationsViewModel([
    { sev: 'crit', title: 'свежая формулировка', hash: 'dup' },
    { sev: 'crit', title: 'старая формулировка', hash: 'dup' },
    { sev: 'warn', title: 'другое', hash: 'other' },
  ]);
  assert.equal(vmodel.rows.length, 2);
  assert.equal(vmodel.rows[0].title, 'свежая формулировка');
  assert.equal(vmodel.badge, 2);
});

test('notificationsViewModel: falls back to sev+title key when hash absent', () => {
  const vmodel = notificationsViewModel([
    { sev: 'warn', title: 'одинаковый' },
    { sev: 'warn', title: 'одинаковый' },
    { sev: 'crit', title: 'одинаковый' },
  ]);
  assert.equal(vmodel.rows.length, 2, 'разный sev ⇒ разный ключ, дубль схлопнут');
});

test('notificationsViewModel: dismissed rows are hidden and suppress older dupes', () => {
  const vmodel = notificationsViewModel([
    { sev: 'crit', title: 'отклонённый', status: 'dismissed', hash: 'x' },
    { sev: 'crit', title: 'он же, старее', status: 'new', hash: 'x' },
    { sev: 'warn', title: 'живой', status: 'new', hash: 'y' },
  ]);
  assert.equal(vmodel.rows.length, 1);
  assert.equal(vmodel.rows[0].title, 'живой');
  assert.equal(vmodel.badge, 1, 'dismissed не считается в badge');
  assert.equal(vmodel.toNotify.length, 0, 'dismissed не поднимает нативный алерт');
});

test('notificationsViewModel: toNotify = only new crit rows', () => {
  const vmodel = notificationsViewModel([
    { sev: 'crit', title: 'новый крит', status: 'new', hash: 'a' },
    { sev: 'crit', title: 'уже показан', status: 'shown', hash: 'b' },
    { sev: 'warn', title: 'важно, но не крит', status: 'new', hash: 'c' },
    { sev: 'info', title: 'обычный insight', status: 'new', hash: 'd' },
  ]);
  assert.equal(vmodel.toNotify.length, 1, 'обычные insights не всплывают');
  assert.equal(vmodel.toNotify[0].title, 'новый крит');
  assert.equal(vmodel.rows.filter(r => r.notify).length, 1);
});

test('notificationsViewModel: seen (Set или массив) подавляет повтор на refresh', () => {
  const feed = [{ sev: 'crit', title: 'повтор', status: 'new', hash: 'seen-me' }];
  assert.equal(notificationsViewModel(feed, new Set(['seen-me'])).toNotify.length, 0);
  assert.equal(notificationsViewModel(feed, ['seen-me']).toNotify.length, 0);
  assert.equal(notificationsViewModel(feed, new Set(['другое'])).toNotify.length, 1);
});

test('notificationsViewModel: prototype-ключи не ломают дедуп', () => {
  const vmodel = notificationsViewModel([
    { sev: 'warn', title: 'proto', hash: 'constructor' },
    { sev: 'warn', title: 'proto-2', hash: 'toString' },
  ]);
  assert.equal(vmodel.rows.length, 2, 'hasOwnProperty вместо truthy-проверки');
  assert.equal(vmodel.badge, 2);
});

test('notificationsViewModel: defensive on garbage input', () => {
  for (const bad of [null, undefined, 'nope', 42]) {
    const vmodel = notificationsViewModel(bad);
    assert.equal(vmodel.rows.length, 0);
    assert.equal(vmodel.badge, 0);
    assert.equal(vmodel.toNotify.length, 0);
  }
  const partial = notificationsViewModel([{}, { sev: 'crit' }]);
  assert.ok(partial.rows.every(r => typeof r.title === 'string'));
  assert.ok(partial.rows.every(r => typeof r.status === 'string'));
});

// ─── nativeNotification (#131) ───────────────────────────────────────────────

test('nativeNotification: deep-links to the notifications view', () => {
  const n = nativeNotification({ sev: 'crit', title: 'DB 520 MB — 1.7× порога', key: 'k' });
  assert.equal(n.view, 'notifications');
  assert.equal(n.key, 'k');
  assert.match(n.title, /Claudeye/);
  assert.match(n.body, /DB 520 MB/);
});

test('nativeNotification: caps long body and survives empty row', () => {
  const long = nativeNotification({ title: 'я'.repeat(400) });
  assert.ok(long.body.length <= 160, `body capped, got ${long.body.length}`);
  assert.match(long.body, /…$/);
  const empty = nativeNotification(null);
  assert.equal(empty.body, '');
  assert.equal(empty.view, 'notifications');
});

// ─── session management: drill-in / поиск / экспорт (#132) ───────────────────

// NB: view-format исполняется в vm-realm → его Array !== Array тест-realm,
// deepStrictEqual падает на проверке прототипа. Приводим через Array.from.
const arr = (a) => Array.from(a);

test('parseTags: JSON-строка, готовый массив, мусор', () => {
  assert.deepEqual(arr(parseTags('["bug","db"]')), ['bug', 'db']);
  assert.deepEqual(arr(parseTags(['a', 1])), ['a', '1']);
  assert.equal(parseTags('').length, 0);
  assert.equal(parseTags(null).length, 0);
  assert.equal(parseTags('не json').length, 0);
  assert.equal(parseTags('{"a":1}').length, 0); // объект, не массив
});

test('importanceSev: пороги 0.75 / 0.4', () => {
  assert.equal(importanceSev(0.9), 'warn');
  assert.equal(importanceSev(0.75), 'warn');
  assert.equal(importanceSev(0.5), 'info');
  assert.equal(importanceSev(0.4), 'info');
  assert.equal(importanceSev(0.2), 'mut');
  assert.equal(importanceSev(undefined), 'mut');
  assert.equal(importanceSev('nope'), 'mut');
});

test('sessionDetailViewModel: наблюдения → строки, camelCase createdAt', () => {
  const vm = sessionDetailViewModel({
    id: 's1', project: '/home/u/claudeye', summary: 'фикс хуков', prompts: 5,
    started: '2026-07-22 09:00:00', ended: '2026-07-22 10:00:00',
    observations: [
      { id: 1, summary: 'правка install-hooks', tool: 'Edit', tags: '["hooks"]', importance: 0.8, rationale: 'ABI drift', createdAt: '2026-07-22 09:30:00', project: '/home/u/claudeye' },
      { id: 2, summary: 'npm test', tool: 'Bash', tags: '[]', importance: 0.3 },
    ],
  });
  assert.equal(vm.id, 's1');
  assert.equal(vm.count, 2);
  assert.equal(vm.empty, false);
  assert.equal(vm.rows[0].sev, 'warn');
  assert.deepEqual(arr(vm.rows[0].tags), ['hooks']);
  assert.equal(vm.rows[0].rationale, 'ABI drift');
  assert.equal(vm.rows[0].meta, '2026-07-22 09:30:00');
  assert.equal(vm.rows[1].sev, 'mut');
  assert.equal(vm.rows[1].meta, ''); // нет created_at → пусто
});

test('sessionDetailViewModel: пустой / битый вход', () => {
  const empty = sessionDetailViewModel(null);
  assert.equal(empty.empty, true);
  assert.equal(empty.rows.length, 0);
  assert.equal(empty.count, 0);
  const noObs = sessionDetailViewModel({ id: 'x', observations: 'nope' });
  assert.equal(noObs.empty, true);
});

test('searchViewModel: hits → строки + эхо запроса', () => {
  const vm = searchViewModel([
    { id: 7, summary: 'таймаут digest', tool: 'Bash', tags: '["digest"]', importance: 0.6, created_at: '2026-07-20 12:00:00' },
  ], '  digest  ');
  assert.equal(vm.query, 'digest');
  assert.equal(vm.count, 1);
  assert.equal(vm.empty, false);
  assert.equal(vm.rows[0].sev, 'info');
  assert.equal(vm.rows[0].meta, '2026-07-20 12:00:00'); // snake_case тоже читается
  const none = searchViewModel([], 'zzz');
  assert.equal(none.empty, true);
  assert.equal(none.count, 0);
});

test('searchViewModel: защита от мусора', () => {
  for (const bad of [null, undefined, 'nope', 42]) {
    const vm = searchViewModel(bad, 'q');
    assert.equal(vm.rows.length, 0);
    assert.equal(vm.empty, true);
  }
});

test('sessionExport json: структурный дамп без raw-полей', () => {
  const detail = {
    id: 's1', project: 'claudeye', summary: 'фикс', prompts: 2,
    started: 'a', ended: 'b',
    observations: [{ id: 1, summary: 's', tool: 'Edit', tags: '["t"]', importance: 0.9, rationale: 'r', createdAt: 'c' }],
  };
  const json = sessionExport(detail, 'json');
  const parsed = JSON.parse(json);
  assert.equal(parsed.id, 's1');
  assert.equal(parsed.observations.length, 1);
  assert.deepEqual(parsed.observations[0].tags, ['t']);
  assert.equal(parsed.observations[0].summary, 's');
  // никаких raw_input/raw_output
  assert.ok(!/raw_input|raw_output/.test(json));
});

test('sessionExport md: заголовок, метаданные, наблюдения', () => {
  const md = sessionExport({
    id: 's1', project: 'claudeye', summary: 'фикс хуков', prompts: 3,
    started: '2026-07-22', ended: '',
    observations: [{ id: 1, summary: 'правка', tool: 'Edit', tags: '["hooks"]', importance: 0.8, rationale: 'ABI', createdAt: 'c' }],
  }, 'md');
  assert.match(md, /# Session claudeye/);
  assert.match(md, /> фикс хуков/);
  assert.match(md, /prompts: 3/);
  assert.match(md, /- правка `Edit`/);
  assert.match(md, /tags: hooks/);
  assert.match(md, /rationale: ABI/);
});

test('sessionExport md: пустая сессия не падает', () => {
  const md = sessionExport({ id: 'x', project: 'p', observations: [] }, 'md');
  assert.match(md, /no observations/);
});

// ─── источник правды: сам файл должен оставаться текстовым ───────────────────

test('view-format.js contains no raw NUL bytes (git would call it binary)', () => {
  const raw = readFileSync(SRC);
  assert.equal(raw.includes(0x00), false, 'используй \\u0000-escape, не сырой байт');
});
