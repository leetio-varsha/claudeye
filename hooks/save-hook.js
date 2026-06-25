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

  const { tool_name: tool, tool_input: rawInput, tool_response: rawOutput, session_id: sessionId, duration_ms: eventDuration, model: eventModel, transcript_path: transcriptPath } = event;

  if (!tool || !sessionId) process.exit(0);

  // (#81) Capture model from event or env — update session if available.
  // (#87 fix) Claude Code PostToolUse events usually don't include `model`, so
  // fall back to reading the last assistant turn from the transcript JSONL.
  // This is cheap (reverse-scan) and only runs when we don't already have a
  // model — otherwise the session stays model=NULL for its entire lifetime.
  let model = eventModel || process.env.CLAUDE_MODEL || process.env.ANTHROPIC_MODEL || null;
  if (!model && transcriptPath) {
    try {
      const { existsSync, readFileSync } = await import('fs');
      if (existsSync(transcriptPath)) {
        const lines = readFileSync(transcriptPath, 'utf8').split('\n');
        for (let i = lines.length - 1; i >= 0; i--) {
          if (!lines[i]) continue;
          try {
            const msg = JSON.parse(lines[i]);
            const m = msg.message?.model || msg.model;
            if (m) { model = m; break; }
          } catch { /* skip non-JSON line */ }
        }
      }
    } catch { /* non-critical — leave model as null */ }
  }

  // Normalize worktree paths to parent project (#78)
  // .claude/worktrees/<name> → parent project
  const rawProject = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const worktreeMatch = rawProject.match(/^(.+?)\/\.claude\/worktrees\/.+$/);
  const project = worktreeMatch ? worktreeMatch[1] : rawProject;

  // Strip <private>…</private> content before any processing (#6)
  const stripPrivate = (s) => {
    if (typeof s !== 'string') return s;
    return s.replace(/<private>[\s\S]*?<\/private>/gi, '[REDACTED]');
  };
  const input  = stripPrivate(typeof rawInput  === 'string' ? rawInput  : JSON.stringify(rawInput));
  const output = stripPrivate(typeof rawOutput === 'string' ? rawOutput : JSON.stringify(rawOutput));

  try {
    const { saveObservation, saveEmbedding, upsertSession, isDegenerateProject, logHookError } = await import(srcDir + 'db.js');
    const { compressObservation }                           = await import(srcDir + 'compress.js');
    const { embedWithMeta }                                 = await import(srcDir + 'embeddings.js');

    // #121: skip Claudeye's own Cowork scheduled/agent runs (project resolves to
    // '/' or $TMPDIR). Exit before upsertSession/saveObservation so we neither
    // create junk sessions nor trip the observations FK and pollute hook_errors.
    if (isDegenerateProject(project)) process.exit(0);

    // Ensure session exists — pass model if available (#81)
    upsertSession(sessionId, project, { model });

    // Skip very noisy low-value tools
    const SKIP_TOOLS = new Set(['TodoRead', 'mcp__mem__search']);
    if (SKIP_TOOLS.has(tool)) process.exit(0);

    // (#116) Ingest dedup: skip consecutive duplicate Bash/Read events.
    // Heavy quota-sessions repeat identical commands/paths back-to-back —
    // they add no information and bloat the DB (+20–36 MB/день). Checked
    // BEFORE AI compression, so duplicates also save an API call.
    const DEDUP_TOOLS = new Set(['Bash', 'Read']);
    if (DEDUP_TOOLS.has(tool)) {
      try {
        const { isConsecutiveDuplicate } = await import(srcDir + 'db.js');
        if (isConsecutiveDuplicate({ sessionId, tool, rawInput: input })) process.exit(0);
      } catch { /* non-critical — fall through to normal save */ }
    }

    // AI compress (input/output already sanitized via stripPrivate above)
    const { summary, tags, importance, decisionRationale, aiCompressed, fallbackReason } = await compressObservation({
      tool, input, output, project,
    });

    // Track compress fallbacks (#80) — visibility into AI success rate
    if (!aiCompressed) {
      logHookError('save-hook', 'compress_fallback', fallbackReason || 'unknown', project);
    }

    // Skip noise
    if (importance < 0.1) process.exit(0);

    // (#116) Decisions dedup: the ×16 spike was the same rationale re-extracted
    // on every turn of a heavy session. Keep the observation, but drop the
    // duplicate rationale (and its 'decision' tag) so decisions count stays honest.
    let finalRationale = decisionRationale;
    let finalTags = tags;
    if (finalRationale) {
      try {
        const { hasDuplicateDecision } = await import(srcDir + 'db.js');
        if (hasDuplicateDecision(sessionId, finalRationale)) {
          finalRationale = null;
          finalTags = tags.filter(t => t !== 'decision');
        }
      } catch { /* non-critical — keep rationale */ }
    }

    // Store observation (raw fields are already stripped of private content)
    const obsId = saveObservation({
      sessionId, project, tool, summary,
      rawInput:  input,
      rawOutput: output,
      tags: finalTags, importance, decisionRationale: finalRationale,
      durationMs: eventDuration ?? null,  // (#81) from hook event if available
    });

    // Opportunistic: close orphaned sessions older than 4h (#60)
    // Lightweight check — runs at most once per session
    try {
      const { closeOrphanedSessions } = await import(srcDir + 'db.js');
      const { computeFrictionScore } = await import(srcDir + 'analytics.js');
      closeOrphanedSessions({ maxAgeHours: 4, computeFriction: computeFrictionScore });
    } catch { /* non-critical */ }

    // Opportunistic: auto-compact when DB > 100MB (#76)
    // ~5% chance per save to avoid running every time
    if (Math.random() < 0.05) {
      try {
        const { autoCleanup } = await import(srcDir + 'db.js');
        autoCleanup({ maxSizeMB: 100 });
      } catch { /* non-critical */ }
    }

    // Generate and store embedding — must await before exit
    try {
      const { vector, model } = await embedWithMeta(summary);
      saveEmbedding(obsId, vector, model);
    } catch (e) {
      logHookError('save-hook', 'embed_failed', e.message, project);
    }

    // Opportunistic: update Knowledge Graph (#26)
    try {
      const { addObservationToGraph } = await import(srcDir + 'graph.js');
      addObservationToGraph({
        id: obsId, project, tool, summary,
        tags: JSON.stringify(finalTags),
        importance, decision_rationale: finalRationale,
        raw_input: input,
      });
    } catch { /* non-critical */ }

    // Opportunistic: auto-register project in registry (#27)
    try {
      const { registerProject } = await import(srcDir + 'project-registry.js');
      registerProject(project);
    } catch { /* non-critical */ }

  } catch (err) {
    try { logHookError('save-hook', 'general', err.message, project); } catch {}
    // Always exit 0 — never block Claude Code
  }

  process.exit(0);
}

main();
