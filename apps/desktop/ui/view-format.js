/**
 * apps/desktop/ui/view-format.js — pure presentation helpers for the desktop UI.
 *
 * NO DOM / no Tauri access here on purpose: these are the only bits of the
 * "Управление" view worth unit-testing (scheduler-status shaping + command
 * toast wording). Loaded in the browser as a classic <script> before app.js
 * (exposes `window.ClaudeyeViewFormat`), and imported into node tests via
 * `node:vm` so the SHIPPED source is what gets exercised — not a mirror copy.
 *
 * Consumers:
 *   - app.js renderControls()  → schedulerViewModel(list)
 *   - app.js runCommand()      → commandToast(cmd, output, ok)
 */
(function () {
  'use strict';

  // Match the JSON emitted by `claudeye scheduler status --json`
  // (scripts/scheduler-status.js → collectSchedulerStatus): one entry per
  // launchd agent with { key, name, schedule, installed, loaded, plist }.
  // Maps each to a render-ready { name, schedule, sev, state } row.
  function schedulerViewModel(list) {
    if (!Array.isArray(list)) return [];
    return list.map(function (s) {
      var installed = !!(s && s.installed);
      var loaded = !!(s && s.loaded);
      var sev, state;
      if (!installed) {
        sev = 'bad';
        state = 'не установлен';
      } else if (loaded) {
        sev = 'good';
        state = 'работает';
      } else {
        sev = 'warn';
        state = 'установлен, не загружен';
      }
      return {
        name: (s && (s.name || s.key)) || 'агент',
        schedule: (s && s.schedule) || '',
        sev: sev,
        state: state,
      };
    });
  }

  var CMD_LABEL = {
    reindex: 'Reindex эмбеддингов',
    cleanup: 'Cleanup',
    digest: 'Генерация digest',
    agents: 'Статус агентов',
    board: 'GitHub Project',
  };

  function stripAnsi(s) {
    // eslint-disable-next-line no-control-regex
    return String(s == null ? '' : s).replace(/\[[0-9;]*m/g, '');
  }

  function firstLine(s) {
    var lines = stripAnsi(s)
      .split('\n')
      .map(function (l) { return l.trim(); })
      .filter(Boolean);
    return lines.length ? lines[0] : '';
  }

  // Turns a finished command + its stdout into a toast descriptor.
  // `ok === false` (invoke threw) or stdout starting with "error:" ⇒ bad tone.
  function commandToast(cmd, output, ok) {
    var clean = stripAnsi(output).trim();
    var failed = ok === false || /^error:/i.test(clean);
    var detail = firstLine(output);
    if (detail.length > 120) detail = detail.slice(0, 117) + '…';
    return {
      tone: failed ? 'bad' : 'good',
      title: (CMD_LABEL[cmd] || cmd) + (failed ? ' — ошибка' : ' — готово'),
      detail: detail,
    };
  }

  var api = {
    schedulerViewModel: schedulerViewModel,
    commandToast: commandToast,
  };

  if (typeof window !== 'undefined') window.ClaudeyeViewFormat = api;
  if (typeof globalThis !== 'undefined') globalThis.ClaudeyeViewFormat = api;
})();
