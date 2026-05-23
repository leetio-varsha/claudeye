/**
 * src/agent-daemon.js — Local Agent Mode (#18)
 *
 * Background daemon that runs periodic analysis using Claudeye memory.
 * Architecture: launchd one-shot (runs, does work, exits) — not a long-lived process.
 *
 * Responsibilities:
 *   - Acquire/release a file lock to prevent concurrent runs
 *   - Read/write daemon config from ~/.claudeye/agent-daemon.json
 *   - Run one daemon cycle: analyse recent sessions, check DB growth, log actions
 *   - Log all actions to agent_actions table (agent='daemon')
 *
 * Config:
 *   mode: 'auto' | 'confirm' | 'off'  (default: 'confirm')
 *   intervalHours: number              (default: 1)
 *   actions: string[]                  (default: ['session-analysis', 'db-growth-alert'])
 *
 * Safety: in 'confirm' mode, actions are logged as dry_run=1 (suggestions only).
 *         in 'auto' mode, actions execute and log as dry_run=0.
 *         in 'off' mode, runDaemonCycle() returns immediately.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getDb } from './db.js';

const HOME         = homedir();
const CLAUDEYE_DIR = join(HOME, '.claudeye');
const LOCK_FILE    = join(CLAUDEYE_DIR, 'daemon.lock');
const CONFIG_FILE  = join(CLAUDEYE_DIR, 'agent-daemon.json');

// ─── Config ──────────────────────────────────────────────────────────────────

/** @typedef {{ mode: 'auto'|'confirm'|'off', intervalHours: number, actions: string[] }} DaemonConfig */

const DEFAULT_CONFIG = {
  mode: 'confirm',
  intervalHours: 1,
  actions: ['session-analysis', 'db-growth-alert'],
};

/**
 * Read daemon config from ~/.claudeye/agent-daemon.json.
 * Returns defaults if file does not exist or is malformed.
 * @returns {DaemonConfig}
 */
export function getDaemonConfig() {
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

/**
 * Write daemon config to ~/.claudeye/agent-daemon.json.
 * Merges provided fields with existing config.
 * @param {Partial<DaemonConfig>} updates
 * @returns {DaemonConfig}
 */
export function setDaemonConfig(updates) {
  if (!existsSync(CLAUDEYE_DIR)) mkdirSync(CLAUDEYE_DIR, { recursive: true });
  const current = getDaemonConfig();
  const next = { ...current, ...updates };
  writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2) + '\n', 'utf8');
  return next;
}

// ─── Lock ─────────────────────────────────────────────────────────────────────

/**
 * Acquire daemon lock. Returns true if lock acquired, false if already running.
 * Lock file contains PID + timestamp to detect stale locks (> 2 hours old).
 */
export function acquireLock() {
  if (!existsSync(CLAUDEYE_DIR)) mkdirSync(CLAUDEYE_DIR, { recursive: true });

  if (existsSync(LOCK_FILE)) {
    try {
      const { pid, ts } = JSON.parse(readFileSync(LOCK_FILE, 'utf8'));
      const age = Date.now() - new Date(ts).getTime();
      const stale = age > 2 * 60 * 60 * 1000; // 2 hours
      if (!stale) return false; // Another process is running
      // Stale lock — remove it
      unlinkSync(LOCK_FILE);
    } catch {
      // Malformed lock file — remove it
      try { unlinkSync(LOCK_FILE); } catch {}
    }
  }

  writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }), 'utf8');
  return true;
}

/**
 * Release daemon lock (only if owned by current process).
 */
export function releaseLock() {
  try {
    if (!existsSync(LOCK_FILE)) return;
    const { pid } = JSON.parse(readFileSync(LOCK_FILE, 'utf8'));
    if (pid === process.pid) unlinkSync(LOCK_FILE);
  } catch {
    try { unlinkSync(LOCK_FILE); } catch {}
  }
}

/**
 * Check if the lock file exists (daemon may be running).
 * @returns {{ locked: boolean, pid?: number, ts?: string, stale?: boolean }}
 */
export function checkLock() {
  if (!existsSync(LOCK_FILE)) return { locked: false };
  try {
    const { pid, ts } = JSON.parse(readFileSync(LOCK_FILE, 'utf8'));
    const age = Date.now() - new Date(ts).getTime();
    const stale = age > 2 * 60 * 60 * 1000;
    return { locked: true, pid, ts, stale };
  } catch {
    return { locked: true, stale: true };
  }
}

// ─── Daemon Status ────────────────────────────────────────────────────────────

/**
 * Get daemon runtime status: config, lock state, recent actions, launchd info.
 * @returns {object}
 */
export function getDaemonStatus() {
  const config = getDaemonConfig();
  const lock   = checkLock();

  let recentActions = [];
  let lastRunAt     = null;
  try {
    const db = getDb();
    recentActions = db.prepare(`
      SELECT id, agent, query, result, dry_run, created_at
      FROM agent_actions
      WHERE agent = 'daemon'
      ORDER BY created_at DESC
      LIMIT 10
    `).all();
    lastRunAt = recentActions[0]?.created_at ?? null;
  } catch {
    // DB not available
  }

  return { config, lock, recentActions, lastRunAt };
}

// ─── Actions ─────────────────────────────────────────────────────────────────

/**
 * Log a daemon action to agent_actions.
 * @param {object} opts
 * @param {string}  opts.action     — action name (e.g., 'session-analysis')
 * @param {string}  [opts.query]    — description of what was checked
 * @param {object}  [opts.result]   — structured result
 * @param {boolean} [opts.dryRun]   — true in 'confirm' mode
 */
function logDaemonAction({ action, query = null, result = null, dryRun = false }) {
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO agent_actions (agent, query, project, result, dry_run)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      'daemon',
      query,
      action,  // reuse project column as action identifier
      result != null ? JSON.stringify(result) : null,
      dryRun ? 1 : 0,
    );
  } catch {
    // Non-critical
  }
}

/**
 * Action: session-analysis
 * Counts new sessions in the past intervalHours. Surfaces summary stats.
 * In 'auto' mode: logs with dry_run=0.
 * In 'confirm' mode: logs with dry_run=1 (observation only, no side effects).
 */
function runSessionAnalysis({ intervalHours = 1, dryRun = false }) {
  try {
    const db = getDb();
    const cutoff = new Date(Date.now() - intervalHours * 60 * 60 * 1000).toISOString().slice(0, 19);

    const rows = db.prepare(`
      SELECT
        COUNT(DISTINCT session_id) AS new_sessions,
        COUNT(*)                   AS new_observations,
        GROUP_CONCAT(DISTINCT project) AS projects
      FROM observations
      WHERE created_at >= ?
    `).get(cutoff);

    const result = {
      interval_hours:   intervalHours,
      new_sessions:     rows?.new_sessions     ?? 0,
      new_observations: rows?.new_observations ?? 0,
      projects:         rows?.projects ? rows.projects.split(',').filter(Boolean) : [],
      checked_at:       new Date().toISOString(),
    };

    logDaemonAction({
      action: 'session-analysis',
      query:  `Sessions since ${cutoff}`,
      result,
      dryRun,
    });

    return result;
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * Action: db-growth-alert
 * Checks current DB page count. If growth rate signals anomaly, logs an alert.
 * Threshold: > 5 MB growth per hour is anomalous.
 */
function runDbGrowthAlert({ dryRun = false }) {
  try {
    const db = getDb();

    const { page_count } = db.prepare('PRAGMA page_count').get();
    const { page_size  } = db.prepare('PRAGMA page_size').get();
    const sizeMb = (page_count * page_size) / (1024 * 1024);

    // Compare to last daemon db-growth-alert action
    const lastAlert = db.prepare(`
      SELECT result, created_at
      FROM agent_actions
      WHERE agent = 'daemon' AND project = 'db-growth-alert'
      ORDER BY created_at DESC
      LIMIT 1
    `).get();

    let growthMbPerHour = null;
    let anomaly         = false;

    if (lastAlert?.result) {
      const prev = JSON.parse(lastAlert.result);
      const prevMb      = prev.size_mb   ?? null;
      const prevAt      = lastAlert.created_at;
      if (prevMb != null && prevAt) {
        const hoursDiff = (Date.now() - new Date(prevAt).getTime()) / (1000 * 60 * 60);
        if (hoursDiff > 0) {
          growthMbPerHour = (sizeMb - prevMb) / hoursDiff;
          anomaly = growthMbPerHour > 5; // > 5 MB/hour is anomalous
        }
      }
    }

    const result = {
      size_mb:             parseFloat(sizeMb.toFixed(2)),
      page_count,
      growth_mb_per_hour:  growthMbPerHour != null ? parseFloat(growthMbPerHour.toFixed(3)) : null,
      anomaly,
      checked_at:          new Date().toISOString(),
    };

    logDaemonAction({
      action: 'db-growth-alert',
      query:  `DB size check: ${sizeMb.toFixed(1)} MB`,
      result,
      dryRun,
    });

    return result;
  } catch (err) {
    return { error: err.message };
  }
}

// ─── Action Registry ─────────────────────────────────────────────────────────

const ACTION_REGISTRY = {
  'session-analysis': runSessionAnalysis,
  'db-growth-alert':  runDbGrowthAlert,
};

/**
 * Get list of all available action names.
 * @returns {string[]}
 */
export function listAvailableActions() {
  return Object.keys(ACTION_REGISTRY);
}

// ─── Main: runDaemonCycle ────────────────────────────────────────────────────

/**
 * Run one daemon cycle.
 *
 * @param {object}  [opts]
 * @param {boolean} [opts.dryRunOverride]  — force dry_run=true regardless of mode
 * @returns {Promise<{ skipped?: boolean, mode: string, results: object[] }>}
 */
export async function runDaemonCycle({ dryRunOverride = false } = {}) {
  const config = getDaemonConfig();

  if (config.mode === 'off') {
    return { skipped: true, mode: 'off', results: [] };
  }

  const dryRun = dryRunOverride || config.mode === 'confirm';
  const results = [];

  for (const actionName of config.actions) {
    const fn = ACTION_REGISTRY[actionName];
    if (!fn) {
      results.push({ action: actionName, error: 'unknown action' });
      continue;
    }
    const result = fn({ intervalHours: config.intervalHours, dryRun });
    results.push({ action: actionName, result, dryRun });
  }

  return { mode: config.mode, dryRun, results };
}
