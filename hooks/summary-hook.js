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

  const { session_id: sessionId, model: eventModel, token_input, token_output, total_tokens_in, total_tokens_out } = event;
  if (!sessionId) process.exit(0);

  // (#81) Extract model from event or env
  const model = eventModel || process.env.CLAUDE_MODEL || process.env.ANTHROPIC_MODEL || null;
  // (#81) Extract token counts — try multiple field names since hook contract may vary
  const tokenInput  = token_input  ?? total_tokens_in  ?? null;
  const tokenOutput = token_output ?? total_tokens_out ?? null;

  // (#81) Diagnostic: log full stop event keys to discover available fields
  console.error(`[mem:summary] event keys: ${Object.keys(event).join(', ')}`);

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

    // Always close the session, even if AI summary fails — otherwise #81
    // tracking fields (model/token_input/token_output/duration_ms) are
    // never written, leaving sessions table NULL across the board.
    // Fallback summary preserves countability without losing telemetry.
    const aiSummary = await compressSession({ observations, project });
    const summary = aiSummary || `[fallback] Session with ${observations.length} observations in ${project}.`;
    closeSession(sessionId, summary, {
      computeFriction: computeFrictionScore,
      model,
      tokenInput,
      tokenOutput,
    });

    console.error(`[mem:summary] session closed with ${observations.length} observations${aiSummary ? '' : ' (fallback summary)'}`);

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
