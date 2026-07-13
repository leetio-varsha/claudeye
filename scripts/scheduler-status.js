/**
 * scripts/scheduler-status.js — unified launchd scheduler status
 *
 * Claudeye ships three independent launchd LaunchAgents:
 *   - com.claudeye.daily-insights  (scripts/insights-scheduler.js)
 *   - com.claudeye.weekly-digest   (scripts/digest-scheduler.js)
 *   - com.claudeye.agent-daemon    (scripts/agent-daemon-scheduler.js)
 *
 * Each scheduler module already exports its own status() returning
 * `{ installed, loaded?, plist? }`. Historically there was no single command
 * to see all three at once — you had to run `claudeye insights --status`,
 * `claudeye digest --status` and inspect the daemon separately.
 *
 * The Desktop app (#128/#133) invokes `claudeye scheduler status` from its
 * "Управление" view (Rust cmd_agents_status), so this aggregation is the
 * canonical source both the CLI and the desktop rely on. Keeping it in one
 * place avoids the CLI and the Tauri bridge drifting apart.
 *
 * This module contains NO database access — safe to import in environments
 * where the native SQLite module cannot load (e.g. CI sandbox).
 */

// Static registry of the schedulers we manage. Order = display order.
export const SCHEDULERS = [
  {
    key: 'insights',
    name: 'Daily insights',
    schedule: 'daily 09:00',
    module: './insights-scheduler.js',
  },
  {
    key: 'digest',
    name: 'Weekly digest',
    schedule: 'weekly (Mon)',
    module: './digest-scheduler.js',
  },
  {
    key: 'daemon',
    name: 'Agent daemon',
    schedule: 'hourly',
    module: './agent-daemon-scheduler.js',
  },
];

/**
 * Collect launchd status for every managed scheduler.
 * Each scheduler's status() is read-only (existsSync + launchctl list) and
 * never throws — a failing/absent scheduler degrades to { installed: false }.
 *
 * @returns {Promise<Array<{key,name,schedule,installed,loaded,plist}>>}
 */
export async function collectSchedulerStatus() {
  const out = [];
  for (const s of SCHEDULERS) {
    let st = { installed: false };
    try {
      const mod = await import(s.module);
      if (typeof mod.status === 'function') st = mod.status() || { installed: false };
    } catch {
      // Scheduler module missing/broken — report as not installed rather than crash.
      st = { installed: false };
    }
    out.push({
      key:       s.key,
      name:      s.name,
      schedule:  s.schedule,
      installed: !!st.installed,
      loaded:    !!st.loaded,
      plist:     st.plist || null,
    });
  }
  return out;
}

/**
 * Human-readable one-line-per-scheduler render.
 * Pure function (no I/O) — safe to unit-test with synthetic data.
 *
 * @param {Array} list  output of collectSchedulerStatus()
 * @param {object} [opts]
 * @param {boolean} [opts.color=false]  wrap state words in ANSI via `chalk`
 * @param {import('chalk').ChalkInstance} [opts.chalk]  optional chalk instance
 * @returns {string}
 */
export function formatSchedulerStatus(list, opts = {}) {
  const chalk = opts.color ? opts.chalk : null;
  const paint = (s, kind) => {
    if (!chalk) return s;
    if (kind === 'ok')   return chalk.green(s);
    if (kind === 'warn') return chalk.yellow(s);
    if (kind === 'bad')  return chalk.red(s);
    if (kind === 'dim')  return chalk.gray(s);
    return s;
  };

  const lines = [];
  for (const s of list) {
    let state, kind;
    if (!s.installed) {
      state = 'not scheduled';
      kind  = 'bad';
    } else if (s.loaded) {
      state = 'running';
      kind  = 'ok';
    } else {
      state = 'installed (not loaded)';
      kind  = 'warn';
    }
    const name = s.name.padEnd(16);
    lines.push(`  ${name} ${paint(state, kind)} ${paint(`(${s.schedule})`, 'dim')}`);
  }

  const active = list.filter(s => s.installed && s.loaded).length;
  lines.push('');
  lines.push(paint(`  ${active}/${list.length} schedulers running`, 'dim'));
  return lines.join('\n');
}
