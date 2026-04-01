#!/usr/bin/env node
/**
 * hooks/save-hook.js — PostToolUse hook
 *
 * Called by Claude Code after each tool execution.
 * Reads JSON from stdin, compresses with AI, generates embedding, stores.
 *
 * Claude Code hook contract:
 *   stdin:     JSON { tool_name, tool_input, tool_response, session_id }
 *   exit 0:    success or graceful failure (never block Claude Code)
 *   exit 1:    non-blocking error (logged, Claude Code continues)
 */

import { readFileSync } from 'fs';

// Resolve paths relative to this script's location
const __dir = new URL('.', import.meta.url).pathname;
const srcDir = __dir + '../src/';

async function main() {
  let event;

  try {
    const raw = readFileSync('/dev/stdin', 'utf8');
    event = JSON.parse(raw);
  } catch {
    // No input or invalid JSON — silent exit
    process.exit(0);
  }

  const { tool_name: tool, tool_input: rawInput, tool_response: rawOutput, session_id: sessionId } = event;

  if (!tool || !sessionId) process.exit(0);

  const project = process.env.CLAUDE_PROJECT_DIR || process.cwd();

  // Strip <private>…</private> content before any processing (#6)
  const stripPrivate = (s) => {
    if (typeof s !== 'string') return s;
    return s.replace(/<private>[\s\S]*?<\/private>/gi, '[REDACTED]');
  };
  const input  = stripPrivate(typeof rawInput  === 'string' ? rawInput  : JSON.stringify(rawInput));
  const output = stripPrivate(typeof rawOutput === 'string' ? rawOutput : JSON.stringify(rawOutput));

  try {
    const { saveObservation, saveEmbedding, upsertSession } = await import(srcDir + 'db.js');
    const { compressObservation }                           = await import(srcDir + 'compress.js');
    const { embed }                                         = await import(srcDir + 'embeddings.js');

    // Ensure session exists
    upsertSession(sessionId, project);

    // Skip very noisy low-value tools
    const SKIP_TOOLS = new Set(['TodoRead', 'mcp__mem__search']);
    if (SKIP_TOOLS.has(tool)) process.exit(0);

    // AI compress (input/output already sanitized via stripPrivate above)
    const { summary, tags, importance } = await compressObservation({
      tool, input, output, project,
    });

    // Skip noise
    if (importance < 0.1) process.exit(0);

    // Store observation (raw fields are already stripped of private content)
    const obsId = saveObservation({
      sessionId, project, tool, summary,
      rawInput:  input,
      rawOutput: output,
      tags, importance,
    });

    // Generate and store embedding — must await before exit
    try {
      const vec = await embed(summary);
      saveEmbedding(obsId, vec);
    } catch (e) {
      console.error('[mem:save] embed failed:', e.message);
    }

  } catch (err) {
    console.error('[mem:save] error:', err.message);
    // Always exit 0 — never block Claude Code
  }

  process.exit(0);
}

main();
