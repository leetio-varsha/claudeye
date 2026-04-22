#!/usr/bin/env node
/**
 * scripts/backfill-duration.js — (#81) One-time backfill of duration_ms for closed sessions.
 *
 * Computes duration_ms from ended_at - started_at for sessions that have both
 * timestamps but NULL duration_ms (all sessions closed before this fix landed).
 *
 * Usage:
 *   node scripts/backfill-duration.js
 *   node scripts/backfill-duration.js --dry-run
 */

import Database from 'better-sqlite3';
import { join } from 'path';
import { homedir } from 'os';

const dryRun = process.argv.includes('--dry-run');
const DB_PATH = join(homedir(), '.claudeye', 'mem.db');

const db = new Database(DB_PATH);

// Count eligible sessions
const { n: eligible } = db.prepare(`
  SELECT COUNT(*) as n FROM sessions
  WHERE duration_ms IS NULL
    AND started_at IS NOT NULL
    AND ended_at   IS NOT NULL
`).get();

console.log(`[backfill-duration] ${eligible} sessions eligible for duration_ms backfill`);

if (eligible === 0) {
  console.log('[backfill-duration] Nothing to do.');
  db.close();
  process.exit(0);
}

if (dryRun) {
  console.log('[backfill-duration] Dry run — no changes written.');
  db.close();
  process.exit(0);
}

// Compute duration_ms as the integer difference between ended_at and started_at (in ms)
// SQLite strftime returns seconds; multiply by 1000 and CAST to INTEGER.
const result = db.prepare(`
  UPDATE sessions
  SET duration_ms = CAST(
    (strftime('%s', ended_at) - strftime('%s', started_at)) * 1000
    AS INTEGER
  )
  WHERE duration_ms IS NULL
    AND started_at IS NOT NULL
    AND ended_at   IS NOT NULL
    AND strftime('%s', ended_at) >= strftime('%s', started_at)
`).run();

console.log(`[backfill-duration] Updated ${result.changes} sessions with duration_ms.`);

// Verify
const { n: remaining } = db.prepare(`
  SELECT COUNT(*) as n FROM sessions WHERE duration_ms IS NULL AND ended_at IS NOT NULL
`).get();
console.log(`[backfill-duration] Remaining NULL duration_ms (closed sessions): ${remaining}`);

db.close();
