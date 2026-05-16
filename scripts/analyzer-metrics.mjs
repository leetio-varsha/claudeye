#!/usr/bin/env node
/**
 * scripts/analyzer-metrics.mjs — aggregate metrics for claudeye-analyzer scheduled task.
 *
 * Prints ONE JSON object to stdout so the scheduled task can collect everything
 * from the DB in a single shell invocation (vs. 10+ separate osascript/Bash calls,
 * which previously tripped the AUP classifier — see analyzer-crash-body.md).
 *
 * Usage:
 *   node scripts/analyzer-metrics.mjs
 *
 * Output shape: { ok: true, db: {...metrics...} } or { ok: false, error: '...' }
 * Exits 0 on success, 1 on fatal error — but ALWAYS prints valid JSON.
 */

import { getDb } from '../src/db.js';

function safeVal(db, sql) {
  try { return db.prepare(sql).get(); }
  catch (e) { return { error: e.message }; }
}
function safeAll(db, sql) {
  try { return db.prepare(sql).all(); }
  catch (e) { return [{ error: e.message }]; }
}

function run() {
  const db = getDb();

  const result = {
    obs:                safeVal(db, 'SELECT COUNT(*) AS n FROM observations'),
    emb:                safeVal(db, 'SELECT COUNT(*) AS n FROM embeddings'),
    // emb_embeddable: embeddings for importance>=0.5 obs only (correct coverage denominator — #106)
    emb_embeddable:     safeVal(db, `
      SELECT
        COUNT(e.observation_id) AS embedded,
        COUNT(o.id)             AS embeddable
      FROM observations o
      LEFT JOIN embeddings e ON e.observation_id = o.id
      WHERE o.importance >= 0.5
        AND (
          o.tool != 'git-commit'
          OR o.id IN (
            SELECT id FROM (
              SELECT id, ROW_NUMBER() OVER (PARTITION BY project ORDER BY created_at DESC) AS rn
              FROM observations WHERE tool = 'git-commit'
            ) WHERE rn <= 50
          )
        )
    `),
    sessions:           safeVal(db, 'SELECT COUNT(*) AS n FROM sessions'),
    ai_summaries:       safeVal(db, `SELECT COUNT(*) AS n FROM sessions WHERE summary IS NOT NULL AND summary NOT LIKE '%Session with%' AND summary NOT LIKE '%auto-closed%'`),
    decisions:          safeVal(db, 'SELECT COUNT(*) AS n FROM observations WHERE decision_rationale IS NOT NULL'),
    hook_errors_7d:     safeVal(db, `SELECT COUNT(*) AS n FROM hook_errors WHERE created_at > datetime('now','-7 days')`),
    compress_fallbacks: safeVal(db, `SELECT COUNT(*) AS n FROM hook_errors WHERE error_type='compress_fallback' AND created_at > datetime('now','-7 days')`),
    digests:            safeVal(db, 'SELECT COUNT(*) AS n FROM digests'),
    insights:           safeVal(db, 'SELECT COUNT(*) AS n FROM insights'),
    date_range:         safeVal(db, 'SELECT MIN(created_at) AS first_obs, MAX(created_at) AS last_obs FROM observations'),
    tools:              safeAll(db, 'SELECT tool, COUNT(*) AS cnt FROM observations GROUP BY tool ORDER BY cnt DESC LIMIT 10'),
    with_duration:      safeVal(db, 'SELECT COUNT(*) AS n FROM sessions WHERE duration_ms IS NOT NULL'),
    with_model:         safeVal(db, 'SELECT COUNT(*) AS n FROM sessions WHERE model IS NOT NULL'),
    with_tokens:        safeVal(db, 'SELECT COUNT(*) AS n FROM sessions WHERE token_input IS NOT NULL'),
    db_pages:           safeVal(db, 'PRAGMA page_count'),
    db_page_size:       safeVal(db, 'PRAGMA page_size'),
    last_digest_at:     safeVal(db, 'SELECT MAX(created_at) AS at FROM digests'),
    last_insight_at:    safeVal(db, 'SELECT MAX(created_at) AS at FROM insights'),
  };

  return result;
}

try {
  const db = run();
  process.stdout.write(JSON.stringify({ ok: true, db }, null, 2) + '\n');
  process.exit(0);
} catch (e) {
  process.stdout.write(JSON.stringify({ ok: false, error: e.message, stack: e.stack }) + '\n');
  process.exit(1);
}
