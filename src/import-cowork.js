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
import { getDb, saveObservation, upsertSession, closeSession } from './db.js';

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
      for (const c of row.message.content) {
        if (c.type === 'text' && c.text?.trim()) {
          events.push({ kind: 'assistant', text: c.text, ts, uuid: row.uuid });
        } else if (c.type === 'tool_use') {
          toolCalls.set(c.id, { name: c.name, input: c.input, ts });
        }
      }
    }
  }

  return events;
}

// ─── Import orchestration ─────────────────────────────────────────────────

/**
 * Import a single Cowork session (one local_<uuid>).
 *
 * @param {object} session   — entry from listCoworkSessions()
 * @param {object} [opts]
 * @param {boolean} [opts.force]   — re-import even if dedup says done
 * @returns {{ imported: number, skipped: number, reason?: string }}
 */
export function importCoworkSession(session, { force = false } = {}) {
  const db = getDb();
  ensureImportSourcesTable(db);

  const { meta, transcriptPath } = session;
  const cliSessionId = meta.cliSessionId;

  if (!force) {
    const already = db.prepare(
      `SELECT 1 FROM cowork_imports WHERE cli_session_id=?`
    ).get(cliSessionId);
    if (already) return { imported: 0, skipped: 1, reason: 'already imported' };
  }

  if (!existsSync(transcriptPath)) {
    return { imported: 0, skipped: 1, reason: 'transcript missing: ' + transcriptPath };
  }

  const events = parseTranscript(transcriptPath);
  if (!events.length) return { imported: 0, skipped: 1, reason: 'empty transcript' };

  const project = resolveProject(meta);
  const storedSessionId = 'cowork-' + cliSessionId;
  upsertSession(storedSessionId, project);

  let imported = 0;
  const tx = db.transaction(() => {
    for (const ev of events) {
      const obs = eventToObservation(ev, meta);
      if (!obs) continue;
      saveObservation({
        sessionId: storedSessionId,
        project,
        ...obs,
      });
      imported++;
    }
    closeSession(storedSessionId);
    db.prepare(`
      INSERT OR REPLACE INTO cowork_imports (cli_session_id, project, imported_at, events, meta)
      VALUES (?, ?, datetime('now'), ?, ?)
    `).run(cliSessionId, project, imported, JSON.stringify({
      coworkSessionId: meta.sessionId,
      title:           meta.title,
      model:           meta.model,
      createdAt:       meta.createdAt,
      lastActivityAt:  meta.lastActivityAt,
    }));
  });
  tx();

  return { imported, skipped: 0 };
}

/**
 * Import every Cowork session found on disk. Deduped via import_sources,
 * so safe to run repeatedly / on a schedule.
 */
export function importAllCoworkSessions({ force = false } = {}) {
  const sessions = listCoworkSessions();
  const summary = { total: sessions.length, imported: 0, skipped: 0, observations: 0, errors: 0, details: [] };
  for (const s of sessions) {
    try {
      const r = importCoworkSession(s, { force });
      summary.observations += r.imported;
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
    return {
      tool: 'CoworkUserPrompt',
      summary: text.slice(0, 500),
      rawInput: text,
      rawOutput: null,
      tags: ['cowork', 'user'],
      importance: 0.55,
    };
  }
  if (ev.kind === 'assistant') {
    const text = (ev.text || '').trim();
    if (!text) return null;
    return {
      tool: 'CoworkAssistantText',
      summary: text.slice(0, 500),
      rawInput: null,
      rawOutput: text,
      tags: ['cowork', 'assistant'],
      importance: 0.4,
    };
  }
  if (ev.kind === 'tool') {
    const toolName = ev.tool || 'Tool';
    const summary = `[${toolName}] ${(ev.input || '').slice(0, 200)}`;
    return {
      tool: toolName,
      summary: summary.slice(0, 500),
      rawInput: ev.input,
      rawOutput: ev.output,
      tags: ['cowork', 'tool'],
      importance: toolName === 'Edit' || toolName === 'Write' ? 0.6 : 0.4,
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
