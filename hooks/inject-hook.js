#!/usr/bin/env node
/**
 * hooks/inject-hook.js — UserPromptSubmit hook
 *
 * Called by Claude Code before each user prompt is processed.
 * Prints relevant context to stdout — Claude Code prepends it to the prompt.
 *
 * Claude Code hook contract:
 *   stdin:   JSON { prompt, session_id }
 *   stdout:  text to prepend to the prompt (or empty for no injection)
 *   exit 0:  success
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

  const { prompt, session_id: sessionId } = event;

  if (!prompt?.trim()) process.exit(0);

  const project = process.env.CLAUDE_PROJECT_DIR || process.cwd();

  try {
    const { upsertSession } = await import(srcDir + 'db.js');
    const { buildContext }  = await import(srcDir + 'search.js');

    upsertSession(sessionId, project);

    const context = await buildContext(prompt, project);

    if (context) {
      process.stdout.write(context + '\n\n');
    }
  } catch (err) {
    console.error('[mem:inject] error:', err.message);
    // Exit cleanly — don't block Claude Code on memory failure
  }

  process.exit(0);
}

main();
