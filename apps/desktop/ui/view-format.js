/**
 * apps/desktop/ui/view-format.js — pure presentation helpers for the desktop UI.
 *
 * NO DOM / no Tauri access here on purpose: these are the only bits of the
 * "Управление" / "Уведомления" views worth unit-testing (scheduler-status
 * shaping, command toast wording, notification feed model). Loaded in the
 * browser as a classic <script> before app.js (exposes
 * `window.ClaudeyeViewFormat`), and imported into node tests via `node:vm` so
 * the SHIPPED source is what gets exercised — not a mirror copy.
 *
 * Consumers:
 *   - app.js renderControls()       → schedulerViewModel(list)
 *   - app.js runCommand()           → commandToast(cmd, output, ok)
 *   - app.js setStatus()/boot()     → notificationsViewModel(list, seen) (#131)
 *   - app.js pushNativeAlerts()     → nativeNotification(row) (#131)
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
        state = 'not installed';
      } else if (loaded) {
        sev = 'good';
        state = 'running';
      } else {
        sev = 'warn';
        state = 'installed, not loaded';
      }
      return {
        name: (s && (s.name || s.key)) || 'agent',
        schedule: (s && s.schedule) || '',
        sev: sev,
        state: state,
      };
    });
  }

  var CMD_LABEL = {
    reindex: 'Reindex embeddings',
    cleanup: 'Cleanup',
    digest: 'Generate digest',
    agents: 'Agent status',
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
      title: (CMD_LABEL[cmd] || cmd) + (failed ? ' — failed' : ' — done'),
      detail: detail,
    };
  }

  // ── Notification center (#131) ──────────────────────────────────────────
  // Shapes the raw notification feed (insights alerts + behavioral advises)
  // into a render-ready model with dedup, actionable badge count, and the
  // subset that warrants a *native* macOS notification.
  //
  // Input rows: { sev, title, meta?, status?, hash? }
  //   sev    — 'crit' | 'warn' | 'info' | 'good' | 'mut'  (already normalized
  //            by the Rust recent_notifications / advises severity mapping)
  //   status — advises.status: 'new'|'shown'|'dismissed'|'accepted'|'applied'
  //            missing ⇒ treated as 'new' (insights alerts have no status col)
  //   hash   — advises.observation_hash for stable dedup; falls back to
  //            sev + U+0000 + title when absent. NB: the separator MUST be
  //            written as a backslash-u escape, never as a literal NUL byte —
  //            a raw NUL makes git classify this file as binary and every
  //            diff becomes unreviewable.
  //
  // Rules:
  //   - Dedup keeps the FIRST occurrence of each key (feed is newest-first),
  //     so a newer 'dismissed' row also suppresses its older duplicates.
  //   - 'dismissed' rows are hidden from the feed and excluded from the badge.
  //   - badge counts actionable (crit|warn) non-dismissed rows.
  //   - toNotify = crit rows that are still 'new' (never shown/dismissed) — the
  //     only ones the app fires a native, deep-linked notification for. `seen`
  //     (a Set/array of keys already surfaced this session) suppresses repeats
  //     so a refresh doesn't re-alert.
  var ACTIONABLE = { crit: true, warn: true };

  function notifKey(row) {
    if (row && row.hash) return String(row.hash);
    var sev = (row && row.sev) || 'mut';
    var title = (row && row.title) || '';
    return sev + '\u0000' + title;
  }

  function notificationsViewModel(list, seen) {
    var seenSet = {};
    if (seen && typeof seen.forEach === 'function') {
      seen.forEach(function (h) { seenSet[String(h)] = true; });
    } else if (Array.isArray(seen)) {
      for (var i = 0; i < seen.length; i++) seenSet[String(seen[i])] = true;
    }

    var rows = [];
    var toNotify = [];
    var badge = 0;
    var deduped = {};

    (Array.isArray(list) ? list : []).forEach(function (n) {
      var key = notifKey(n);
      // Guard against inherited Object.prototype keys ("constructor" etc.)
      if (Object.prototype.hasOwnProperty.call(deduped, key)) return;
      deduped[key] = true;

      var sev = (n && n.sev) || 'mut';
      var status = (n && n.status) || 'new';
      if (status === 'dismissed') return; // hidden + not counted

      var actionable = !!ACTIONABLE[sev];
      var notify = sev === 'crit' && status === 'new' &&
        !Object.prototype.hasOwnProperty.call(seenSet, key);
      if (actionable) badge += 1;

      var row = {
        key: key,
        sev: sev,
        title: (n && n.title) || '',
        meta: (n && n.meta) || '',
        status: status,
        actionable: actionable,
        notify: notify,
      };
      rows.push(row);
      if (notify) toNotify.push(row);
    });

    return { rows: rows, badge: badge, toNotify: toNotify };
  }

  // Descriptor for ONE native macOS notification fired from a toNotify row.
  // `view` is the deep-link target consumed by app.js goToView().
  function nativeNotification(row) {
    var title = (row && row.title) || '';
    var body = title.length > 160 ? title.slice(0, 157) + '…' : title;
    return {
      title: 'Claudeye — critical alert',
      body: body,
      view: 'notifications',
      key: (row && row.key) || '',
    };
  }

  // ── Session drill-in / поиск / экспорт (#132) ───────────────────────────
  // Shapes the raw rows from the Rust `session_detail` / `search_memory`
  // commands into render-ready view models, and serializes a session to
  // md/json. Kept here (no DOM / no SQLite) so the tricky bits — tag parsing,
  // importance→severity, export formatting — are unit-tested against the
  // SHIPPED source.
  //
  // AUP: observation rows NEVER carry raw_input/raw_output — the Rust side
  // only selects summary/tool/tags/importance/rationale/created_at. Nothing
  // here reconstructs raw payloads.

  // tags ship as a JSON array string ('["a","b"]'); tolerate already-parsed
  // arrays, malformed JSON, and null.
  function parseTags(tags) {
    if (Array.isArray(tags)) return tags.map(String);
    if (typeof tags !== 'string' || !tags.trim()) return [];
    try {
      var arr = JSON.parse(tags);
      return Array.isArray(arr) ? arr.map(String) : [];
    } catch (_) {
      return [];
    }
  }

  // importance 0..1 → severity dot: ≥0.75 warn (важное), ≥0.4 info, иначе mut.
  function importanceSev(v) {
    var n = typeof v === 'number' ? v : parseFloat(v);
    if (!isFinite(n)) return 'mut';
    if (n >= 0.75) return 'warn';
    if (n >= 0.4) return 'info';
    return 'mut';
  }

  function observationRow(o) {
    return {
      id: (o && o.id) || 0,
      title: (o && o.summary) || 'no summary',
      tool: (o && o.tool) || '',
      tags: parseTags(o && o.tags),
      rationale: (o && o.rationale) || '',
      importance: (o && typeof o.importance === 'number') ? o.importance : 0,
      sev: importanceSev(o && o.importance),
      meta: (o && o.createdAt) || (o && o.created_at) || '',
      project: (o && o.project) || '',
    };
  }

  // Drill-in model for one session: header meta + its observation rows.
  function sessionDetailViewModel(detail) {
    var d = detail || {};
    var obs = Array.isArray(d.observations) ? d.observations : [];
    return {
      id: d.id || '',
      project: d.project || '',
      summary: d.summary || '',
      started: d.started || '',
      ended: d.ended || '',
      prompts: typeof d.prompts === 'number' ? d.prompts : 0,
      count: obs.length,
      rows: obs.map(observationRow),
      empty: obs.length === 0,
    };
  }

  // Search results model. `query` echoed back for the "N по запросе …" header.
  function searchViewModel(hits, query) {
    var rows = (Array.isArray(hits) ? hits : []).map(observationRow);
    return {
      query: (query || '').trim(),
      count: rows.length,
      rows: rows,
      empty: rows.length === 0,
    };
  }

  // Serialize a session detail to a shareable string. format: 'json' | 'md'.
  // JSON is the structured detail as-is; md is a human-readable digest.
  function sessionExport(detail, format) {
    var vm = sessionDetailViewModel(detail);
    if (format === 'json') {
      return JSON.stringify(
        {
          id: vm.id,
          project: vm.project,
          summary: vm.summary,
          started: vm.started,
          ended: vm.ended,
          prompts: vm.prompts,
          observations: vm.rows.map(function (r) {
            return {
              id: r.id,
              summary: r.title,
              tool: r.tool,
              tags: r.tags,
              importance: r.importance,
              rationale: r.rationale,
              created_at: r.meta,
            };
          }),
        },
        null,
        2
      );
    }
    // markdown
    var lines = [];
    lines.push('# Session ' + (vm.project || vm.id || '—'));
    lines.push('');
    if (vm.summary) lines.push('> ' + vm.summary);
    var head = [];
    if (vm.started) head.push('started: ' + vm.started);
    if (vm.ended) head.push('ended: ' + vm.ended);
    head.push('prompts: ' + vm.prompts);
    head.push('observations: ' + vm.count);
    lines.push('');
    lines.push('_' + head.join(' · ') + '_');
    lines.push('');
    lines.push('## Observations');
    lines.push('');
    if (vm.empty) {
      lines.push('_no observations_');
    } else {
      vm.rows.forEach(function (r) {
        var tail = r.tool ? ' `' + r.tool + '`' : '';
        lines.push('- ' + r.title + tail);
        if (r.tags.length) lines.push('  - tags: ' + r.tags.join(', '));
        if (r.rationale) lines.push('  - rationale: ' + r.rationale);
      });
    }
    lines.push('');
    return lines.join('\n');
  }

  var api = {
    schedulerViewModel: schedulerViewModel,
    commandToast: commandToast,
    notificationsViewModel: notificationsViewModel,
    nativeNotification: nativeNotification,
    parseTags: parseTags,
    importanceSev: importanceSev,
    sessionDetailViewModel: sessionDetailViewModel,
    searchViewModel: searchViewModel,
    sessionExport: sessionExport,
  };

  if (typeof window !== 'undefined') window.ClaudeyeViewFormat = api;
  if (typeof globalThis !== 'undefined') globalThis.ClaudeyeViewFormat = api;
})();
