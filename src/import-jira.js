/**
 * src/import-jira.js — Jira import for Claudeye (#10)
 *
 * Imports Jira issues and their comments as observations in mem.db.
 * Uses the Jira Cloud REST API v3 with email + API token (basic auth).
 *
 * Idempotent: tracks imported items in import_sources (source='jira', path=<issue_key>).
 * Incremental: re-running only imports new/untracked issues and comments.
 *
 * Usage (via CLI):
 *   claudeye import jira --url https://<workspace>.atlassian.net --email <email> --token <token>
 *   JIRA_URL=... JIRA_EMAIL=... JIRA_API_TOKEN=... claudeye import jira
 *
 * Optional:
 *   --jql "<JQL>"        custom query (defaults to "ORDER BY updated DESC")
 *   --project <key>      restrict to Jira project key (e.g. "ENG")
 *   --limit <n>          cap number of issues
 */

import { getDb, saveObservation, upsertSession, closeSession, saveEmbedding } from './db.js';
import { computeFrictionScore } from './analytics.js';
import { compressObservation as compress } from './compress.js';
import { embedWithMeta } from './embeddings.js';
import { addObservationToGraph } from './graph.js';

// ─── HTTP helpers ─────────────────────────────────────────────────────────

function authHeader(email, token) {
  const raw = `${email}:${token}`;
  // Node 20+ has Buffer; fallback to btoa if running in an environment without it.
  const encoded = typeof Buffer !== 'undefined'
    ? Buffer.from(raw, 'utf8').toString('base64')
    : btoa(raw);
  return `Basic ${encoded}`;
}

async function jiraFetch(baseUrl, email, token, path, opts = {}) {
  const { method = 'GET', body = null, query = null } = opts;
  const url = new URL(`${baseUrl.replace(/\/$/, '')}${path}`);
  if (query && typeof query === 'object') {
    for (const [k, v] of Object.entries(query)) {
      if (v != null) url.searchParams.set(k, String(v));
    }
  }
  const res = await fetch(url.toString(), {
    method,
    headers: {
      Authorization: authHeader(email, token),
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Jira API ${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

// ─── Content extraction ───────────────────────────────────────────────────

/**
 * Jira API v3 returns description/comment body as Atlassian Document Format (ADF),
 * which is a nested JSON tree. We recursively extract plain text.
 */
export function adfToText(node, maxChars = 3000) {
  const parts = [];
  const visit = (n) => {
    if (!n) return;
    if (typeof n === 'string') { parts.push(n); return; }
    if (Array.isArray(n)) { n.forEach(visit); return; }
    if (n.text) parts.push(n.text);
    if (n.type === 'hardBreak' || n.type === 'paragraph') parts.push('\n');
    if (n.content) visit(n.content);
  };
  visit(node);
  return parts.join('').replace(/\n{3,}/g, '\n\n').trim().slice(0, maxChars);
}

/** Convert issue-type + priority into an importance score. */
export function estimateIssueImportance(issue) {
  const type     = (issue.fields?.issuetype?.name || '').toLowerCase();
  const priority = (issue.fields?.priority?.name || '').toLowerCase();

  let base = 0.5;
  if (type.includes('bug'))         base = 0.75;
  else if (type.includes('feature')) base = 0.6;
  else if (type.includes('story'))   base = 0.55;
  else if (type.includes('task'))    base = 0.5;
  else if (type.includes('epic'))    base = 0.7;

  if (priority.includes('highest') || priority.includes('critical') || priority.includes('blocker')) base += 0.15;
  else if (priority.includes('high')) base += 0.08;
  else if (priority.includes('low'))  base -= 0.05;

  return Math.max(0.1, Math.min(0.95, base));
}

/** Build tag array from issue metadata (status, labels, type). */
export function issueTags(issue) {
  const tags = ['jira', 'import', 'issue'];
  const status = issue.fields?.status?.name;
  const type   = issue.fields?.issuetype?.name;
  const prio   = issue.fields?.priority?.name;
  if (status) tags.push(`status:${status.toLowerCase().replace(/\s+/g, '-')}`);
  if (type)   tags.push(`type:${type.toLowerCase().replace(/\s+/g, '-')}`);
  if (prio)   tags.push(`priority:${prio.toLowerCase().replace(/\s+/g, '-')}`);
  for (const lbl of issue.fields?.labels || []) {
    if (typeof lbl === 'string') tags.push(`label:${lbl.toLowerCase()}`);
  }
  return tags;
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
  const rows = db.prepare("SELECT path FROM import_sources WHERE source = 'jira'").all();
  return new Set(rows.map(r => r.path));
}

function markImported(db, key) {
  const row = db.prepare("SELECT id FROM import_sources WHERE source='jira' AND path=?").get(key);
  if (row) {
    db.prepare("UPDATE import_sources SET imported_at=datetime('now') WHERE source='jira' AND path=?").run(key);
  } else {
    db.prepare("INSERT INTO import_sources (source, path) VALUES ('jira', ?)").run(key);
  }
}

// ─── Main import ──────────────────────────────────────────────────────────

/**
 * @param {object} cfg
 * @param {string} cfg.baseUrl   e.g. "https://acme.atlassian.net"
 * @param {string} cfg.email
 * @param {string} cfg.token
 * @param {object} [opts]
 * @param {boolean} [opts.skipAi]
 * @param {string}  [opts.jql]     custom JQL (default: "ORDER BY updated DESC")
 * @param {string}  [opts.project] Jira project key filter (e.g. "ENG")
 * @param {number}  [opts.limit]   cap number of issues imported this run
 * @param {string}  [opts.label]   project label used for observations (default: 'jira')
 * @param {function}[opts.onProgress]
 * @returns {Promise<{imported:number, skipped:number, errors:number, total:number}>}
 */
export async function importJira(cfg, opts = {}) {
  if (!cfg?.baseUrl || !cfg?.email || !cfg?.token) {
    throw new Error('importJira: baseUrl, email, token are required');
  }
  const { baseUrl, email, token } = cfg;
  const {
    skipAi = false,
    jql: customJql = null,
    project: projectKey = null,
    limit = null,
    label = 'jira',
    onProgress,
  } = opts;

  const db = getDb();
  const done = loadImportedKeys(db);

  const sessionId = `import-jira-${Date.now()}`;
  upsertSession(sessionId, label);

  // Build JQL
  let jql = customJql || '';
  if (!jql) jql = 'ORDER BY updated DESC';
  if (projectKey && !/\bproject\s*=/i.test(jql)) {
    jql = `project = "${projectKey}" AND ${jql}`;
  }

  // Paginate /rest/api/3/search (max 100 per page)
  const pageSize = 100;
  let startAt = 0;
  let imported = 0, skipped = 0, errors = 0, total = 0;

  try {
    while (true) {
      const page = await jiraFetch(baseUrl, email, token, '/rest/api/3/search', {
        query: {
          jql,
          startAt,
          maxResults: pageSize,
          fields: 'summary,description,status,issuetype,priority,labels,assignee,reporter,created,updated,comment',
          expand: 'renderedFields',
        },
      });
      total = page.total ?? total;
      const issues = page.issues || [];
      if (!issues.length) break;

      for (const issue of issues) {
        const key = issue.key;
        if (!key) continue;

        if (done.has(key)) {
          skipped++;
          onProgress?.({ done: imported + skipped + errors, total, current: 'skip:' + key });
          continue;
        }

        try {
          const title    = issue.fields?.summary || '(no summary)';
          const descText = adfToText(issue.fields?.description);
          const status   = issue.fields?.status?.name || '';
          const type     = issue.fields?.issuetype?.name || '';
          const priority = issue.fields?.priority?.name || '';
          const assignee = issue.fields?.assignee?.displayName || '';
          const reporter = issue.fields?.reporter?.displayName || '';

          const header = `[${key}] ${title}\n` +
            `Type: ${type} | Status: ${status} | Priority: ${priority || 'N/A'}\n` +
            (assignee ? `Assignee: ${assignee}\n` : '') +
            (reporter ? `Reporter: ${reporter}\n` : '');
          const content = descText ? `${header}\n${descText}` : header;
          const importance = estimateIssueImportance(issue);

          let summary = content.slice(0, 300);
          let tags    = issueTags(issue);

          if (!skipAi && content.length > 200) {
            try {
              const compressed = await compress({
                tool: 'jira-issue',
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
            tool: 'jira-issue',
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
          try { addObservationToGraph({ id: obsId, project: label, tool: 'jira-issue', summary, tags: JSON.stringify(tags), importance, decision_rationale: null, raw_input: `${key}: ${title}` }); } catch { /* non-critical */ }

          // ── Comments: v3 search returns comments in issue.fields.comment.comments
          const comments = issue.fields?.comment?.comments || [];
          for (const c of comments) {
            const cKey = `${key}#${c.id}`;
            if (done.has(cKey)) continue;
            try {
              const body   = adfToText(c.body);
              if (!body) continue;
              const author = c.author?.displayName || '';
              const cSummary = `[${key}] comment by ${author}: ${body.slice(0, 150)}`;
              const cTags    = ['jira', 'import', 'comment', `issue:${key.toLowerCase()}`];
              const cImportance = Math.max(0.3, importance - 0.1);

              const cId = saveObservation({
                sessionId,
                project: label,
                tool: 'jira-comment',
                summary: cSummary,
                rawInput: `${key} comment by ${author}`,
                rawOutput: body.slice(0, 2000),
                tags: cTags,
                importance: cImportance,
              });

              try {
                const meta = await embedWithMeta(cSummary);
                if (meta?.vector) saveEmbedding(cId, meta.vector, meta.model);
              } catch { /* non-critical */ }
              try { addObservationToGraph({ id: cId, project: label, tool: 'jira-comment', summary: cSummary, tags: JSON.stringify(cTags), importance: cImportance, decision_rationale: null, raw_input: null }); } catch { /* non-critical */ }

              markImported(db, cKey);
            } catch (err) {
              console.error(`[jira:import] comment ${cKey} failed: ${err.message}`);
              errors++;
            }
          }

          markImported(db, key);
          imported++;
        } catch (err) {
          console.error(`[jira:import] issue ${key} failed: ${err.message}`);
          errors++;
        }

        onProgress?.({ done: imported + skipped + errors, total, current: key });

        if (limit && imported >= limit) break;
      }

      if (limit && imported >= limit) break;
      startAt += issues.length;
      if (startAt >= (page.total ?? startAt)) break;
    }
  } catch (err) {
    closeSession(sessionId, `Jira import failed: ${err.message}`, { computeFriction: computeFrictionScore });
    throw err;
  }

  const summary = `Jira import: ${imported} issues imported, ${skipped} skipped, ${errors} errors (of ${total} total).`;
  closeSession(sessionId, summary, { computeFriction: computeFrictionScore });

  return { imported, skipped, errors, total };
}
