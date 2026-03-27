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

  const { tool_name: tool, tool_input: input, tool_response: output, session_id: sessionId } = event;

  if (!tool || !sessionId) process.exit(0);

  const project = process.env.CLAUDE_PROJECT_DIR || process.cwd();

  try {
    const { saveObservation, saveEmbedding, upsertSession } = await import(srcDir + 'db.js');
    const { compressObservation }                           = await import(srcDir + 'compress.js');
    const { embed }                                         = await import(srcDir + 'embeddings.js');

    // Ensure session exists
    upsertSession(sessionId, project);

    // Skip very noisy low-value tools
    const SKIP_TOOLS = new Set(['TodoRead', 'mcp__mem__search']);
    if (SKIP_TOOLS.has(tool)) process.exit(0);

    // AI compress
    const { summary, tags, importance } = await compressObservation({
      tool,
      input:   typeof input  === 'string' ? input  : JSON.stringify(input),
      output:  typeof output === 'string' ? output : JSON.stringify(output),
      project,
    });

    // Skip noise
    if (importance < 0.1) process.exit(0);

    // Store observation
    const obsId = saveObservation({
      sessionId,
      project,
      tool,
      summary,
      rawInput:  typeof input  === 'string' ? input  : JSON.stringify(input),
      rawOutput: typeof output === 'string' ? output : JSON.stringify(output),
      tags,
      importance,
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
