/**
 * src/import-slack.js — Slack read-first import for Claudeye (#23)
 *
 * Imports Slack channel messages and threads as observations in mem.db —
 * «поиск решений в обсуждениях». Uses the Slack Web API with a bot/user
 * token (xoxb-/xoxp-) that has channels:read + channels:history scopes.
 *
 * Read-first: only conversations.list / history / replies, no writes
 * (per #23 "read-first, write-later").
 *
 * Idempotent: tracks imported items in import_sources
 *   (source='slack', path=<channel_id>:<ts>). Threads are imported as a
 *   single observation (parent + replies) keyed by the parent ts.
 * Incremental: re-running only imports new/untracked messages.
 *
 * Usage (via CLI):
 *   claudeye import slack --token xoxb-... [--channel general,dev] [--days 30]
 *   SLACK_TOKEN=... claudeye import slack
 *
 * Optional:
 *   --channel <names|ids>  comma-separated channel names or C-ids (default: all member channels)
 *   --days <n>             only messages from the last n days (default 30)
 *   --limit <n>            cap number of observations
 */

import { getDb, saveObservation, upsertSession, closeSession, saveEmbedding } from './db.js';
import { computeFrictionScore } from './analytics.js';
import { compressObservation as compress } from './compress.js';
import { embedWithMeta } from './embeddings.js';
import { addObservationToGraph } from './graph.js';

// ─── HTTP helpers ─────────────────────────────────────────────────────────

const API_BASE = 'https://slack.com/api';

async function slackFetch(token, method, query = {}) {
  const url = new URL(`${API_BASE}/${method}`);
  for (const [k, v] of Object.entries(query)) {
    if (v != null) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });
  // Slack rate limit: одна повторная попытка по Retry-After.
  if (res.status === 429) {
    const wait = Math.min(30, Number(res.headers.get('retry-after') || 5));
    await new Promise((r) => setTimeout(r, wait * 1000));
    return slackFetch(token, method, query);
  }
  if (!res.ok) {
    throw new Error(`Slack API ${method} → HTTP ${res.status}`);
  }
  const json = await res.json();
  if (!json.ok) {
    throw new Error(`Slack API ${method} → ${json.error || 'unknown error'}`);
  }
  return json;
}

// ─── Pure helpers (exported for tests) ────────────────────────────────────

/**
 * Noise filter: системные сообщения (subtype), пустые и слишком короткие
 * реплики без треда не несут «решений» и раздувают БД.
 */
export function isNoiseMessage(msg, { minChars = 40 } = {}) {
  if (!msg || typeof msg.text !== 'string') return true;
  if (msg.subtype) return true;                       // joins, topic changes, bots-меты
  if (msg.bot_id && !msg.text.trim()) return true;
  const text = msg.text.trim();
  if (!text) return true;
  const isThreadParent = Boolean(msg.thread_ts && msg.thread_ts === msg.ts && (msg.reply_count || 0) > 0);
  if (text.length < minChars && !isThreadParent) return true;
  return false;
}

/**
 * Importance: треды с обсуждением > одиночные сообщения; код/ссылки —
 * признак технического решения. Clamped to [0.1, 0.95] (как github/jira).
 */
export function estimateSlackImportance(msg) {
  let base = 0.4;
  const replies = msg?.reply_count || 0;
  if (replies > 0) base = 0.5 + Math.min(0.2, replies * 0.02);
  const text = msg?.text || '';
  if (text.includes('```')) base += 0.1;              // код-блок
  if (/https?:\/\//.test(text)) base += 0.05;          // ссылки
  if ((msg?.reactions || []).some((r) => (r.count || 0) >= 3)) base += 0.05;
  return Math.max(0.1, Math.min(0.95, base));
}

/** Tag array: source, kind, channel. */
export function slackTags(msg, channelName) {
  const kind = (msg?.reply_count || 0) > 0 ? 'thread' : 'message';
  const tags = ['slack', 'import', kind];
  if (channelName) tags.push(`channel:${String(channelName).toLowerCase().replace(/\s+/g, '-')}`);
  return tags;
}

/** Stable idempotency key for a message/thread within a channel. */
export function slackMessageKey(channelId, msg) {
  return `${channelId}:${msg.ts}`;
}

/**
 * Render a thread (parent + replies) as plain text content.
 * Replies are truncated per-message; total capped at maxChars.
 */
export function threadToContent(parent, replies = [], { maxChars = 3000 } = {}) {
  const lines = [`${parent.user || parent.username || 'user'}: ${(parent.text || '').trim()}`];
  for (const r of replies) {
    if (!r?.text || r.ts === parent.ts) continue;
    lines.push(`↳ ${r.user || r.username || 'user'}: ${r.text.trim().slice(0, 500)}`);
  }
  return lines.join('\n').slice(0, maxChars);
}

// ─── Import tracking (same pattern as import-github.js) ───────────────────

function ensureImportSources(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS import_sources (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      source      TEXT NOT NULL,
      path        TEXT NOT NULL,
      last_hash   TEXT,
      imported_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

function loadImportedKeys(db) {
  ensureImportSources(db);
  const rows = db.prepare("SELECT path FROM import_sources WHERE source = 'slack'").all();
  return new Set(rows.map((r) => r.path));
}

function markImported(db, key) {
  const row = db.prepare("SELECT id FROM import_sources WHERE source='slack' AND path=?").get(key);
  if (row) {
    db.prepare("UPDATE import_sources SET imported_at=datetime('now') WHERE source='slack' AND path=?").run(key);
  } else {
    db.prepare("INSERT INTO import_sources (source, path) VALUES ('slack', ?)").run(key);
  }
}

// ─── Channel resolution ───────────────────────────────────────────────────

async function listMemberChannels(token) {
  const channels = [];
  let cursor = null;
  do {
    const json = await slackFetch(token, 'conversations.list', {
      types: 'public_channel,private_channel',
      exclude_archived: true,
      limit: 200,
      cursor: cursor || undefined,
    });
    for (const c of json.channels || []) {
      if (c.is_member) channels.push({ id: c.id, name: c.name });
    }
    cursor = json.response_metadata?.next_cursor || null;
  } while (cursor);
  return channels;
}

// ─── Main import ──────────────────────────────────────────────────────────

/**
 * @param {object} cfg
 * @param {string} cfg.token   Slack token (xoxb-/xoxp-, scopes: channels:read+history)
 * @param {object} [opts]
 * @param {boolean} [opts.skipAi]
 * @param {string}  [opts.channel]  comma-separated names or C-ids (default: all member channels)
 * @param {number}  [opts.days]     lookback window in days (default 30)
 * @param {number}  [opts.limit]    cap number of observations imported this run
 * @param {string}  [opts.label]    project label for observations (default: 'slack')
 * @param {function}[opts.onProgress]
 * @returns {Promise<{imported:number, skipped:number, errors:number, total:number, channels:number}>}
 */
export async function importSlack(cfg, opts = {}) {
  if (!cfg?.token) {
    throw new Error('importSlack: token is required (xoxb-/xoxp- with channels:read + channels:history)');
  }
  const { token } = cfg;
  const {
    skipAi = false,
    channel = null,
    days = 30,
    limit = null,
    label = 'slack',
    onProgress,
  } = opts;

  const db = getDb();
  const done = loadImportedKeys(db);

  // Resolve target channels
  const all = await listMemberChannels(token);
  let targets = all;
  if (channel) {
    const wanted = String(channel).split(',').map((s) => s.trim().replace(/^#/, '').toLowerCase()).filter(Boolean);
    targets = all.filter((c) => wanted.includes(c.name.toLowerCase()) || wanted.includes(c.id.toLowerCase()));
    if (!targets.length) {
      throw new Error(`importSlack: no member channels match "${channel}" (member of: ${all.map((c) => c.name).join(', ') || 'none'})`);
    }
  }

  const oldest = (Date.now() / 1000 - days * 86400).toFixed(6);

  const sessionId = `import-slack-${Date.now()}`;
  upsertSession(sessionId, label);

  let imported = 0, skipped = 0, errors = 0, total = 0;

  try {
    outer:
    for (const ch of targets) {
      let cursor = null;
      do {
        const json = await slackFetch(token, 'conversations.history', {
          channel: ch.id,
          oldest,
          limit: 200,
          cursor: cursor || undefined,
        });

        for (const msg of json.messages || []) {
          if (!msg?.ts) continue;
          // Реплаи в тредах приходят и в history — импортируем их через parent.
          if (msg.thread_ts && msg.thread_ts !== msg.ts) continue;
          total++;

          const key = slackMessageKey(ch.id, msg);
          if (done.has(key)) {
            skipped++;
            onProgress?.({ done: imported + skipped + errors, total, current: 'skip:' + key });
            continue;
          }
          if (isNoiseMessage(msg)) { skipped++; continue; }

          try {
            const isThread = (msg.reply_count || 0) > 0;
            let replies = [];
            if (isThread) {
              const rj = await slackFetch(token, 'conversations.replies', {
                channel: ch.id, ts: msg.ts, limit: 50,
              });
              replies = rj.messages || [];
            }

            const kind = isThread ? 'thread' : 'message';
            const header = `[#${ch.name}] ${kind}${isThread ? ` (${msg.reply_count} replies)` : ''}\n`;
            const content = header + threadToContent(msg, replies);
            const importance = estimateSlackImportance(msg);

            let summary = content.slice(0, 300);
            let tags = slackTags(msg, ch.name);

            if (!skipAi && content.length > 200) {
              try {
                const compressed = await compress({
                  tool: `slack-${kind}`,
                  input: `#${ch.name} @ ${msg.ts}`,
                  output: content,
                  project: label,
                });
                if (compressed) {
                  summary = compressed.summary || summary;
                  tags = [...tags, ...(compressed.tags || [])];
                }
              } catch { /* fallback */ }
            }

            const obsId = saveObservation({
              sessionId,
              project: label,
              tool: `slack-${kind}`,
              summary,
              rawInput: `#${ch.name} @ ${msg.ts}`,
              rawOutput: content.slice(0, 2000),
              tags,
              importance,
            });

            try {
              const meta = await embedWithMeta(summary);
              if (meta?.vector) saveEmbedding(obsId, meta.vector, meta.model);
            } catch { /* non-critical */ }
            try { addObservationToGraph({ id: obsId, project: label, tool: `slack-${kind}`, summary, tags: JSON.stringify(tags), importance, decision_rationale: null, raw_input: null }); } catch { /* non-critical */ }

            markImported(db, key);
            imported++;
          } catch (err) {
            console.error(`[slack:import] message ${key} failed: ${err.message}`);
            errors++;
          }

          onProgress?.({ done: imported + skipped + errors, total, current: key });
          if (limit && imported >= limit) break outer;
        }

        cursor = json.response_metadata?.next_cursor || null;
      } while (cursor);
    }
  } catch (err) {
    closeSession(sessionId, `Slack import failed: ${err.message}`, { computeFriction: computeFrictionScore });
    throw err;
  }

  const summary = `Slack import (${targets.length} channels): ${imported} imported, ${skipped} skipped, ${errors} errors (of ${total} seen).`;
  closeSession(sessionId, summary, { computeFriction: computeFrictionScore });

  return { imported, skipped, errors, total, channels: targets.length };
}
