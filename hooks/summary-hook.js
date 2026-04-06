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
    const { getDb, closeSession, logHookError } = await import(srcDir + 'db.js');
    const { compressSession }     = await import(srcDir + 'compress.js');

    // Log that Stop hook was called — helps debug #60
    logHookError('summary-hook', 'info', `Stop event received for session ${sessionId}`, project);

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
    if (summary) closeSession(sessionId, summary);

    console.error(`[mem:summary] session closed with ${observations.length} observations`);
  } catch (err) {
    console.error('[mem:summary] error:', err.message);
  }

  process.exit(0);
}

main();
