#!/usr/bin/env node
/**
 * scripts/agent-daemon-standalone.mjs — Local Agent Mode one-shot runner (#18)
 *
 * Invoked by launchd (com.claudeye.agent-daemon) every hour.
 * Acquires lock → runs daemon cycle → releases lock → exits.
 *
 * Uses createRequire to resolve better-sqlite3 from the claudeye package
 * (same pattern as digest-standalone.js and insights-standalone.js).
 */

import { createRequire } from 'module';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const HOME         = homedir();
const CLAUDEYE_DIR = join(HOME, '.claudeye');
const LOCK_FILE    = join(CLAUDEYE_DIR, 'daemon.lock');
const CONFIG_FILE  = join(CLAUDEYE_DIR, 'agent-daemon.json');
const LOG_DIR      = join(CLAUDEYE_DIR, 'logs');
const HEARTBEAT    = join(LOG_DIR, 'daemon-heartbeat.log');

function ts() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function log(msg) {
  const line = `${ts()} [daemon] ${msg}\n`;
  process.stderr.write(line);
  try {
    if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
    const fd = require('fs').openSync(HEARTBEAT, 'a');
    require('fs').writeSync(fd, line);
    require('fs').closeSync(fd);
  } catch {}
}

// Resolve better-sqlite3 from the claudeye package location
const require = createRequire(import.meta.url);

// ─── Minimal inline implementations (avoids importing full src/* chain) ───────
// We duplicate only what's needed to avoid TCC / path issues when launchd runs
// from outside ~/Documents.

const DEFAULT_CONFIG = {
  mode: 'confirm',
  intervalHours: 1,
  actions: ['session-analysis', 'db-growth-alert'],
};

function getDaemonConfig() {
  try {
    if (!existsSync(CONFIG_FILE)) return { ...DEFAULT_CONFIG };
    const raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
    return {
      mode:          raw.mode          ?? DEFAULT_CONFIG.mode,
      intervalHours: raw.intervalHours ?? DEFAULT_CONFIG.intervalHours,
      actions:       Array.isArray(raw.actions) ? raw.actions : DEFAULT_CONFIG.actions,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function acquireLock() {
  if (!existsSync(CLAUDEYE_DIR)) mkdirSync(CLAUDEYE_DIR, { recursive: true });
  if (existsSync(LOCK_FILE)) {
    try {
      const { pid, ts: lockTs } = JSON.parse(readFileSync(LOCK_FILE, 'utf8'));
      const age = Date.now() - new Date(lockTs).getTime();
      if (age <= 2 * 60 * 60 * 1000) return false; // active lock
      unlinkSync(LOCK_FILE); // stale
    } catch {
      try { unlinkSync(LOCK_FILE); } catch {}
    }
  }
  writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }), 'utf8');
  return true;
}

function releaseLock() {
  try {
    if (!existsSync(LOCK_FILE)) return;
    const { pid } = JSON.parse(readFileSync(LOCK_FILE, 'utf8'));
    if (pid === process.pid) unlinkSync(LOCK_FILE);
  } catch {
    try { unlinkSync(LOCK_FILE); } catch {}
  }
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

let _db = null;

function getDb() {
  if (_db) return _db;
  const dbPath = join(HOME, '.claudeye', 'mem.db');
  if (!existsSync(dbPath)) throw new Error(`mem.db not found at ${dbPath}`);
  const Database = require('better-sqlite3');
  _db = new Database(dbPath, { readonly: false });
  return _db;
}

// Mirror of isNoopResult() in src/agent-daemon.js (#115) — keep in sync.
// No-op heartbeats are auto-resolved (feedback='auto') so they never hit the
// human review queue; errors and real findings stay pending.
function isNoopResult(action, result) {
  if (!result || result.error) return false; // errors deserve eyes
  switch (action) {
    case 'session-analysis':
      return (result.new_sessions ?? 0) === 0 && (result.new_observations ?? 0) === 0;
    case 'db-growth-alert':
      return result.anomaly !== true;
    case 'auto-archive':
      return result.skipped === true;
    default:
      return false;
  }
}

function logDaemonAction({ action, query, result, dryRun }) {
  try {
    const db = getDb();
    const noop = isNoopResult(action, result);
    db.prepare(`
      INSERT INTO agent_actions (agent, query, project, result, dry_run, feedback, feedback_at, feedback_note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'daemon',
      query ?? null,
      action,
      result != null ? JSON.stringify(result) : null,
      dryRun ? 1 : 0,
      noop ? 'auto' : null,
      noop ? new Date().toISOString() : null,
      noop ? 'no-op cycle, auto-resolved' : null,
    );
  } catch {}
}

// ─── Actions ─────────────────────────────────────────────────────────────────

function runSessionAnalysis({ intervalHours = 1, dryRun = false }) {
  try {
    const db = getDb();
    // NB (#111, портировано из src/agent-daemon.js): created_at в SQLite хранится как
    // 'YYYY-MM-DD HH:MM:SS'; ISO-формат с 'T' лексикографически больше (' ' < 'T'),
    // поэтому без replace same-day строки не проходят фильтр и счётчик вечно 0.
    const cutoff = new Date(Date.now() - intervalHours * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
    const rows = db.prepare(`
      SELECT COUNT(DISTINCT session_id) AS new_sessions, COUNT(*) AS new_observations
      FROM observations WHERE created_at >= ?
    `).get(cutoff);
    const result = {
      interval_hours:   intervalHours,
      new_sessions:     rows?.new_sessions     ?? 0,
      new_observations: rows?.new_observations ?? 0,
      checked_at:       new Date().toISOString(),
    };
    logDaemonAction({ action: 'session-analysis', query: `Sessions since ${cutoff}`, result, dryRun });
    return result;
  } catch (err) {
    return { error: err.message };
  }
}

function runDbGrowthAlert({ dryRun = false }) {
  try {
    const db = getDb();
    const { page_count } = db.prepare('PRAGMA page_count').get();
    const { page_size  } = db.prepare('PRAGMA page_size').get();
    const sizeMb = (page_count * page_size) / (1024 * 1024);

    const lastAlert = db.prepare(`
      SELECT result, created_at FROM agent_actions
      WHERE agent = 'daemon' AND project = 'db-growth-alert'
      ORDER BY created_at DESC LIMIT 1
    `).get();

    let growthMbPerHour = null;
    let anomaly = false;
    if (lastAlert?.result) {
      try {
        const prev = JSON.parse(lastAlert.result);
        const hoursDiff = (Date.now() - new Date(lastAlert.created_at).getTime()) / (1000 * 60 * 60);
        if (hoursDiff > 0 && prev.size_mb != null) {
          growthMbPerHour = (sizeMb - prev.size_mb) / hoursDiff;
          anomaly = growthMbPerHour > 5;
        }
      } catch {}
    }

    const result = {
      size_mb:            parseFloat(sizeMb.toFixed(2)),
      page_count,
      growth_mb_per_hour: growthMbPerHour != null ? parseFloat(growthMbPerHour.toFixed(3)) : null,
      anomaly,
      checked_at:         new Date().toISOString(),
    };
    logDaemonAction({ action: 'db-growth-alert', query: `DB size check: ${sizeMb.toFixed(1)} MB`, result, dryRun });
    return result;
  } catch (err) {
    return { error: err.message };
  }
}

const ACTION_REGISTRY = {
  'session-analysis': runSessionAnalysis,
  'db-growth-alert':  runDbGrowthAlert,
};

// ─── Main ─────────────────────────────────────────────────────────────────────

log('start');

const config = getDaemonConfig();

if (config.mode === 'off') {
  log('mode=off, skipping');
  process.exit(0);
}

if (!acquireLock()) {
  log('lock busy — another instance running, exiting');
  process.exit(0);
}

const dryRun = config.mode === 'confirm';
log(`mode=${config.mode} dry_run=${dryRun} actions=${config.actions.join(',')}`);

let exitCode = 0;

try {
  for (const actionName of config.actions) {
    const fn = ACTION_REGISTRY[actionName];
    if (!fn) {
      log(`unknown action: ${actionName}`);
      continue;
    }
    log(`running action: ${actionName}`);
    const result = fn({ intervalHours: config.intervalHours, dryRun });
    if (result.error) {
      log(`action ${actionName} error: ${result.error}`);
      exitCode = 1;
    } else {
      log(`action ${actionName} done: ${JSON.stringify(result).slice(0, 120)}`);
    }
  }
} catch (err) {
  log(`fatal: ${err.message}`);
  exitCode = 1;
} finally {
  releaseLock();
  if (_db) { try { _db.close(); } catch {} }
  log(`done exit=${exitCode}`);
}

process.exit(exitCode);
