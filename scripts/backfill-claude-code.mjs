#!/usr/bin/env node
/**
 * scripts/backfill-claude-code.mjs — one-off backfill of Claude Code CLI
 * transcripts into mem.db.
 *
 * Context (#127): live hooks silently died 2026-06-11 (better-sqlite3 ABI 147
 * vs fnm node ABI 141), so ~27 days of real CLI work never landed in the DB.
 * The transcripts themselves persist under ~/.claude/projects/<proj>/<uuid>.jsonl.
 * This script reconstructs sessions + high-importance observations from them.
 *
 * "Lightweight" mode (default, --min-importance 0.5): keeps only what the
 * retention compactor (#116) would keep long-term — edits/writes and
 * substantive user prompts — plus per-session metadata (model, tokens,
 * started/ended). Raw text, NO AI compression (quota-safe). Embeddings are
 * left for the normal reindex pass.
 *
 * Idempotent: backfilled sessions get id `cc-<uuid>`; a session that already
 * has observations is skipped. Original event timestamps are preserved so the
 * data lands on the correct historical dates (not "now").
 *
 * Usage:
 *   node scripts/backfill-claude-code.mjs --since 2026-06-11 [--until 2026-07-09]
 *                                         [--min-importance 0.5] [--dry-run]
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { parseTranscript, parseUsage } from '../src/import-cowork.js';
import { getDb, upsertSession, saveObservation, closeSession, isDegenerateProject } from '../src/db.js';

// ─── args ──────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
function arg(name, def = null) {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true) : def;
}
const SINCE = arg('since', '2026-06-11');
const UNTIL = arg('until', null);              // exclusive upper bound (YYYY-MM-DD) or null
const MIN_IMP = parseFloat(arg('min-importance', '0.5'));
const DRY = !!arg('dry-run', false);

const sinceMs = Date.parse(SINCE + 'T00:00:00Z');
const untilMs = UNTIL ? Date.parse(UNTIL + 'T00:00:00Z') : Infinity;

const PROJECTS = join(homedir(), '.claude', 'projects');

// ─── helpers ─────────────────────────────────────────────────────────────
function toDbTs(iso) {
  if (!iso) return null;
  // "2026-06-11T00:48:52.123Z" → "2026-06-11 00:48:52"
  return String(iso).replace('T', ' ').slice(0, 19);
}

// Reconstruct importance the same way import-cowork's eventToObservation does,
// so the kept set matches what live hooks + retention would have produced.
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SERVICE_TOOLS = new Set(['ToolSearch', 'TaskList', 'TaskGet', 'TodoWrite']);
function eventToObs(ev) {
  if (ev.kind === 'user') {
    const text = (ev.text || '').trim();
    if (!text) return null;
    const wc = text.split(/\s+/).length;
    return { tool: 'ClaudeCodeUserPrompt', summary: text.slice(0, 500), rawInput: text, rawOutput: null,
             tags: ['claude-code', 'user', 'backfill'], importance: wc <= 5 ? 0.2 : 0.55, ts: ev.ts };
  }
  if (ev.kind === 'assistant') {
    const text = (ev.text || '').trim();
    if (!text) return null;
    return { tool: 'ClaudeCodeAssistantText', summary: text.slice(0, 500), rawInput: null, rawOutput: text,
             tags: ['claude-code', 'assistant', 'backfill'], importance: 0.3, ts: ev.ts };
  }
  if (ev.kind === 'tool') {
    const t = ev.tool || 'Tool';
    let imp;
    if (EDIT_TOOLS.has(t)) imp = 0.6;
    else if (SERVICE_TOOLS.has(t)) imp = 0.15;
    else imp = 0.4;
    return { tool: t, summary: `[${t}] ${(ev.input || '').slice(0, 200)}`.slice(0, 500),
             rawInput: ev.input, rawOutput: ev.output, tags: ['claude-code', 'tool', 'backfill'], importance: imp, ts: ev.ts };
  }
  return null;
}

function firstCwd(path) {
  try {
    const raw = readFileSync(path, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { const r = JSON.parse(line); if (r.cwd) return r.cwd; } catch { /* skip */ }
    }
  } catch { /* ignore */ }
  return null;
}

// ─── scan transcripts ────────────────────────────────────────────────────
function* transcripts() {
  if (!existsSync(PROJECTS)) return;
  for (const dir of readdirSync(PROJECTS)) {
    const dpath = join(PROJECTS, dir);
    let st; try { st = statSync(dpath); } catch { continue; }
    if (!st.isDirectory()) continue;
    for (const f of readdirSync(dpath)) {
      if (!f.endsWith('.jsonl')) continue;               // skip subagents/ subdir + non-jsonl
      const fpath = join(dpath, f);
      let fst; try { fst = statSync(fpath); } catch { continue; }
      const m = fst.mtimeMs;
      if (m < sinceMs || m >= untilMs) continue;
      yield { fpath, uuid: f.replace(/\.jsonl$/, '') };
    }
  }
}

// ─── run ───────────────────────────────────────────────────────────────────
const db = getDb();
const hasObs = db.prepare('SELECT 1 FROM observations WHERE session_id = ? LIMIT 1');
const updObsTs = db.prepare('UPDATE observations SET created_at = ? WHERE id = ?');
const updSessTs = db.prepare('UPDATE sessions SET started_at = ?, ended_at = ? WHERE id = ?');

let scanned = 0, importedSessions = 0, skipped = 0, keptObs = 0, degenerate = 0;
const perProject = {};

for (const { fpath, uuid } of transcripts()) {
  scanned++;
  const sid = 'cc-' + uuid;
  if (hasObs.get(sid)) { skipped++; continue; }          // idempotent

  const cwd = firstCwd(fpath);
  const project = cwd || 'claude-code://' + uuid;
  if (isDegenerateProject(project)) { degenerate++; continue; }

  const events = parseTranscript(fpath);
  if (!events.length) continue;
  const kept = events.map(eventToObs).filter(o => o && o.importance >= MIN_IMP);
  if (!kept.length) { skipped++; continue; }             // nothing worth keeping

  const usage = parseUsage(fpath);
  const firstTs = toDbTs(events[0].ts);
  const lastTs = toDbTs(events[events.length - 1].ts);
  perProject[project] = (perProject[project] || 0) + kept.length;
  keptObs += kept.length;
  importedSessions++;

  if (DRY) continue;

  const tx = db.transaction(() => {
    upsertSession(sid, project);
    for (const o of kept) {
      const obsId = saveObservation({
        sessionId: sid, project, tool: o.tool, summary: o.summary,
        rawInput: o.rawInput, rawOutput: o.rawOutput, tags: o.tags, importance: o.importance,
      });
      if (obsId && o.ts) updObsTs.run(toDbTs(o.ts), obsId);
    }
    // session metadata (model/tokens) + historical timestamps
    closeSession(sid, null, { model: usage.model, tokenInput: usage.tokenInput, tokenOutput: usage.tokenOutput });
    if (firstTs) updSessTs.run(firstTs, lastTs || firstTs, sid);
  });
  tx();
}

// ─── report ────────────────────────────────────────────────────────────────
console.log(`\n=== backfill-claude-code ${DRY ? '(DRY RUN)' : '(APPLIED)'} ===`);
console.log(`window:            ${SINCE} .. ${UNTIL || 'now'}  (min-importance ${MIN_IMP})`);
console.log(`transcripts scanned: ${scanned}`);
console.log(`skipped (dup/empty): ${skipped}`);
console.log(`degenerate skipped:  ${degenerate}`);
console.log(`sessions imported:   ${importedSessions}`);
console.log(`observations kept:   ${keptObs}`);
console.log(`\ntop projects by kept obs:`);
Object.entries(perProject).sort((a, b) => b[1] - a[1]).slice(0, 12)
  .forEach(([p, n]) => console.log(`  ${String(n).padStart(6)}  ${p}`));
if (DRY) console.log(`\n(dry run — nothing written. re-run without --dry-run to apply.)`);
