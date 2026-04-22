#!/usr/bin/env node
/**
 * hooks/summary-hook.js — Stop hook (session end)
 *
 * Called by Claude Code when a session ends.
 * Generates a compressed session summary and stores it.
 */

import { readFileSync, existsSync } from 'fs';

const __dir = new URL('.', import.meta.url).pathname;
const srcDir = __dir + '../src/';

/**
 * Parse a Claude Code transcript JSONL to extract aggregated token counts and model.
 * The Stop event provides transcript_path; the JSONL has one JSON object per line,
 * assistant messages have shape: { type: 'assistant', message: { model, usage: { input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens } } }
 *
 * @param {string} transcriptPath
 * @returns {{ tokenInput: number|null, tokenOutput: number|null, model: string|null }}
 */
function parseTranscript(transcriptPath) {
  try {
    if (!transcriptPath || !existsSync(transcriptPath)) return { tokenInput: null, tokenOutput: null, model: null };
    const lines = readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean);
    let totalInput = 0, totalOutput = 0, lastModel = null;
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj.type !== 'assistant') continue;
        const msg = obj.message;
        if (!msg) continue;
        if (msg.model) lastModel = msg.model;
        if (msg.usage) {
          // Count all input token variants (base + cache creation + cache read)
          totalInput  += (msg.usage.input_tokens || 0)
                       + (msg.usage.cache_creation_input_tokens || 0)
                       + (msg.usage.cache_read_input_tokens || 0);
          totalOutput += (msg.usage.output_tokens || 0);
        }
      } catch { /* skip malformed lines */ }
    }
    return {
      tokenInput:  totalInput  > 0 ? totalInput  : null,
      tokenOutput: totalOutput > 0 ? totalOutput : null,
      model: lastModel,
    };
  } catch {
    return { tokenInput: null, tokenOutput: null, model: null };
  }
}

async function main() {
  let event;

  try {
    const raw = readFileSync('/dev/stdin', 'utf8');
    event = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const { session_id: sessionId, transcript_path: transcriptPath, model: eventModel, token_input, token_output, total_tokens_in, total_tokens_out } = event;
  if (!sessionId) process.exit(0);

  // (#81) Extract token counts + model from transcript (most reliable source)
  const fromTranscript = parseTranscript(transcriptPath);

  // Fallback chain: transcript → event fields → env vars
  const model = fromTranscript.model || eventModel || process.env.CLAUDE_MODEL || process.env.ANTHROPIC_MODEL || null;
  const tokenInput  = fromTranscript.tokenInput  ?? token_input  ?? total_tokens_in  ?? null;
  const tokenOutput = fromTranscript.tokenOutput ?? token_output ?? total_tokens_out ?? null;

  console.error(`[mem:summary] event keys: ${Object.keys(event).join(', ')} | transcript: ${transcriptPath ? 'found' : 'missing'} | model: ${model} | tokens: ${tokenInput}/${tokenOutput}`);

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
