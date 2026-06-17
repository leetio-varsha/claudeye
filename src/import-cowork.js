/**
 * import-cowork.js — import Cowork session transcripts into mem.db (#88)
 *
 * Why this exists:
 *   Cowork sessions run in the Claude desktop app, not in the Claude Code CLI,
 *   so PostToolUse / UserPromptSubmit hooks from `~/.claude/settings.json` never
 *   fire. The result: Claudeye doesn't observe its own development when I build
 *   it in Cowork, and for `~/Documents/Claude/Projects/Claudeye/claudeye` mem.db
 *   contains only 46 git-commits (as of 2026-04-23).
 *
 * How it works:
 *   Cowork writes per-session metadata to
 *     ~/Library/Application Support/Claude/local-agent-mode-sessions/
 *       <userId>/<spaceId>/local_<uuid>.json
 *   and a Claude-Code-compatible transcript at
 *     <that dir>/local_<uuid>/.claude/projects/-sessions-<name>/<cliSessionId>.jsonl
 *
 *   We scan the metadata files, read the transcripts, and emit one observation
 *   per user prompt / assistant text block / tool invocation — using the same
 *   schema the live save-hook writes to, so they appear in search, patterns,
 *   and the viewer without any special handling.
 *
 *   Dedup is keyed on `cliSessionId` in import_sources (type='cowork').
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getDb, saveObservation, saveEmbedding, upsertSession, closeSession } from './db.js';
import { embedWithMeta, isEmbeddingEnabled } from './embeddings.js';
import { addObservationToGraph } from './graph.js';

// Embed only high-importance Cowork observations to keep imports fast.
// Threshold matches the effective-coverage definition in getDbMetrics(): obs
// with importance < 0.5 are pruned by the compactor anyway, so embedding them
// would just be wasted API calls.
const COWORK_EMBED_IMPORTANCE_MIN = 0.5;

const COWORK_ROOT = join(
  homedir(),
  'Library', 'Application Support', 'Claude', 'local-agent-mode-sessions'
);

// ─── Metadata scanning ────────────────────────────────────────────────────

/**
 * Discover all Cowork session metadata files on disk.
 * Returns one entry per local_<uuid>.json with parsed metadata + transcript path.
 */
export function listCoworkSessions() {
  if (!existsSync(COWORK_ROOT)) return [];

  const out = [];
  // Layer 1: user accounts (Anthropic user IDs)
  for (const userId of safeReaddir(COWORK_ROOT)) {
    const userDir = join(COWORK_ROOT, userId);
    if (!isDir(userDir)) continue;

    // Layer 2: spaces
    for (const spaceId of safeReaddir(userDir)) {
      const spaceDir = join(userDir, spaceId);
      if (!isDir(spaceDir)) continue;

      for (const name of safeReaddir(spaceDir)) {
        if (!name.startsWith('local_') || !name.endsWith('.json')) continue;
        const metaPath = join(spaceDir, name);
        const meta = safeReadJson(metaPath);
        if (!meta || !meta.sessionId || !meta.cliSessionId) continue;

        const localDir = join(spaceDir, meta.sessionId);
        const processName = meta.processName || meta.vmProcessName || '';
        const transcript = join(
          localDir, '.claude', 'projects',
          '-sessions-' + processName,
          meta.cliSessionId + '.jsonl'
        );
        out.push({ meta, metaPath, transcriptPath: transcript, spaceId, userId });
      }
    }
  }
  return out;
}

// ─── Transcript parsing ───────────────────────────────────────────────────

/**
 * Parse a Cowork .jsonl transcript into a list of events ready to become
 * observations. One event per user prompt, per assistant text block, and per
 * tool invocation (input + output folded in).
 */
export function parseTranscript(path) {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf8');

  // Map tool_use.id → { name, input } so we can pair tool_result back later.
  const toolCalls = new Map();
  const events = [];

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }

    const ts = row.timestamp;

    if (row.type === 'user' && row.message?.role === 'user') {
      const content = row.message.content;
      if (typeof content === 'string') {
        events.push({ kind: 'user', text: content, ts, uuid: row.uuid });
      } else if (Array.isArray(content)) {
        // tool_result arrives as a user-role message with content[].type='tool_result'
        for (const c of content) {
          if (c.type === 'tool_result' && c.tool_use_id) {
            const call = toolCalls.get(c.tool_use_id);
            if (call) {
              const resultText = typeof c.content === 'string'
                ? c.content
                : Array.isArray(c.content)
                  ? c.content.map(x => x.text || '').join('\n')
                  : JSON.stringify(c.content || '');
              events.push({
                kind:  'tool',
                tool:  call.name,
                input: safeStringify(call.input),
                output: resultText,
                ts:    call.ts || ts,
                uuid:  row.uuid,
              });
              toolCalls.delete(c.tool_use_id);
            }
          }
        }
      }
    } else if (row.type === 'assistant' && row.message?.content) {
      // #93: bundle all text blocks of a single assistant response into one
      // event, so one assistant turn becomes one observation instead of 3-5
      // fragments — the old behavior inflated CoworkAssistantText to 1358/day.
      const parts = [];
      for (const c of row.message.content) {
        if (c.type === 'text' && c.text?.trim()) {
          parts.push(c.text);
        } else if (c.type === 'tool_use') {
          toolCalls.set(c.id, { name: c.name, input: c.input, ts });
        }
      }
      if (parts.length) {
        events.push({
          kind: 'assistant',
          text: parts.join('\n\n'),
          ts,
          uuid: row.uuid,
        });
      }
    }
  }

  return events;
}

/**
 * Extract aggregated token usage + model from a Cowork .jsonl transcript.
 *
 * Live sessions capture model/token_input/token_output at session close via the
 * Stop hook (summary-hook.js). Cowork sessions are imported after the fact, so
 * that hook never fires — without this, every cowork-* session lands with
 * model/token_input/token_output = NULL, which flatlined with_model/with_tokens
 * once recent activity shifted entirely to Cowork (#81 follow-up).
 *
 * The transcript is the most reliable source: assistant rows carry
 * message.model and message.usage (base + cache-creation + cache-read input
 * tokens, plus output_tokens).
 *
 * @param {string} path
 * @returns {{ tokenInput: number|null, tokenOutput: number|null, model: string|null }}
 */
export function parseUsage(path) {
  if (!existsSync(path)) return { tokenInput: null, tokenOutput: null, model: null };
  let totalInput = 0, totalOutput = 0, model = null;
  try {
    const raw = readFileSync(path, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (row.type !== 'assistant' || !row.message) continue;
      if (row.message.model) model = row.message.model;
      const u = row.message.usage;
      if (u) {
        totalInput  += (u.input_tokens || 0)
                     + (u.cache_creation_input_tokens || 0)
                     + (u.cache_read_input_tokens || 0);
        totalOutput += (u.output_tokens || 0);
      }
    }
  } catch { /* non-critical — leave nulls */ }
  return {
    tokenInput:  totalInput  > 0 ? totalInput  : null,
    tokenOutput: totalOutput > 0 ? totalOutput : null,
    model,
  };
}

/**
 * Normalize a Cowork meta.model string ("claude-opus-4-8[1m]") to the clean
 * tracking form used by live sessions ("claude-opus-4-8"). Returns null for
 * anything that isn't a recognizable Claude model id.
 * @param {*} raw
 * @returns {string|null}
 */
export function normalizeMetaModel(raw) {
  if (typeof raw !== 'string' || !raw.startsWith('claude')) return null;
  return raw.replace(/\[.*\]$/, '');
}

/**
 * Backfill sessions.model for cowork-* sessions from the persistent
 * cowork_imports.meta.
 *
 * Why this is needed (#81 follow-up): Cowork transcripts live in ephemeral
 * per-session `local_<uuid>/.claude/projects/…` working dirs that are removed
 * shortly after the session ends. The import-time `parseUsage()` recovery only
 * works while that file still exists; once it's gone, model + tokens can't be
 * re-read — which flatlined `with_model` (377) across many runs even though the
 * import code "looked" correct. meta.model, however, is captured into
 * cowork_imports at import time and persists, so we can always recover MODEL
 * from it. Token counts are unrecoverable post-hoc (the transcript is the only
 * source) — that's a separate, documented limitation.
 *
 * Deterministic + idempotent: only touches rows where model IS NULL.
 *
 * @param {object} [opts]
 * @param {object} [opts.db] — injectable for tests
 * @returns {{ scanned:number, updated:number }}
 */
export function backfillCoworkModels({ db = null } = {}) {
  db = db || getDb();
  let imports;
  try {
    imports = db.prepare(`SELECT cli_session_id, meta FROM cowork_imports`).all();
  } catch {
    return { scanned: 0, updated: 0 }; // no cowork_imports table yet
  }
  const update = db.prepare(`UPDATE sessions SET model = ? WHERE id = ? AND model IS NULL`);
  let updated = 0;
  const tx = db.transaction(() => {
    for (const r of imports) {
      let meta;
      try { meta = JSON.parse(r.meta); } catch { continue; }
      const model = normalizeMetaModel(meta && meta.model);
      if (!model) continue;
      updated += update.run(model, 'cowork-' + r.cli_session_id).changes;
    }
  });
  tx();
  return { scanned: imports.length, updated };
}

/**
 * Backfill sessions.token_input/token_output for cowork-* sessions from the
 * persistent cowork_imports.meta (#117).
 *
 * Companion to backfillCoworkModels. Token counts live ONLY in the transcript,
 * and Cowork transcripts are ephemeral, so tokens are unrecoverable once the
 * file is gone (model, by contrast, is recoverable from the persistent
 * meta.model). From #117 onward importCoworkSession persists
 * token_input/token_output into cowork_imports.meta at import time — while the
 * transcript still exists — so this backfill can restore them onto any session
 * whose token_input was left NULL (a re-import that ran after cleanup, or a row
 * that predates closeSession writing the columns).
 *
 * Deterministic + idempotent: only touches rows where token_input IS NULL, and
 * only when meta carries a finite token_input.
 *
 * @param {object} [opts]
 * @param {object} [opts.db] — injectable for tests
 * @returns {{ scanned:number, updated:number }}
 */
export function backfillCoworkTokens({ db = null } = {}) {
  db = db || getDb();
  let imports;
  try {
    imports = db.prepare(`SELECT cli_session_id, meta FROM cowork_imports`).all();
  } catch {
    return { scanned: 0, updated: 0 }; // no cowork_imports table yet
  }
  const update = db.prepare(
    `UPDATE sessions SET token_input = ?, token_output = ? WHERE id = ? AND token_input IS NULL`
  );
  let updated = 0;
  const tx = db.transaction(() => {
    for (const r of imports) {
      let meta;
      try { meta = JSON.parse(r.meta); } catch { continue; }
      const ti = meta && Number.isFinite(meta.token_input)  ? meta.token_input  : null;
      if (ti == null) continue; // nothing usable persisted
      const to = meta && Number.isFinite(meta.token_output) ? meta.token_output : null;
      updated += update.run(ti, to, 'cowork-' + r.cli_session_id).changes;
    }
  });
  tx();
  return { scanned: imports.length, updated };
}

// ─── System session filter ────────────────────────────────────────────────

/**
 * Cowork session titles that belong to Claudeye's own scheduled tasks.
 * Importing these creates a self-observation loop: the dev-agent / analyzer
 * use osascript to call `gh`, those tool calls land in the Cowork transcript,
 * and the daily `import cowork` pass re-ingests them as user observations,
 * inflating osascript counts and polluting behavioral analytics.
 *
 * Matching is case-insensitive substring. Add more patterns here if new
 * scheduled tasks are introduced.
 */
export const SYSTEM_SESSION_TITLE_PATTERNS = [
  'claudeye dev agent',
  'claudeye analyzer',
  'claudeye insights',
];

/**
 * Returns true if this session was created by a Claudeye scheduled task
 * and should be skipped during import.
 */
export function isSystemSession(meta) {
  const title = (meta.title || '').toLowerCase();
  return SYSTEM_SESSION_TITLE_PATTERNS.some(p => title.includes(p));
}

// ─── Noise filter (#93) ───────────────────────────────────────────────────

// Tool inputs that carry no information (same JSON every call) — bundling or
// skipping these prevents `screenshot × 7`, `list_scheduled_tasks × 7` etc.
// from each becoming its own observation + embedding.
const EMPTY_INPUT_TOOLS = new Set([
  'mcp__computer-use__screenshot',
  'mcp__scheduled-tasks__list_scheduled_tasks',
  'mcp__session_info__list_sessions',
  'mcp__computer-use__list_granted_applications',
]);

// Low-info service tools — keep but down-weight (importance 0.15) so they
// still exist for debugging but don't drown the advisor signal.
const SERVICE_TOOLS = new Set(['ToolSearch', 'TaskList', 'TaskGet']);

const SHORT_PROMPTS = new Set([
  'да', 'нет', 'ок', 'ok', 'yes', 'no',
  'продолжай', 'go', 'next', 'далее', 'дальше',
  'no response requested.', 'no response requested',
]);

/**
 * @returns true if this event should NOT be saved as an observation.
 */
export function isNoiseEvent(ev) {
  if (ev.kind === 'user') {
    const t = (ev.text || '').trim().toLowerCase();
    if (!t) return true;
    if (SHORT_PROMPTS.has(t)) return true;
    return false;
  }
  if (ev.kind === 'tool') {
    const input = (ev.input || '').trim();
    // Empty-input service calls — `{}` / `""` / JSON with no keys.
    if (EMPTY_INPUT_TOOLS.has(ev.tool) && (!input || input === '{}' || input === '""')) {
      return true;
    }
    // TodoWrite with an empty todo list — `{"todos":[]}`
    if (ev.tool === 'TodoWrite') {
      try {
        const parsed = JSON.parse(input);
        if (Array.isArray(parsed.todos) && parsed.todos.length === 0) return true;
      } catch { /* not JSON — keep */ }
    }
    return false;
  }
  if (ev.kind === 'assistant') {
    const t = (ev.text || '').trim();
    if (!t) return true;
    if (t.length < 20) return true;  // "ok", "done", "готово"
    return false;
  }
  return false;
}

/**
 * Deduplicate repeated (tool, input) pairs within a single session. The first
 * occurrence is kept; subsequent identical calls are dropped. Returns filtered
 * events + a count of dropped duplicates for stats.
 */
export function dedupEvents(events) {
  const seen = new Set();
  const kept = [];
  let dropped = 0;
  for (const ev of events) {
    if (ev.kind !== 'tool') { kept.push(ev); continue; }
    const key = ev.tool + '|' + (ev.input || '').slice(0, 500);
    if (seen.has(key)) { dropped++; continue; }
    seen.add(key);
    kept.push(ev);
  }
  return { events: kept, dropped };
}

// ─── Import orchestration ─────────────────────────────────────────────────

/**
 * Import a single Cowork session (one local_<uuid>).
 *
 * @param {object} session   — entry from listCoworkSessions()
 * @param {object} [opts]
 * @param {boolean} [opts.force]   — re-import even if dedup says done
 * @param {boolean} [opts.skipEmbeddings]  — disable post-import embedding pass
 *                                           (used by tests + sandboxed runs)
 * @returns {{ imported: number, embedded: number, skipped: number, reason?: string }}
 */
export async function importCoworkSession(session, { force = false, skipEmbeddings = false } = {}) {
  const db = getDb();
  ensureImportSourcesTable(db);

  const { meta, transcriptPath } = session;
  const cliSessionId = meta.cliSessionId;

  // Skip Claudeye's own scheduled-task sessions — importing them creates a
  // self-observation loop where the dev-agent / analyzer osascript calls
  // appear as user tool observations and inflate behavioral metrics.
  if (isSystemSession(meta)) {
    return { imported: 0, skipped: 1, reason: 'system session (scheduled task)' };
  }

  if (!force) {
    const already = db.prepare(
      `SELECT 1 FROM cowork_imports WHERE cli_session_id=?`
    ).get(cliSessionId);
    if (already) return { imported: 0, skipped: 1, reason: 'already imported' };
  }

  if (!existsSync(transcriptPath)) {
    return { imported: 0, skipped: 1, reason: 'transcript missing: ' + transcriptPath };
  }

  const rawEvents = parseTranscript(transcriptPath);
  if (!rawEvents.length) return { imported: 0, skipped: 1, reason: 'empty transcript' };

  // #93: pre-filter noise and dedup repeated tool calls inside the session.
  const afterNoise = rawEvents.filter(e => !isNoiseEvent(e));
  const { events, dropped: dedupDropped } = dedupEvents(afterNoise);
  const noiseDropped = rawEvents.length - afterNoise.length;

  const project = resolveProject(meta);
  const storedSessionId = 'cowork-' + cliSessionId;

  // #93: on force re-import, wipe previously-imported rows for this session
  // so the new filters (noise drop + assistant bundling) actually take effect
  // instead of stacking on top of the old output.
  if (force) {
    db.prepare(`DELETE FROM observations WHERE session_id = ?`).run(storedSessionId);
  }

  upsertSession(storedSessionId, project);

  let imported = 0;
  // Collect (obsId, summary) for high-importance observations so we can embed
  // them after the synchronous transaction commits — embedWithMeta is async
  // and shouldn't run inside the better-sqlite3 transaction.
  const toEmbed = [];
  const toGraph = [];
  const tx = db.transaction(() => {
    for (const ev of events) {
      const obs = eventToObservation(ev, meta);
      if (!obs) continue;
      const obsId = saveObservation({
        sessionId: storedSessionId,
        project,
        ...obs,
      });
      if (obs.importance >= COWORK_EMBED_IMPORTANCE_MIN && obs.summary) {
        toEmbed.push({ obsId, summary: obs.summary });
      }
      if (obs.importance >= 0.2 && obs.summary) {
        toGraph.push({ id: obsId, project, tool: obs.tool, summary: obs.summary, tags: JSON.stringify(obs.tags || []), importance: obs.importance, decision_rationale: obs.decisionRationale ?? null, raw_input: null });
      }
      imported++;
    }
    // #81 follow-up: recover model + token usage from the transcript, since the
    // live Stop hook never fires for imported Cowork sessions. Prefer the model
    // recorded inside the transcript (clean name, e.g. claude-opus-4-6) and fall
    // back to meta.model with its context-window suffix stripped (e.g. [1m]).
    const usage = parseUsage(transcriptPath);
    const metaModel = normalizeMetaModel(meta.model);

    // #117: persist token usage into cowork_imports.meta while the transcript is
    // still alive. Cowork transcripts are ephemeral — removed shortly after the
    // session ends — and the transcript is the ONLY source of token counts
    // (meta.model carries the model but never the usage figures). The first
    // import that runs while the file exists is our one chance to capture them.
    // On a later re-import the transcript may already be gone → parseUsage()
    // returns null; in that case preserve the tokens a prior import persisted
    // instead of clobbering meta with nulls.
    let prevTokenInput = null, prevTokenOutput = null;
    try {
      const prev = db.prepare(`SELECT meta FROM cowork_imports WHERE cli_session_id = ?`).get(cliSessionId);
      if (prev && prev.meta) {
        const pm = JSON.parse(prev.meta);
        if (Number.isFinite(pm.token_input))  prevTokenInput  = pm.token_input;
        if (Number.isFinite(pm.token_output)) prevTokenOutput = pm.token_output;
      }
    } catch { /* no prior import / malformed meta — ignore */ }
    const tokenInput  = usage.tokenInput  ?? prevTokenInput;
    const tokenOutput = usage.tokenOutput ?? prevTokenOutput;

    closeSession(storedSessionId, null, {
      model:       usage.model || metaModel,
      tokenInput,
      tokenOutput,
    });
    db.prepare(`
      INSERT OR REPLACE INTO cowork_imports (cli_session_id, project, imported_at, events, meta)
      VALUES (?, ?, datetime('now'), ?, ?)
    `).run(cliSessionId, project, imported, JSON.stringify({
      coworkSessionId: meta.sessionId,
      title:           meta.title,
      model:           meta.model,
      token_input:     tokenInput,
      token_output:    tokenOutput,
      createdAt:       meta.createdAt,
      lastActivityAt:  meta.lastActivityAt,
      raw_events:      rawEvents.length,
      noise_dropped:   noiseDropped,
      dedup_dropped:   dedupDropped,
    }));
  });
  tx();

  // Best-effort embedding pass — never fail the import if embeddings break.
  // Skipped when caller requests it (tests) or when no real provider is
  // configured (don't waste cycles on the keyword fallback).
  let embedded = 0;
  if (!skipEmbeddings && toEmbed.length && isEmbeddingEnabled()) {
    for (const { obsId, summary } of toEmbed) {
      try {
        const embMeta = await embedWithMeta(summary);
        if (embMeta?.vector) {
          saveEmbedding(obsId, embMeta.vector, embMeta.model);
          embedded++;
        }
      } catch { /* swallow — best-effort */ }
    }
  }

  // Best-effort Knowledge Graph pass (#26)
  for (const obs of toGraph) {
    try { addObservationToGraph(obs); } catch { /* non-critical */ }
  }

  return { imported, embedded, skipped: 0, noiseDropped, dedupDropped, rawEvents: rawEvents.length };
}

/**
 * Import every Cowork session found on disk. Deduped via import_sources,
 * so safe to run repeatedly / on a schedule.
 */
export async function importAllCoworkSessions({ force = false, skipEmbeddings = false } = {}) {
  const sessions = listCoworkSessions();
  const summary = {
    total: sessions.length,
    imported: 0,
    skipped: 0,
    observations: 0,
    embeddings: 0,
    noiseDropped: 0,
    dedupDropped: 0,
    rawEvents: 0,
    errors: 0,
    details: [],
  };
  for (const s of sessions) {
    try {
      const r = await importCoworkSession(s, { force, skipEmbeddings });
      summary.observations  += r.imported;
      summary.embeddings    += r.embedded || 0;
      summary.noiseDropped  += r.noiseDropped || 0;
      summary.dedupDropped  += r.dedupDropped || 0;
      summary.rawEvents     += r.rawEvents    || 0;
      if (r.imported > 0) summary.imported++; else summary.skipped++;
      summary.details.push({
        coworkSessionId: s.meta.sessionId,
        title: s.meta.title || '(untitled)',
        project: resolveProject(s.meta),
        ...r,
      });
    } catch (err) {
      summary.errors++;
      summary.details.push({
        coworkSessionId: s.meta.sessionId,
        error: err.message,
      });
    }
  }
  // Self-heal model tracking from persistent meta (#81 follow-up). Cheap,
  // idempotent — recovers model for any cowork session whose transcript was
  // already cleaned up before parseUsage could read it.
  try {
    summary.modelsBackfilled = backfillCoworkModels().updated;
  } catch { summary.modelsBackfilled = 0; }
  // #117: recover token counts persisted into meta on a prior import (the
  // transcript is likely gone by now, so this is the only way to fill them in).
  try {
    summary.tokensBackfilled = backfillCoworkTokens().updated;
  } catch { summary.tokensBackfilled = 0; }
  return summary;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

// Separate table from the existing `import_sources` (used by git import with a
// different schema: {source, path, last_hash}). Keeping Cowork tracking in its
// own table avoids a cross-feature migration.
function ensureImportSourcesTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cowork_imports (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      cli_session_id TEXT    NOT NULL UNIQUE,
      project        TEXT,
      imported_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      events         INTEGER NOT NULL DEFAULT 0,
      meta           TEXT
    )
  `);
}

/**
 * Resolve the best project path we can for a Cowork session.
 *
 * Cowork records `userSelectedFolders` — these are REAL host paths mounted
 * into the sandbox, so they're the right thing to key on for cross-referencing
 * with hook-captured data from regular Claude Code sessions in the same repo.
 *
 * When the user didn't mount a folder, fall back to a synthetic path so the
 * session still has somewhere to land (better than '' / null which confuses
 * search filters).
 */
function resolveProject(meta) {
  const folders = Array.isArray(meta.userSelectedFolders) ? meta.userSelectedFolders : [];
  if (folders.length === 1 && folders[0]) return folders[0];
  if (folders.length > 1) {
    // Multi-mount session — pick first mount as primary, record others in meta.
    return folders[0];
  }
  const name = meta.processName || meta.vmProcessName || meta.sessionId || 'unknown';
  return 'cowork://' + name;
}

function eventToObservation(ev, meta) {
  if (ev.kind === 'user') {
    const text = (ev.text || '').trim();
    if (!text) return null;
    // #93: short prompts (but not pure noise — SHORT_PROMPTS was filtered)
    // get low importance so they don't crowd the advisor. ≤5 words = terse.
    const wordCount = text.split(/\s+/).length;
    const importance = wordCount <= 5 ? 0.2 : 0.55;
    return {
      tool: 'CoworkUserPrompt',
      summary: text.slice(0, 500),
      rawInput: text,
      rawOutput: null,
      tags: ['cowork', 'user'],
      importance,
    };
  }
  if (ev.kind === 'assistant') {
    const text = (ev.text || '').trim();
    if (!text) return null;
    // #93: one observation per assistant turn (text blocks already bundled in
    // parseTranscript). Importance 0.3 — secondary source vs. tool calls.
    return {
      tool: 'CoworkAssistantText',
      summary: text.slice(0, 500),
      rawInput: null,
      rawOutput: text,
      tags: ['cowork', 'assistant'],
      importance: 0.3,
    };
  }
  if (ev.kind === 'tool') {
    const toolName = ev.tool || 'Tool';
    const summary = `[${toolName}] ${(ev.input || '').slice(0, 200)}`;
    // #93: service tools (ToolSearch, TaskList, TaskGet) are operational
    // chatter, not work-signal — keep but down-weight.
    let importance;
    if (toolName === 'Edit' || toolName === 'Write') importance = 0.6;
    else if (SERVICE_TOOLS.has(toolName))             importance = 0.15;
    else                                              importance = 0.4;
    return {
      tool: toolName,
      summary: summary.slice(0, 500),
      rawInput: ev.input,
      rawOutput: ev.output,
      tags: ['cowork', 'tool'],
      importance,
    };
  }
  return null;
}

function safeStringify(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

function safeReaddir(dir) {
  try { return readdirSync(dir); } catch { return []; }
}

function isDir(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

function safeReadJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}
