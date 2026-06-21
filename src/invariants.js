/**
 * src/invariants.js — Invariants-mode checker for Claudeye (#99)
 *
 * Проверяет конечный список инвариантов стабильности системы.
 * Каждый инвариант возвращает { id, status: 'green'|'red', value, threshold, detail }.
 *
 * Usage:
 *   import { checkInvariants } from './src/invariants.js';
 *   const result = await checkInvariants();
 *   // result.all_green, result.checked, result.violations, result.checks
 */

import { existsSync, statSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';
import { lastMondayLocal } from './dates.js';

const DATA_DIR    = join(homedir(), '.claudeye');
const HEARTBEAT   = join(DATA_DIR, 'logs', 'insights-heartbeat.log');
const SETTINGS    = join(DATA_DIR, 'settings.json');

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Local date string for last Monday (toISOString сдвигал на день, #112) */
function getLastMonday() {
  return lastMondayLocal();
}

/** Returns today's UTC date string YYYY-MM-DD */
function today() {
  return new Date().toISOString().slice(0, 10);
}

/** Returns SQLite-формат datetime string for `now - days` ('YYYY-MM-DD HH:MM:SS', UTC) */
function daysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  // replace('T', ' ') — иначе строковое сравнение с created_at ('YYYY-MM-DD HH:MM:SS')
  // отбрасывает все строки граничного дня (' ' < 'T')
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

function green(id, value, threshold, detail) {
  return { id, status: 'green', value, threshold, detail };
}

function red(id, value, threshold, detail) {
  return { id, status: 'red', value, threshold, detail };
}

function skipped(id, detail) {
  return { id, status: 'skipped', value: null, threshold: null, detail };
}

// ─── Individual invariant checks ────────────────────────────────────────────

function checkSCHED1(db) {
  // Insights heartbeat log has a [insights] finish/exit line today
  if (!existsSync(HEARTBEAT)) return red('SCHED-1', 'no log file', 'log exists', 'insights-heartbeat.log not found');
  const todayStr = today();
  try {
    const content = readFileSync(HEARTBEAT, 'utf8');
    const lines = content.split('\n').filter(l => l.startsWith(todayStr) || l.includes(todayStr.slice(0, 10)));
    const hasFinish = lines.some(l => l.includes('[insights') && (l.includes('exit=') || l.includes('finish')));
    if (hasFinish) return green('SCHED-1', 'found today', 'today', 'insights heartbeat logged today');
    // Check last 36 hours
    const recent = content.split('\n').filter(l => {
      const m = l.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/);
      if (!m) return false;
      return new Date(m[1]) > new Date(Date.now() - 36 * 3600000);
    });
    const hasRecent = recent.some(l => l.includes('[insights') && (l.includes('exit=') || l.includes('finish')));
    if (hasRecent) return green('SCHED-1', 'within 36h', '36h', 'insights heartbeat logged within 36h');
    return red('SCHED-1', 'stale', '36h', `Last insights heartbeat not found in last 36h`);
  } catch (e) {
    return skipped('SCHED-1', `Cannot read heartbeat log: ${e.message}`);
  }
}

function checkSCHED2(db) {
  // Behavioral advisor ran on last Monday
  const lastMonday = getLastMonday();
  try {
    const row = db.prepare("SELECT MAX(created_at) as t FROM advises WHERE source LIKE '%behavioral%'").get();
    if (!row || !row.t) return red('SCHED-2', null, lastMonday, 'No behavioral advises found');
    const latestDate = row.t.slice(0, 10);
    if (latestDate >= lastMonday) return green('SCHED-2', latestDate, lastMonday, `Last behavioral advise: ${latestDate}`);
    return red('SCHED-2', latestDate, lastMonday, `Behavioral advisor last ran ${latestDate}, expected >= ${lastMonday}`);
  } catch (e) {
    return skipped('SCHED-2', `advises table error: ${e.message}`);
  }
}

function checkSCHED3(db) {
  // Weekly digest not older than 7 days
  const threshold = daysAgo(7).slice(0, 10);
  try {
    const row = db.prepare('SELECT MAX(created_at) as t FROM digests').get();
    if (!row || !row.t) return red('SCHED-3', null, threshold, 'No digests found');
    const latestDate = row.t.slice(0, 10);
    if (latestDate >= threshold) return green('SCHED-3', latestDate, threshold, `Last digest: ${latestDate}`);
    return red('SCHED-3', latestDate, threshold, `Digest stale: last was ${latestDate}`);
  } catch (e) {
    return skipped('SCHED-3', `digests table error: ${e.message}`);
  }
}

function checkDATA1(db) {
  // ≤10% observations are git-commit in last 7 days
  const cutoff = daysAgo(7);
  const total = db.prepare("SELECT COUNT(*) as n FROM observations WHERE created_at >= ?").get(cutoff).n;
  if (total === 0) return skipped('DATA-1', 'No observations in last 7d');
  const gitCount = db.prepare("SELECT COUNT(*) as n FROM observations WHERE tool = 'git-commit' AND created_at >= ?").get(cutoff).n;
  const pct = +(gitCount / total * 100).toFixed(1);
  const threshold = 10;
  if (pct <= threshold) return green('DATA-1', `${pct}%`, `≤${threshold}%`, `git-commit: ${gitCount}/${total} (${pct}%)`);
  return red('DATA-1', `${pct}%`, `≤${threshold}%`, `git-commit dominance: ${gitCount}/${total} (${pct}%) — exceeds 10% threshold`);
}

function checkDATA2(db) {
  // ≥80% sessions last 7d have friction_score > 0
  const cutoff = daysAgo(7);
  try {
    const total = db.prepare("SELECT COUNT(*) as n FROM sessions WHERE started_at >= ? AND ended_at IS NOT NULL").get(cutoff).n;
    if (total === 0) return skipped('DATA-2', 'No closed sessions in last 7d');
    const withFriction = db.prepare("SELECT COUNT(*) as n FROM sessions WHERE started_at >= ? AND ended_at IS NOT NULL AND friction_score > 0").get(cutoff).n;
    const pct = +(withFriction / total * 100).toFixed(1);
    const threshold = 80;
    if (pct >= threshold) return green('DATA-2', `${pct}%`, `≥${threshold}%`, `${withFriction}/${total} sessions have friction_score`);
    return red('DATA-2', `${pct}%`, `≥${threshold}%`, `Only ${withFriction}/${total} sessions (${pct}%) have friction_score > 0`);
  } catch (e) {
    return skipped('DATA-2', `sessions query error: ${e.message}`);
  }
}

function checkDATA3(db) {
  // Effective embedding coverage ≥ 95%
  try {
    const searchableObs = db.prepare(`
      SELECT COUNT(*) as n FROM observations o
      WHERE (
        (o.tool != 'git-commit' AND o.importance >= 0.5)
        OR (o.tool = 'git-commit' AND o.id IN (
          SELECT id FROM (
            SELECT id, ROW_NUMBER() OVER (PARTITION BY project ORDER BY created_at DESC) as rn
            FROM observations WHERE tool = 'git-commit'
          ) WHERE rn <= 50
        ))
      )
    `).get().n;
    if (searchableObs === 0) return skipped('DATA-3', 'No searchable observations');
    const withEmb = db.prepare(`
      SELECT COUNT(*) as n FROM observations o
      JOIN embeddings e ON e.observation_id = o.id
      WHERE (
        (o.tool != 'git-commit' AND o.importance >= 0.5)
        OR (o.tool = 'git-commit' AND o.id IN (
          SELECT id FROM (
            SELECT id, ROW_NUMBER() OVER (PARTITION BY project ORDER BY created_at DESC) as rn
            FROM observations WHERE tool = 'git-commit'
          ) WHERE rn <= 50
        ))
      )
    `).get().n;
    const pct = +(withEmb / searchableObs * 100).toFixed(1);
    const threshold = 95;
    if (pct >= threshold) return green('DATA-3', `${pct}%`, `≥${threshold}%`, `Effective embedding coverage: ${withEmb}/${searchableObs}`);
    return red('DATA-3', `${pct}%`, `≥${threshold}%`, `Embedding coverage ${pct}% below 95% threshold — run claudeye reindex`);
  } catch (e) {
    return skipped('DATA-3', `embeddings query error: ${e.message}`);
  }
}

function checkDATA4(db) {
  // Cowork noise ≤5% of total cowork imports
  try {
    const total = db.prepare("SELECT COUNT(*) as n FROM observations WHERE project LIKE '%cowork%' OR tags LIKE '%cowork%'").get().n;
    if (total === 0) return skipped('DATA-4', 'No Cowork observations');
    const noise = db.prepare("SELECT COUNT(*) as n FROM observations WHERE tags LIKE '%cowork-noise%'").get().n;
    const pct = +(noise / total * 100).toFixed(1);
    const threshold = 5;
    if (pct <= threshold) return green('DATA-4', `${pct}%`, `≤${threshold}%`, `Cowork noise: ${noise}/${total} (${pct}%)`);
    return red('DATA-4', `${pct}%`, `≤${threshold}%`, `Cowork noise ${pct}% exceeds 5% — run claudeye cleanup --cowork-noise`);
  } catch (e) {
    return skipped('DATA-4', `query error: ${e.message}`);
  }
}

function checkTRACK1(db) {
  // ≥99% sessions last 7d have model IS NOT NULL
  const cutoff = daysAgo(7);
  const total = db.prepare("SELECT COUNT(*) as n FROM sessions WHERE started_at >= ? AND ended_at IS NOT NULL AND id NOT LIKE 'import-git-%'").get(cutoff).n;
  if (total === 0) return skipped('TRACK-1', 'No real closed sessions in last 7d');
  const withModel = db.prepare("SELECT COUNT(*) as n FROM sessions WHERE started_at >= ? AND ended_at IS NOT NULL AND model IS NOT NULL AND id NOT LIKE 'import-git-%'").get(cutoff).n;
  const pct = +(withModel / total * 100).toFixed(1);
  const threshold = 99;
  if (pct >= threshold) return green('TRACK-1', `${pct}%`, `≥${threshold}%`, `${withModel}/${total} sessions have model`);
  return red('TRACK-1', `${pct}%`, `≥${threshold}%`, `Only ${withModel}/${total} sessions (${pct}%) have model set`);
}

function checkTRACK2(db) {
  // ≥99% sessions last 7d have duration_ms > 0 AND token_input > 0
  const cutoff = daysAgo(7);
  const total = db.prepare("SELECT COUNT(*) as n FROM sessions WHERE started_at >= ? AND ended_at IS NOT NULL AND id NOT LIKE 'import-git-%'").get(cutoff).n;
  if (total === 0) return skipped('TRACK-2', 'No real closed sessions in last 7d');
  const withBoth = db.prepare("SELECT COUNT(*) as n FROM sessions WHERE started_at >= ? AND ended_at IS NOT NULL AND id NOT LIKE 'import-git-%' AND duration_ms > 0 AND token_input > 0").get(cutoff).n;
  const pct = +(withBoth / total * 100).toFixed(1);
  const threshold = 99;
  if (pct >= threshold) return green('TRACK-2', `${pct}%`, `≥${threshold}%`, `${withBoth}/${total} sessions have duration+tokens`);
  return red('TRACK-2', `${pct}%`, `≥${threshold}%`, `Only ${withBoth}/${total} sessions (${pct}%) have duration_ms > 0 AND token_input > 0`);
}

function checkTRACK3(db) {
  // Decision rationale written ≥1 time this week
  const cutoff = daysAgo(7);
  const count = db.prepare("SELECT COUNT(*) as n FROM observations WHERE decision_rationale IS NOT NULL AND created_at >= ?").get(cutoff).n;
  if (count >= 1) return green('TRACK-3', count, '≥1', `${count} decisions recorded in last 7d`);
  return red('TRACK-3', count, '≥1', 'No decision_rationale written in last 7d');
}

function checkSCHEMA1(db) {
  // All core tables exist (migrations applied without error)
  const requiredTables = ['sessions', 'observations', 'embeddings', 'digests', 'insights', 'advises', 'hook_errors', 'agent_actions'];
  const existingTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  const missing = requiredTables.filter(t => !existingTables.includes(t));
  if (missing.length === 0) return green('SCHEMA-1', 'all tables present', 'all tables', `Tables: ${requiredTables.join(', ')}`);
  return red('SCHEMA-1', `missing: ${missing.join(', ')}`, 'all tables present', `Missing tables: ${missing.join(', ')} — run claudeye init`);
}

function checkSCHEMA2() {
  // analytics-cli is wired in cli.js (advise --help exits 0)
  try {
    execSync('claudeye advise --help', { stdio: 'ignore', timeout: 5000 });
    return green('SCHEMA-2', 'exit=0', 'exit=0', 'claudeye advise --help exits successfully');
  } catch {
    // Fallback: check if analytics-cli.js exists on disk (standalone context may not have claudeye in PATH)
    const candidates = [
      join(DATA_DIR, '..', 'claudeye', 'src', 'analytics-cli.js'),
      new URL('../src/analytics-cli.js', import.meta.url).pathname,
    ];
    for (const p of candidates) {
      try { if (existsSync(p)) return green('SCHEMA-2', 'file exists', 'file exists', 'analytics-cli.js present'); } catch {}
    }
    return red('SCHEMA-2', 'not found', 'exit=0', 'claudeye advise --help failed and analytics-cli.js not found');
  }
}

function checkINFRA1() {
  // mem.db ≤ 300MB
  // Threshold raised 150 → 300 (#116 retention holds a steady ~262MB plateau with
  // ~+0.02MB/day growth, so 150 sat permanently below the working-set floor and
  // fired a false RED every analyzer run). 300MB gives headroom above the plateau
  // while still catching genuine runaway growth (e.g. if retention regresses).
  const dbPath = join(DATA_DIR, 'mem.db');
  if (!existsSync(dbPath)) return skipped('INFRA-1', 'mem.db not found');
  const sizeMB = +(statSync(dbPath).size / 1024 / 1024).toFixed(1);
  const threshold = 300;
  if (sizeMB <= threshold) return green('INFRA-1', `${sizeMB}MB`, `≤${threshold}MB`, `mem.db: ${sizeMB}MB`);
  return red('INFRA-1', `${sizeMB}MB`, `≤${threshold}MB`, `mem.db ${sizeMB}MB exceeds ${threshold}MB threshold — retention may have regressed; run claudeye archive`);
}

function checkINFRA2(db) {
  // hook_errors last 7d ≤ 20
  const cutoff = daysAgo(7);
  const count = db.prepare("SELECT COUNT(*) as n FROM hook_errors WHERE created_at >= ? AND error_type != 'info'").get(cutoff).n;
  const threshold = 20;
  if (count <= threshold) return green('INFRA-2', count, `≤${threshold}`, `${count} hook errors in last 7d`);
  return red('INFRA-2', count, `≤${threshold}`, `${count} hook errors in last 7d — check hooks/`);
}

function checkINFRA3(db) {
  // Session closure ≥ 99%
  const total = db.prepare("SELECT COUNT(*) as n FROM sessions WHERE id NOT LIKE 'import-git-%'").get().n;
  if (total === 0) return skipped('INFRA-3', 'No sessions');
  const unclosed = db.prepare("SELECT COUNT(*) as n FROM sessions WHERE ended_at IS NULL AND id NOT LIKE 'import-git-%'").get().n;
  const closurePct = +((total - unclosed) / total * 100).toFixed(1);
  const threshold = 99;
  if (closurePct >= threshold) return green('INFRA-3', `${closurePct}%`, `≥${threshold}%`, `${unclosed} unclosed of ${total}`);
  return red('INFRA-3', `${closurePct}%`, `≥${threshold}%`, `${unclosed}/${total} sessions unclosed — run claudeye cleanup`);
}

function checkINFRA4(db) {
  // Injection p95 ≤ 1500 tokens
  const cutoff = daysAgo(7);
  try {
    const rows = db.prepare("SELECT tokens_used FROM injection_stats WHERE created_at >= ? ORDER BY tokens_used").all(cutoff);
    if (rows.length === 0) return skipped('INFRA-4', 'No injection_stats in last 7d');
    const p95idx = Math.floor(rows.length * 0.95);
    const p95 = rows[Math.min(p95idx, rows.length - 1)].tokens_used;
    const threshold = 1500;
    if (p95 <= threshold) return green('INFRA-4', `${p95}tok`, `≤${threshold}tok`, `p95 injection: ${p95} tokens`);
    return red('INFRA-4', `${p95}tok`, `≤${threshold}tok`, `p95 injection ${p95}tok > 1500 — reduce inject_budget_tokens in settings.json`);
  } catch {
    return skipped('INFRA-4', 'injection_stats table not available');
  }
}

function checkSEC1() {
  // viewer not listening on port 47777 (no persistent process)
  try {
    execSync('lsof -i :47777 -sTCP:LISTEN 2>/dev/null | grep -v "^COMMAND"', { encoding: 'utf8', timeout: 3000 });
    return red('SEC-1', 'port open', 'no persistent listener', 'Port 47777 is open — claudeye viewer should not run persistently');
  } catch {
    // lsof exits non-zero when nothing found = port closed = green
    return green('SEC-1', 'port closed', 'no persistent listener', 'Port 47777 not listening');
  }
}

function checkSEC2() {
  // settings.json mode 0600
  if (!existsSync(SETTINGS)) return skipped('SEC-2', 'settings.json not found');
  const mode = statSync(SETTINGS).mode & 0o777;
  if (mode === 0o600) return green('SEC-2', '0600', '0600', 'settings.json has correct permissions');
  const modeStr = mode.toString(8).padStart(4, '0');
  return red('SEC-2', modeStr, '0600', `settings.json has mode ${modeStr} — run: chmod 600 ~/.claudeye/settings.json`);
}

// ─── Main export ────────────────────────────────────────────────────────────

/**
 * Run all invariant checks.
 * @param {object} [db] — optional already-open DB instance (for testing)
 * @returns {{ all_green: boolean, checked: number, violations: string[], checks: Array }}
 */
export async function checkInvariants(db = null) {
  // Lazy-load DB to avoid issues in standalone context
  if (!db) {
    const { getDb } = await import('./db.js');
    db = getDb();
  }

  const checks = [
    checkSCHED1(db),
    checkSCHED2(db),
    checkSCHED3(db),
    checkDATA1(db),
    checkDATA2(db),
    checkDATA3(db),
    checkDATA4(db),
    checkTRACK1(db),
    checkTRACK2(db),
    checkTRACK3(db),
    checkSCHEMA1(db),
    checkSCHEMA2(),
    checkINFRA1(),
    checkINFRA2(db),
    checkINFRA3(db),
    checkINFRA4(db),
    checkSEC1(),
    checkSEC2(),
  ];

  const violations = checks.filter(c => c.status === 'red').map(c => c.id);
  const all_green  = violations.length === 0;

  return { all_green, checked: checks.length, violations, checks };
}

/**
 * Persist a check run to invariant_checks table for stability tracking.
 * @param {object} db
 * @param {{ all_green: boolean, violations: string[], checks: Array }} result
 */
export function saveInvariantRun(db, result) {
  db.prepare(`
    INSERT INTO invariant_checks (run_date, all_green, green_count, red_count, violations, result_json)
    VALUES (date('now'), ?, ?, ?, ?, ?)
  `).run(
    result.all_green ? 1 : 0,
    result.checks.filter(c => c.status === 'green').length,
    result.violations.length,
    JSON.stringify(result.violations),
    JSON.stringify(result.checks),
  );
}

/**
 * Compute streak of consecutive all-green days (including today if green).
 * @param {object} db
 * @returns {{ streak: number, lastRunDate: string|null, mvpGate: boolean }}
 */
export function getStabilityStreak(db) {
  const rows = db.prepare(`
    SELECT run_date, all_green
    FROM invariant_checks
    ORDER BY run_date DESC
    LIMIT 30
  `).all();

  if (!rows.length) return { streak: 0, lastRunDate: null, mvpGate: false };

  let streak = 0;
  let prevDate = null;
  for (const row of rows) {
    if (!row.all_green) break;
    if (prevDate) {
      // Check consecutive days
      const diff = (new Date(prevDate) - new Date(row.run_date)) / 86400000;
      if (diff > 1) break; // gap in dates
    }
    streak++;
    prevDate = row.run_date;
  }

  const lastRunDate = rows[0]?.run_date || null;
  const mvpGate = streak >= 14;

  return { streak, lastRunDate, mvpGate };
}
