#!/usr/bin/env node
/**
 * hooks/summary-hook.js — Stop hook (session end)
 *
 * Called by Claude Code when a session ends.
 * Generates a compressed session summary and stores it.
 */

import { readFileSync } from 'fs';

const __dir = new URL('.', import.meta.url).pathname;
const srcDir = __dir + '../src/';

async function main() {
  let event;

  try {
    const raw = readFileSync('/dev/stdin', 'utf8');
    event = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const { session_id: sessionId } = event;
  if (!sessionId) process.exit(0);

  const project = process.env.CLAUDE_PROJECT_DIR || process.cwd();

  try {
    const { getDb, closeSession } = await import(srcDir + 'db.js');
    const { compressSession }     = await import(srcDir + 'compress.js');
    const { computeFrictionScore } = await import(srcDir + 'analytics.js');

    const db = getDb();
    const observations = db.prepare(`
      SELECT tool, summary, importance
      FROM observations
      WHERE session_id = ?
      ORDER BY importance DESC
    `).all(sessionId);

    if (!observations.length) {
      process.exit(0);
    }

    const summary = await compressSession({ observations, project });
    if (summary) closeSession(sessionId, summary, { computeFriction: computeFrictionScore });

    console.error(`[mem:summary] session closed with ${observations.length} observations`);

    // ── Weekly digest auto-trigger (#79) ──────────────────────
    // Check if digest for current week exists; if not, generate it.
    // More reliable than launchd (which misses runs when Mac sleeps).
    // Runs async, non-blocking — digest failure doesn't affect session close.
    try {
      const now = new Date();
      const dayOfWeek = now.getDay();
      // Only attempt on Monday+ (so full week of data is available)
      if (dayOfWeek >= 1) {
        const monday = new Date(now);
        monday.setDate(now.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
        const weekStart = monday.toISOString().slice(0, 10);

        const existing = db.prepare('SELECT id FROM digests WHERE week_start = ?').get(weekStart);
        if (!existing) {
          console.error(`[mem:digest] No digest for ${weekStart}, generating...`);
          const { generateWeeklyDigest } = await import(srcDir + 'advisor.js');
          await generateWeeklyDigest();
          console.error(`[mem:digest] Done.`);
        }
      }
    } catch (e) {
      console.error(`[mem:digest] auto-trigger skipped: ${e.message}`);
    }

  } catch (err) {
    console.error('[mem:summary] error:', err.message);
  }

  process.exit(0);
}

main();
