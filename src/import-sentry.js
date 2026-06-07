/**
 * src/import-sentry.js — Sentry read-first import for Claudeye (#23)
 *
 * Imports Sentry issues (grouped errors) with their latest stacktrace as
 * observations in mem.db — «errors, stacktraces → observations + auto-triage».
 *
 * Read-first: only GET endpoints (issues list + latest event), no writes
 * (per #23 "read-first, write-later"; assign/resolve — write-фаза).
 *
 * Auto-triage (read-only): each issue gets a triage level (high/medium/low)
 * derived from level × event count × users affected. It lands in tags
 * (`triage:high`) and drives importance, so search/advisor rank loud
 * production errors above one-off warnings.
 *
 * Idempotent: tracks imported issues in import_sources
 *   (source='sentry', path=<org>:<issue_id>).
 * Incremental: re-running only imports new/untracked issues.
 *
 * Usage (via CLI):
 *   claudeye import sentry --token <token> --org <slug> [--project-key <slug>] [--days 14]
 *   SENTRY_TOKEN=... SENTRY_ORG=... claudeye import sentry
 *
 * Token: User Auth Token / internal integration token, scopes: org:read,
 * project:read, event:read. Self-hosted: pass --url https://sentry.mycorp.com.
 */

import { getDb, saveObservation, upsertSession, closeSession, saveEmbedding } from './db.js';
import { computeFrictionScore } from './analytics.js';
import { compressObservation as compress } from './compress.js';
import { embedWithMeta } from './embeddings.js';
import { addObservationToGraph } from './graph.js';

// ─── HTTP helpers ─────────────────────────────────────────────────────────

const DEFAULT_BASE = 'https://sentry.io';

async function sentryFetchRaw(cfg, path, query = {}) {
  const url = new URL(`/api/0${path}`, cfg.url || DEFAULT_BASE);
  for (const [k, v] of Object.entries(query)) {
    if (v != null) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${cfg.token}` },
  });
  // Rate limit: одна повторная попытка по Retry-After (как slack).
  if (res.status === 429) {
    const wait = Math.min(30, Number(res.headers.get('retry-after') || 5));
    await new Promise((r) => setTimeout(r, wait * 1000));
    return sentryFetchRaw(cfg, path, query);
  }
  if (!res.ok) {
    throw new Error(`Sentry API ${path} → HTTP ${res.status}`);
  }
  return res;
}

async function sentryFetch(cfg, path, query = {}) {
  const res = await sentryFetchRaw(cfg, path, query);
  return res.json();
}

/**
 * Paged GET: Sentry пагинирует через Link header
 *   <...&cursor=X>; rel="next"; results="true"; cursor="X"
 * results="false" → следующей страницы нет.
 */
export function parseNextCursor(linkHeader) {
  if (!linkHeader) return null;
  const next = String(linkHeader).split(',').find((p) => p.includes('rel="next"'));
  if (!next || !next.includes('results="true"')) return null;
  const m = next.match(/cursor="([^"]+)"/);
  return m ? m[1] : null;
}

async function sentryFetchPaged(cfg, path, query = {}) {
  const res = await sentryFetchRaw(cfg, path, query);
  const data = await res.json();
  return { data, nextCursor: parseNextCursor(res.headers.get('link')) };
}

// ─── Pure helpers (exported for tests) ────────────────────────────────────

/**
 * Auto-triage level: насколько громкая проблема.
 * fatal/error с массовостью → high; warning/малая частота → low.
 */
export function triageLevel(issue) {
  const level = String(issue?.level || '').toLowerCase();
  const count = Number(issue?.count || 0);
  const users = Number(issue?.userCount || 0);
  const severe = level === 'fatal' || level === 'error';
  if ((severe && (count >= 50 || users >= 10)) || level === 'fatal') return 'high';
  if (severe || count >= 10 || users >= 3) return 'medium';
  return 'low';
}

/**
 * Importance: уровень + массовость (events, users). Регрессии чуть выше.
 * Clamped to [0.1, 0.95] (как github/jira/slack).
 */
export function estimateSentryImportance(issue) {
  let base = 0.4;
  const level = String(issue?.level || '').toLowerCase();
  if (level === 'fatal') base = 0.75;
  else if (level === 'error') base = 0.55;
  else if (level === 'warning') base = 0.35;
  const count = Number(issue?.count || 0);
  if (count >= 100) base += 0.15;
  else if (count >= 10) base += 0.08;
  const users = Number(issue?.userCount || 0);
  if (users >= 10) base += 0.1;
  else if (users >= 3) base += 0.05;
  if (issue?.substatus === 'regressed') base += 0.05;
  return Math.max(0.1, Math.min(0.95, base));
}

/** Tag array: source, kind, level, triage, sentry-project. */
export function sentryTags(issue) {
  const tags = ['sentry', 'import', 'error-tracking'];
  const level = String(issue?.level || '').toLowerCase();
  if (level) tags.push(`level:${level}`);
  tags.push(`triage:${triageLevel(issue)}`);
  const proj = issue?.project?.slug;
  if (proj) tags.push(`sentry-project:${String(proj).toLowerCase()}`);
  if (issue?.substatus === 'regressed') tags.push('regression');
  return tags;
}

/** Stable idempotency key for an issue within an org. */
export function sentryIssueKey(org, issue) {
  return `${org}:${issue.id}`;
}

/**
 * Extract top in-app stack frames from a Sentry event payload.
 * Walks entries[type=exception] → values → stacktrace.frames.
 * Frames come oldest-first; the crash site is at the END.
 */
export function extractStackFrames(event, { maxFrames = 8 } = {}) {
  const out = [];
  for (const entry of event?.entries || []) {
    if (entry?.type !== 'exception') continue;
    for (const val of entry.data?.values || []) {
      const frames = val?.stacktrace?.frames || [];
      const inApp = frames.filter((f) => f?.inApp !== false);
      const picked = (inApp.length ? inApp : frames).slice(-maxFrames);
      for (const f of picked) {
        const where = f.filename || f.module || f.package || '?';
        const fn = f.function || '?';
        const line = f.lineNo != null ? `:${f.lineNo}` : '';
        out.push(`  at ${fn} (${where}${line})`);
      }
      if (val?.type || val?.value) {
        out.unshift(`${val.type || 'Error'}: ${String(val.value || '').slice(0, 200)}`);
      }
    }
  }
  return out;
}

/** Render an issue (+ optional stack frames) as plain text content. */
export function issueToContent(issue, frames = [], { maxChars = 3000 } = {}) {
  const lines = [
    `[${issue.level || 'error'}] ${issue.title || issue.metadata?.type || 'Unknown error'}`,
  ];
  if (issue.culprit) lines.push(`culprit: ${issue.culprit}`);
  lines.push(
    `events: ${issue.count || 0}, users: ${issue.userCount || 0}, ` +
    `first: ${issue.firstSeen || '?'}, last: ${issue.lastSeen || '?'}`
  );
  if (issue.substatus) lines.push(`substatus: ${issue.substatus}`);
  if (issue.permalink) lines.push(issue.permalink);
  if (frames.length) {
    lines.push('', 'stacktrace (top in-app frames):', ...frames);
  }
  return lines.join('\n').slice(0, maxChars);
}

// ─── Import tracking (same pattern as import-slack.js) ────────────────────

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
  const rows = db.prepare("SELECT path FROM import_sources WHERE source = 'sentry'").all();
  return new Set(rows.map((r) => r.path));
}

function markImported(db, key, lastSeen = null) {
  const row = db.prepare("SELECT id FROM import_sources WHERE source='sentry' AND path=?").get(key);
  if (row) {
    db.prepare("UPDATE import_sources SET imported_at=datetime('now'), last_hash=? WHERE source='sentry' AND path=?").run(lastSeen, key);
  } else {
    db.prepare("INSERT INTO import_sources (source, path, last_hash) VALUES ('sentry', ?, ?)").run(key, lastSeen);
  }
}

// ─── Main import ──────────────────────────────────────────────────────────

/**
 * @param {object} cfg
 * @param {string} cfg.token    Sentry auth token (org:read, project:read, event:read)
 * @param {string} cfg.org      organization slug
 * @param {string} [cfg.url]    base URL for self-hosted (default https://sentry.io)
 * @param {object} [opts]
 * @param {boolean} [opts.skipAi]
 * @param {string}  [opts.project]    Sentry project slug filter
 * @param {number}  [opts.days]       lookback window in days (default 14)
 * @param {number}  [opts.limit]      cap number of observations imported this run
 * @param {boolean} [opts.stacks]     fetch latest-event stacktrace per issue (default true)
 * @param {string}  [opts.query]      issues search query (default 'is:unresolved')
 * @param {string}  [opts.label]      project label for observations (default: 'sentry')
 * @param {function}[opts.onProgress]
 * @returns {Promise<{imported:number, skipped:number, errors:number, total:number}>}
 */
export async function importSentry(cfg, opts = {}) {
  if (!cfg?.token) {
    throw new Error('importSentry: token is required (User Auth Token, scopes: org:read + project:read + event:read)');
  }
  if (!cfg?.org) {
    throw new Error('importSentry: org slug is required (--org <slug> or SENTRY_ORG)');
  }

  const {
    skipAi = false,
    project = null,
    days = 14,
    limit = null,
    stacks = true,
    query = 'is:unresolved',
    label = 'sentry',
    onProgress,
  } = opts;

  const db = getDb();
  const done = loadImportedKeys(db);

  const sessionId = `import-sentry-${Date.now()}`;
  upsertSession(sessionId, label);

  let imported = 0, skipped = 0, errors = 0, total = 0;

  try {
    let cursor = null;
    outer:
    do {
      const { data: issues, nextCursor } = await sentryFetchPaged(cfg, `/organizations/${cfg.org}/issues/`, {
        query,
        statsPeriod: `${days}d`,
        project: project || undefined,
        limit: 100,
        cursor: cursor || undefined,
      });
      cursor = nextCursor;

      for (const issue of issues || []) {
        if (!issue?.id) continue;
        total++;

        const key = sentryIssueKey(cfg.org, issue);
        if (done.has(key)) {
          skipped++;
          onProgress?.({ done: imported + skipped + errors, total, current: 'skip:' + key });
          continue;
        }

        try {
          let frames = [];
          if (stacks) {
            try {
              const event = await sentryFetch(cfg, `/issues/${issue.id}/events/latest/`);
              frames = extractStackFrames(event);
            } catch { /* stacktrace недоступен — импортируем без него */ }
          }

          const content = issueToContent(issue, frames);
          const importance = estimateSentryImportance(issue);

          let summary = `[${issue.level || 'error'}] ${issue.title || 'Unknown error'}`.slice(0, 300);
          let tags = sentryTags(issue);

          if (!skipAi && content.length > 200) {
            try {
              const compressed = await compress({
                tool: 'sentry-issue',
                input: `${cfg.org}/${issue.project?.slug || ''} #${issue.shortId || issue.id}`,
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
            tool: 'sentry-issue',
            summary,
            rawInput: `${cfg.org} #${issue.shortId || issue.id}`,
            rawOutput: content.slice(0, 2000),
            tags,
            importance,
          });

          try {
            const meta = await embedWithMeta(summary);
            if (meta?.vector) saveEmbedding(obsId, meta.vector, meta.model);
          } catch { /* non-critical */ }
          try { addObservationToGraph({ id: obsId, project: label, tool: 'sentry-issue', summary, tags: JSON.stringify(tags), importance, decision_rationale: null, raw_input: null }); } catch { /* non-critical */ }

          markImported(db, key, issue.lastSeen || null);
          imported++;
        } catch (err) {
          console.error(`[sentry:import] issue ${key} failed: ${err.message}`);
          errors++;
        }

        onProgress?.({ done: imported + skipped + errors, total, current: key });
        if (limit && imported >= limit) break outer;
      }

    } while (cursor);
  } catch (err) {
    closeSession(sessionId, `Sentry import failed: ${err.message}`, { computeFriction: computeFrictionScore });
    throw err;
  }

  const summary = `Sentry import (${cfg.org}): ${imported} imported, ${skipped} skipped, ${errors} errors (of ${total} seen).`;
  closeSession(sessionId, summary, { computeFriction: computeFrictionScore });

  return { imported, skipped, errors, total };
}
