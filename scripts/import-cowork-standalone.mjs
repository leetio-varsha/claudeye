#!/usr/bin/env node
/**
 * import-cowork-standalone.mjs — Standalone Cowork session importer (#88 TCC fix)
 *
 * Why this exists:
 *   `claudeye import cowork` runs via the npm-linked binary which resolves
 *   `cli.js` from ~/Documents/... — a path TCC blocks for launchd processes.
 *   This standalone script inlines all required logic and uses createRequire
 *   to load better-sqlite3 from ~/.claudeye/node_modules (TCC-accessible).
 *
 * Usage:
 *   node ~/.claudeye/import-cowork-standalone.mjs
 *   node ~/.claudeye/import-cowork-standalone.mjs --dry-run   # count sessions, no write
 *   node ~/.claudeye/import-cowork-standalone.mjs --force     # re-import all sessions
 *
 * Deployed by: copying this file to ~/.claudeye/ (same as behavioral-standalone.mjs).
 * insights-runner.sh calls it instead of `claudeye import cowork`.
 *
 * Embeddings: skipped in this standalone — the daily embedding pass in
 * insights-standalone.mjs will backfill them on the next run.
 */

import { createRequire } from 'module';
import { readFileSync, readdirSync, existsSync, statSync, appendFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// ─── Paths ───────────────────────────────────────────────────────────────────
const DATA_DIR    = join(homedir(), '.claudeye');
const DB_PATH     = join(DATA_DIR, 'mem.db');
const LOG_PATH    = join(DATA_DIR, 'logs', 'insights-heartbeat.log');
const COWORK_ROOT = join(homedir(), 'Library', 'Application Support', 'Claude', 'local-agent-mode-sessions');

// Load better-sqlite3 from ~/.claudeye/node_modules (TCC-safe, never ~/Documents)
const _require  = createRequire(join(DATA_DIR, 'package.json'));
const Database  = _require('better-sqlite3');

// ─── Logging ─────────────────────────────────────────────────────────────────
function logLine(msg) {
  try { appendFileSync(LOG_PATH, `${new Date().toISOString()} ${msg}\n`); } catch {}
}

// ─── DB init ─────────────────────────────────────────────────────────────────
function openDb() {
  const db = new Database(DB_PATH);
  // Ensure cowork_imports table (idempotent)
  db.exec(`
    CREATE TABLE IF NOT EXISTS cowork_imports (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      cli_session_id TEXT    NOT NULL UNIQUE,
      project        TEXT,
      imported_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      events         INTEGER NOT NULL DEFAULT 0,
      meta           TEXT
    );
    CREATE TABLE IF NOT EXISTS observations (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  TEXT    NOT NULL,
      project     TEXT,
      tool        TEXT    NOT NULL,
      summary     TEXT    NOT NULL,
      importance  REAL    NOT NULL DEFAULT 0.5,
      tags        TEXT    DEFAULT '[]',
      raw_input   TEXT,
      raw_output  TEXT,
      retry_count INTEGER DEFAULT 0,
      decision_rationale TEXT,
      duration_ms INTEGER,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id             TEXT    PRIMARY KEY,
      project        TEXT    NOT NULL,
      started_at     TEXT    NOT NULL DEFAULT (datetime('now')),
      ended_at       TEXT,
      summary        TEXT,
      prompt_count   INTEGER NOT NULL DEFAULT 0,
      friction_score REAL    DEFAULT 0,
      model          TEXT,
      duration_ms    INTEGER,
      token_input    INTEGER,
      token_output   INTEGER
    );
  `);
  return db;
}

// ─── Simplified DB writes ─────────────────────────────────────────────────────
function saveObservation(db, { sessionId, project, tool, summary, rawInput, rawOutput, tags = [], importance = 0.5 }) {
  const stmt = db.prepare(`
    INSERT INTO observations (session_id, project, tool, summary, raw_input, raw_output, tags, importance)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    sessionId, project, tool,
    summary,
    rawInput  ? String(rawInput).slice(0, 2000)  : null,
    rawOutput ? String(rawOutput).slice(0, 2000) : null,
    JSON.stringify(tags),
    importance
  );
  return result.lastInsertRowid;
}

function upsertSession(db, id, project) {
  db.prepare(`
    INSERT INTO sessions (id, project) VALUES (?, ?)
    ON CONFLICT(id) DO UPDATE SET prompt_count = prompt_count + 1
  `).run(id, project);
}

function closeSession(db, id) {
  db.prepare(`
    UPDATE sessions SET ended_at = datetime('now') WHERE id = ? AND ended_at IS NULL
  `).run(id);
}

// ─── Cowork session discovery ─────────────────────────────────────────────────
function safeReaddir(dir) {
  try { return readdirSync(dir); } catch { return []; }
}
function isDir(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}
function safeReadJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function listCoworkSessions() {
  if (!existsSync(COWORK_ROOT)) return [];
  const out = [];
  for (const userId of safeReaddir(COWORK_ROOT)) {
    const userDir = join(COWORK_ROOT, userId);
    if (!isDir(userDir)) continue;
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

function resolveProject(meta) {
  const folders = Array.isArray(meta.userSelectedFolders) ? meta.userSelectedFolders : [];
  if (folders.length === 1 && folders[0]) return folders[0];
  if (folders.length > 1) return folders[0];
  const name = meta.processName || meta.vmProcessName || meta.sessionId || 'unknown';
  return 'cowork://' + name;
}

// ─── Transcript parsing ────────────────────────────────────────────────────────
function parseTranscript(path) {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf8');
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
                kind: 'tool', tool: call.name,
                input: safeStringify(call.input), output: resultText,
                ts: call.ts || ts, uuid: row.uuid,
              });
              toolCalls.delete(c.tool_use_id);
            }
          }
        }
      }
    } else if (row.type === 'assistant' && row.message?.content) {
      const parts = [];
      for (const c of row.message.content) {
        if (c.type === 'text' && c.text?.trim()) {
          parts.push(c.text);
        } else if (c.type === 'tool_use') {
          toolCalls.set(c.id, { name: c.name, input: c.input, ts });
        }
      }
      if (parts.length) {
        events.push({ kind: 'assistant', text: parts.join('\n\n'), ts, uuid: row.uuid });
      }
    }
  }
  return events;
}

function safeStringify(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

// ─── Noise filter (#93) ───────────────────────────────────────────────────────
const EMPTY_INPUT_TOOLS = new Set([
  'mcp__computer-use__screenshot',
  'mcp__scheduled-tasks__list_scheduled_tasks',
  'mcp__session_info__list_sessions',
  'mcp__computer-use__list_granted_applications',
]);
const SERVICE_TOOLS = new Set(['ToolSearch', 'TaskList', 'TaskGet']);
const SHORT_PROMPTS = new Set([
  'да', 'нет', 'ок', 'ok', 'yes', 'no',
  'продолжай', 'go', 'next', 'далее', 'дальше',
  'no response requested.', 'no response requested',
]);

function isNoiseEvent(ev) {
  if (ev.kind === 'user') {
    const t = (ev.text || '').trim().toLowerCase();
    return !t || SHORT_PROMPTS.has(t);
  }
  if (ev.kind === 'tool') {
    const input = (ev.input || '').trim();
    if (EMPTY_INPUT_TOOLS.has(ev.tool) && (!input || input === '{}' || input === '""')) return true;
    if (ev.tool === 'TodoWrite') {
      try { const p = JSON.parse(input); if (Array.isArray(p.todos) && p.todos.length === 0) return true; } catch {}
    }
    return false;
  }
  if (ev.kind === 'assistant') {
    const t = (ev.text || '').trim();
    return !t || t.length < 20;
  }
  return false;
}

function dedupEvents(events) {
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

function eventToObservation(ev) {
  if (ev.kind === 'user') {
    const text = (ev.text || '').trim();
    if (!text) return null;
    const wordCount = text.split(/\s+/).length;
    return {
      tool: 'CoworkUserPrompt',
      summary: text.slice(0, 500),
      rawInput: text, rawOutput: null,
      tags: ['cowork', 'user'],
      importance: wordCount <= 5 ? 0.2 : 0.55,
    };
  }
  if (ev.kind === 'assistant') {
    const text = (ev.text || '').trim();
    if (!text) return null;
    return {
      tool: 'CoworkAssistantText',
      summary: text.slice(0, 500),
      rawInput: null, rawOutput: text,
      tags: ['cowork', 'assistant'],
      importance: 0.3,
    };
  }
  if (ev.kind === 'tool') {
    const toolName = ev.tool || 'Tool';
    const summary = `[${toolName}] ${(ev.input || '').slice(0, 200)}`;
    let importance;
    if (toolName === 'Edit' || toolName === 'Write') importance = 0.6;
    else if (SERVICE_TOOLS.has(toolName))             importance = 0.15;
    else                                              importance = 0.4;
    return {
      tool: toolName,
      summary: summary.slice(0, 500),
      rawInput: ev.input, rawOutput: ev.output,
      tags: ['cowork', 'tool'],
      importance,
    };
  }
  return null;
}

// ─── Import orchestration ─────────────────────────────────────────────────────
function importSession(db, session, { force = false } = {}) {
  const { meta, transcriptPath } = session;
  const cliSessionId = meta.cliSessionId;

  if (!force) {
    const already = db.prepare('SELECT 1 FROM cowork_imports WHERE cli_session_id=?').get(cliSessionId);
    if (already) return { imported: 0, skipped: 1, reason: 'already imported' };
  }

  if (!existsSync(transcriptPath)) {
    return { imported: 0, skipped: 1, reason: 'transcript missing' };
  }

  const rawEvents = parseTranscript(transcriptPath);
  if (!rawEvents.length) return { imported: 0, skipped: 1, reason: 'empty transcript' };

  const afterNoise = rawEvents.filter(e => !isNoiseEvent(e));
  const { events, dropped: dedupDropped } = dedupEvents(afterNoise);
  const noiseDropped = rawEvents.length - afterNoise.length;

  const project = resolveProject(meta);
  const storedSessionId = 'cowork-' + cliSessionId;

  if (force) {
    db.prepare('DELETE FROM observations WHERE session_id = ?').run(storedSessionId);
  }

  upsertSession(db, storedSessionId, project);

  let imported = 0;
  const tx = db.transaction(() => {
    for (const ev of events) {
      const obs = eventToObservation(ev);
      if (!obs) continue;
      saveObservation(db, { sessionId: storedSessionId, project, ...obs });
      imported++;
    }
    closeSession(db, storedSessionId);
    db.prepare(`
      INSERT OR REPLACE INTO cowork_imports (cli_session_id, project, imported_at, events, meta)
      VALUES (?, ?, datetime('now'), ?, ?)
    `).run(cliSessionId, project, imported, JSON.stringify({
      coworkSessionId: meta.sessionId,
      title:           meta.title,
      model:           meta.model,
      createdAt:       meta.createdAt,
      lastActivityAt:  meta.lastActivityAt,
      raw_events:      rawEvents.length,
      noise_dropped:   noiseDropped,
      dedup_dropped:   dedupDropped,
    }));
  });
  tx();

  return { imported, skipped: 0, noiseDropped, dedupDropped, rawEvents: rawEvents.length };
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const force  = args.includes('--force');

  logLine(`[import-cowork] start (dryRun=${dryRun}, force=${force})`);

  const sessions = listCoworkSessions();
  logLine(`[import-cowork] found ${sessions.length} session(s) on disk`);

  if (dryRun) {
    console.log(JSON.stringify({ total: sessions.length, dryRun: true }));
    logLine(`[import-cowork] dry-run exit`);
    return;
  }

  const db = openDb();
  const summary = { total: sessions.length, imported: 0, skipped: 0, observations: 0, errors: 0 };

  for (const s of sessions) {
    try {
      const r = importSession(db, s, { force });
      summary.observations += r.imported;
      if (r.imported > 0) summary.imported++; else summary.skipped++;
    } catch (err) {
      summary.errors++;
      logLine(`[import-cowork] error for ${s.meta?.cliSessionId}: ${err.message}`);
    }
  }

  db.close();
  logLine(`[import-cowork] finish: imported=${summary.imported} sessions (+${summary.observations} obs), skipped=${summary.skipped}, errors=${summary.errors}`);
  console.log(JSON.stringify(summary));
}

main().catch(e => {
  logLine(`[import-cowork] FATAL: ${e.message}`);
  console.error(e);
  process.exit(1);
});
