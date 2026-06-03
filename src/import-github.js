/**
 * src/import-github.js — GitHub read-first import for Claudeye (#23)
 *
 * Imports GitHub issues, pull requests and their comments as observations
 * in mem.db. Uses the GitHub REST API v3 with a personal access token.
 *
 * Read-first: only GETs, no write operations (per #23 "read-first, write-later").
 *
 * Idempotent: tracks imported items in import_sources
 *   (source='github', path=<owner/repo#number> or <owner/repo#number#c<id>>).
 * Incremental: re-running only imports new/untracked items.
 *
 * Usage (via CLI):
 *   claudeye import github --repo owner/name --token <token>
 *   GITHUB_TOKEN=... claudeye import github --repo owner/name
 *
 * Optional:
 *   --state <open|closed|all>   issue/PR state filter (default: all)
 *   --limit <n>                 cap number of items
 *   --since <ISO date>          only items updated since date
 */

import { getDb, saveObservation, upsertSession, closeSession, saveEmbedding } from './db.js';
import { computeFrictionScore } from './analytics.js';
import { compressObservation as compress } from './compress.js';
import { embedWithMeta } from './embeddings.js';
import { addObservationToGraph } from './graph.js';

// ─── HTTP helpers ─────────────────────────────────────────────────────────

const API_BASE = 'https://api.github.com';

async function ghFetch(token, path, query = null) {
  const url = new URL(`${API_BASE}${path}`);
  if (query && typeof query === 'object') {
    for (const [k, v] of Object.entries(query)) {
      if (v != null) url.searchParams.set(k, String(v));
    }
  }
  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'claudeye-import',
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GitHub API GET ${path} → ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

// ─── Pure helpers (exported for tests) ────────────────────────────────────

/** True if a /issues list item is actually a pull request. */
export function isPullRequest(item) {
  return Boolean(item && item.pull_request);
}

/**
 * Importance score from item kind, labels and state.
 * Mirrors estimateIssueImportance (jira): bugs > features > chores,
 * merged PRs slightly boosted, clamped to [0.1, 0.95].
 */
export function estimateGitHubImportance(item) {
  const labels = (item?.labels || [])
    .map((l) => (typeof l === 'string' ? l : l?.name || ''))
    .map((s) => s.toLowerCase());

  let base = isPullRequest(item) ? 0.6 : 0.5;

  if (labels.some((l) => l.includes('bug')))               base = Math.max(base, 0.75);
  else if (labels.some((l) => l.includes('feature') || l.includes('enhancement'))) base = Math.max(base, 0.6);
  else if (labels.some((l) => l.includes('epic')))         base = Math.max(base, 0.7);

  if (labels.some((l) => l.includes('critical') || l.includes('p0') || l.includes('blocker'))) base += 0.15;
  else if (labels.some((l) => l.includes('high') || l.includes('p1'))) base += 0.08;
  else if (labels.some((l) => l.includes('low') || l.includes('p3')))  base -= 0.05;

  // Merged PRs represent landed decisions — slightly more valuable.
  if (item?.pull_request?.merged_at) base += 0.05;

  return Math.max(0.1, Math.min(0.95, base));
}

/** Build tag array from item metadata (kind, state, labels). */
export function githubTags(item) {
  const kind = isPullRequest(item) ? 'pr' : 'issue';
  const tags = ['github', 'import', kind];
  if (item?.state) tags.push(`status:${String(item.state).toLowerCase()}`);
  if (item?.pull_request?.merged_at) tags.push('status:merged');
  for (const l of item?.labels || []) {
    const name = typeof l === 'string' ? l : l?.name;
    if (name) tags.push(`label:${name.toLowerCase().replace(/\s+/g, '-')}`);
  }
  return tags;
}

/** Stable idempotency key for an issue/PR within a repo. */
export function githubItemKey(repo, item) {
  return `${repo}#${item.number}`;
}

// ─── Import tracking ──────────────────────────────────────────────────────

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
  const rows = db.prepare("SELECT path FROM import_sources WHERE source = 'github'").all();
  return new Set(rows.map((r) => r.path));
}

function markImported(db, key) {
  const row = db.prepare("SELECT id FROM import_sources WHERE source='github' AND path=?").get(key);
  if (row) {
    db.prepare("UPDATE import_sources SET imported_at=datetime('now') WHERE source='github' AND path=?").run(key);
  } else {
    db.prepare("INSERT INTO import_sources (source, path) VALUES ('github', ?)").run(key);
  }
}

// ─── Main import ──────────────────────────────────────────────────────────

/**
 * @param {object} cfg
 * @param {string} cfg.repo    "owner/name"
 * @param {string} cfg.token   GitHub PAT (or fine-grained token with repo read)
 * @param {object} [opts]
 * @param {boolean} [opts.skipAi]
 * @param {string}  [opts.state]   'open' | 'closed' | 'all' (default 'all')
 * @param {number}  [opts.limit]   cap number of items imported this run
 * @param {string}  [opts.since]   ISO date — only items updated since
 * @param {string}  [opts.label]   project label for observations (default: repo name)
 * @param {function}[opts.onProgress]
 * @returns {Promise<{imported:number, skipped:number, errors:number, total:number}>}
 */
export async function importGitHub(cfg, opts = {}) {
  if (!cfg?.repo || !cfg?.token) {
    throw new Error('importGitHub: repo and token are required');
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(cfg.repo)) {
    throw new Error(`importGitHub: repo must be "owner/name", got "${cfg.repo}"`);
  }
  const { repo, token } = cfg;
  const {
    skipAi = false,
    state = 'all',
    limit = null,
    since = null,
    label = repo.split('/')[1],
    onProgress,
  } = opts;

  const db = getDb();
  const done = loadImportedKeys(db);

  const sessionId = `import-github-${Date.now()}`;
  upsertSession(sessionId, label);

  const pageSize = 100;
  let page = 1;
  let imported = 0, skipped = 0, errors = 0, total = 0;

  try {
    while (true) {
      // /issues returns both issues and PRs (PRs carry .pull_request)
      const items = await ghFetch(token, `/repos/${repo}/issues`, {
        state,
        sort: 'updated',
        direction: 'desc',
        per_page: pageSize,
        page,
        since: since || undefined,
      });
      if (!Array.isArray(items) || !items.length) break;
      total += items.length;

      for (const item of items) {
        if (!item?.number) continue;
        const key = githubItemKey(repo, item);

        if (done.has(key)) {
          skipped++;
          onProgress?.({ done: imported + skipped + errors, total, current: 'skip:' + key });
          continue;
        }

        try {
          const kind   = isPullRequest(item) ? 'pr' : 'issue';
          const title  = item.title || '(no title)';
          const body   = (item.body || '').slice(0, 3000);
          const author = item.user?.login || '';
          const stateStr = item.pull_request?.merged_at ? 'merged' : item.state || '';

          const header = `[${key}] ${title}\n` +
            `Kind: ${kind} | State: ${stateStr}` +
            (author ? ` | Author: ${author}` : '') + '\n';
          const content = body ? `${header}\n${body}` : header;
          const importance = estimateGitHubImportance(item);

          let summary = content.slice(0, 300);
          let tags    = githubTags(item);

          if (!skipAi && content.length > 200) {
            try {
              const compressed = await compress({
                tool: `github-${kind}`,
                input: `${key}: ${title}`,
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
            tool: `github-${kind}`,
            summary,
            rawInput:  `${key}: ${title}`,
            rawOutput: content.slice(0, 2000),
            tags,
            importance,
          });

          try {
            const meta = await embedWithMeta(summary);
            if (meta?.vector) saveEmbedding(obsId, meta.vector, meta.model);
          } catch { /* non-critical */ }
          try { addObservationToGraph({ id: obsId, project: label, tool: `github-${kind}`, summary, tags: JSON.stringify(tags), importance, decision_rationale: null, raw_input: `${key}: ${title}` }); } catch { /* non-critical */ }

          // ── Comments (only if the item has any)
          if (item.comments > 0) {
            const comments = await ghFetch(token, `/repos/${repo}/issues/${item.number}/comments`, { per_page: 100 });
            for (const c of comments || []) {
              const cKey = `${key}#c${c.id}`;
              if (done.has(cKey)) continue;
              try {
                const cBody = (c.body || '').trim();
                if (!cBody) continue;
                const cAuthor = c.user?.login || '';
                const cSummary = `[${key}] comment by ${cAuthor}: ${cBody.slice(0, 150)}`;
                const cTags = ['github', 'import', 'comment', `${kind}:${key.toLowerCase()}`];
                const cImportance = Math.max(0.3, importance - 0.1);

                const cId = saveObservation({
                  sessionId,
                  project: label,
                  tool: 'github-comment',
                  summary: cSummary,
                  rawInput: `${key} comment by ${cAuthor}`,
                  rawOutput: cBody.slice(0, 2000),
                  tags: cTags,
                  importance: cImportance,
                });

                try {
                  const meta = await embedWithMeta(cSummary);
                  if (meta?.vector) saveEmbedding(cId, meta.vector, meta.model);
                } catch { /* non-critical */ }
                try { addObservationToGraph({ id: cId, project: label, tool: 'github-comment', summary: cSummary, tags: JSON.stringify(cTags), importance: cImportance, decision_rationale: null, raw_input: null }); } catch { /* non-critical */ }

                markImported(db, cKey);
              } catch (err) {
                console.error(`[github:import] comment ${cKey} failed: ${err.message}`);
                errors++;
              }
            }
          }

          markImported(db, key);
          imported++;
        } catch (err) {
          console.error(`[github:import] item ${key} failed: ${err.message}`);
          errors++;
        }

        onProgress?.({ done: imported + skipped + errors, total, current: key });

        if (limit && imported >= limit) break;
      }

      if (limit && imported >= limit) break;
      if (items.length < pageSize) break;
      page += 1;
    }
  } catch (err) {
    closeSession(sessionId, `GitHub import failed: ${err.message}`, { computeFriction: computeFrictionScore });
    throw err;
  }

  const summary = `GitHub import (${repo}): ${imported} items imported, ${skipped} skipped, ${errors} errors (of ${total} seen).`;
  closeSession(sessionId, summary, { computeFriction: computeFrictionScore });

  return { imported, skipped, errors, total };
}
