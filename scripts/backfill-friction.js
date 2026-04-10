#!/usr/bin/env node
/**
 * backfill-friction.js — Recalculate friction_score for all sessions
 *
 * Usage:
 *   node scripts/backfill-friction.js              — run backfill
 *   node scripts/backfill-friction.js --dry-run    — preview without writing
 *
 * Closes #73
 */

import { getDb } from '../src/db.js';
import { computeFrictionScore } from '../src/analytics.js';

const dryRun = process.argv.includes('--dry-run');

const db = getDb();

// Find sessions with friction_score = 0 or NULL that have observations
const sessions = db.prepare(`
  SELECT s.id, s.project, s.friction_score,
         COUNT(o.id) as obs_count
  FROM sessions s
  JOIN observations o ON o.session_id = s.id
  WHERE s.friction_score = 0 OR s.friction_score IS NULL
  GROUP BY s.id
  ORDER BY s.started_at DESC
`).all();

console.log(`Found ${sessions.length} sessions to backfill${dryRun ? ' (DRY RUN)' : ''}\n`);

if (!sessions.length) {
  console.log('Nothing to backfill.');
  process.exit(0);
}

const update = db.prepare('UPDATE sessions SET friction_score = ? WHERE id = ?');

let updated = 0;
let skipped = 0;
const stats = { zero: 0, low: 0, med: 0, high: 0 };

for (const s of sessions) {
  const score = computeFrictionScore(s.id);

  if (score === 0) {
    stats.zero++;
    skipped++;
    continue;
  }

  if (score < 0.1)      stats.low++;
  else if (score < 0.3)  stats.med++;
  else                    stats.high++;

  if (dryRun) {
    const short = s.project.replace(process.env.HOME, '~');
    console.log(`  ${s.id.slice(0, 12)}  ${short.padEnd(45)}  ${s.obs_count} obs  → friction ${score.toFixed(3)}`);
  } else {
    update.run(score, s.id);
  }
  updated++;
}

console.log(`\nResults:`);
console.log(`  Updated:  ${updated}`);
console.log(`  Skipped:  ${skipped} (computed friction = 0, no change needed)`);
console.log(`  Distribution: zero=${stats.zero} low=${stats.low} med=${stats.med} high=${stats.high}`);

if (dryRun) {
  console.log('\n⚠️  Dry run — no changes written. Remove --dry-run to apply.');
} else {
  // Verify
  const result = db.prepare(`
    SELECT COUNT(*) as total,
           SUM(CASE WHEN friction_score > 0 THEN 1 ELSE 0 END) as with_friction,
           AVG(CASE WHEN friction_score > 0 THEN friction_score END) as avg_friction
    FROM sessions
  `).get();
  console.log(`\nVerification:`);
  console.log(`  Total sessions: ${result.total}`);
  console.log(`  With friction > 0: ${result.with_friction} (${(result.with_friction / result.total * 100).toFixed(1)}%)`);
  console.log(`  Avg friction (where > 0): ${result.avg_friction?.toFixed(3) || 'N/A'}`);
}
