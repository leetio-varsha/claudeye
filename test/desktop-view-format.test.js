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

const { schedulerViewModel, commandToast } = loadViewFormat();

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
  assert.equal(vmodel[0].state, 'работает');
  assert.match(vmodel[1].state, /не загружен/);
  assert.match(vmodel[2].state, /не установлен/);
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
  assert.match(t.title, /готово/);
  assert.equal(t.detail.includes(''), false, 'ANSI stripped');
  assert.match(t.detail, /Reindexed 42 embeddings/);
});

test('commandToast: "error:" stdout ⇒ bad tone', () => {
  const t = commandToast('cleanup', 'error: no such file', true);
  assert.equal(t.tone, 'bad');
  assert.match(t.title, /ошибка/);
});

test('commandToast: ok===false (invoke threw) ⇒ bad tone', () => {
  const t = commandToast('digest', 'timed out', false);
  assert.equal(t.tone, 'bad');
  assert.match(t.title, /Генерация digest|digest/);
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
