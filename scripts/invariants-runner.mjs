#!/usr/bin/env node
/**
 * scripts/invariants-runner.mjs — Standalone invariants checker (#99)
 *
 * Запускает все invariant checks, пишет результат в invariant_checks таблицу,
 * логирует heartbeat. Паттерн аналогичен behavioral-standalone.mjs и
 * insights-standalone.js.
 *
 * Использование:
 *   node ~/.claudeye/invariants-runner.mjs              # run + save to DB
 *   node ~/.claudeye/invariants-runner.mjs --dry-run    # print only, no DB write
 *   node ~/.claudeye/invariants-runner.mjs --json       # output JSON to stdout
 *
 * Запускается из unified scheduler (insights-runner.sh) раз в день.
 * Этот файл деплоится: scripts/invariants-runner.mjs → ~/.claudeye/
 */

import { createRequire }                    from 'module';
import { appendFileSync, mkdirSync, existsSync } from 'fs';
import { join }                             from 'path';
import { homedir }                          from 'os';

// ─── Paths ───────────────────────────────────────────────────────────────────
const DATA_DIR    = join(homedir(), '.claudeye');
const DB_PATH     = join(DATA_DIR, 'mem.db');
const LOG_DIR     = join(DATA_DIR, 'logs');
const HEARTBEAT   = join(LOG_DIR, 'insights-heartbeat.log');
const PKG_PATH    = join(DATA_DIR, 'package.json');

// ─── Args ────────────────────────────────────────────────────────────────────
const args     = process.argv.slice(2);
const DRY_RUN  = args.includes('--dry-run');
const JSON_OUT = args.includes('--json');

// ─── Logging ─────────────────────────────────────────────────────────────────
function log(msg) {
  const line = `${new Date().toISOString()} ${msg}\n`;
  try { appendFileSync(HEARTBEAT, line); } catch {}
  if (!JSON_OUT) process.stderr.write(line);
}

function ensureLogDir() {
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  ensureLogDir();
  log('[invariants] start' + (DRY_RUN ? ' (dry-run)' : ''));

  // Load DB via package installed in ~/.claudeye/
  let _require;
  try {
    _require = createRequire(PKG_PATH);
  } catch {
    // Fallback: load from wherever this script lives
    _require = createRequire(import.meta.url);
  }

  const Database = _require('better-sqlite3');
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  // Ensure invariant_checks table exists (idempotent)
  db.exec(`
    CREATE TABLE IF NOT EXISTS invariant_checks (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      run_date    TEXT    NOT NULL,
      all_green   INTEGER NOT NULL DEFAULT 0,
      green_count INTEGER NOT NULL DEFAULT 0,
      red_count   INTEGER NOT NULL DEFAULT 0,
      violations  TEXT    NOT NULL DEFAULT '[]',
      result_json TEXT,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_invariant_checks_date ON invariant_checks(run_date);
  `);

  // ─── Run invariant checks (inline to avoid ESM import resolution issues) ───
  const { checkInvariants, saveInvariantRun, getStabilityStreak } = await import(
    join(DATA_DIR, '..', 'claudeye', 'src', 'invariants.js')
  ).catch(async () => {
    // Fallback: try relative to this file
    return import('../src/invariants.js');
  });

  const result = await checkInvariants(db);

  if (JSON_OUT) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else if (DRY_RUN) {
    const icon = result.all_green ? '✅' : '❌';
    console.log(`${icon} Invariants: ${result.checks.filter(c => c.status === 'green').length} green, ${result.violations.length} red`);
    for (const c of result.checks) {
      const mark = c.status === 'green' ? '✓' : c.status === 'red' ? '✗' : '~';
      console.log(`  ${mark} ${c.id.padEnd(10)} ${c.detail}`);
    }
  }

  if (!DRY_RUN) {
    // Upsert: replace same-day row if re-run
    db.prepare(`
      INSERT OR REPLACE INTO invariant_checks (run_date, all_green, green_count, red_count, violations, result_json)
      VALUES (date('now'), ?, ?, ?, ?, ?)
    `).run(
      result.all_green ? 1 : 0,
      result.checks.filter(c => c.status === 'green').length,
      result.violations.length,
      JSON.stringify(result.violations),
      JSON.stringify(result.checks),
    );
  }

  const streak = getStabilityStreak(db);
  const summary = result.all_green
    ? `all_green=true streak=${streak.streak}${streak.mvpGate ? ' MVP_GATE_READY' : ''}`
    : `violations=${result.violations.join(',')} streak=0`;

  log(`[invariants] finish exit=0 ${summary}`);

  if (!DRY_RUN && streak.mvpGate && result.all_green) {
    log('[invariants] 🎉 MVP gate: 14 consecutive days all-green!');
  }

  db.close();
  process.exit(0);
}

main().catch(err => {
  log(`[invariants] ERROR ${err.message}`);
  process.exit(1);
});
