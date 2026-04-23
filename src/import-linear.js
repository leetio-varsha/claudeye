/**
 * src/import-linear.js — Linear import for Claudeye (#10)
 *
 * Imports Linear issues and their comments as observations in mem.db.
 * Uses the Linear GraphQL API with a personal or OAuth API key.
 *
 * Idempotent: tracks imported items in import_sources (source='linear', path=<issue_id or issue_id#comment_id>).
 * Incremental: re-running only imports new/untracked issues and comments.
 *
 * Usage (via CLI):
 *   claudeye import linear --token <api-key>
 *   LINEAR_API_KEY=<key> claudeye import linear
 *
 * Optional:
 *   --team <team-key>    restrict to a Linear team key (e.g. "ENG")
 *   --limit <n>          cap number of issues imported this run
 */

import { getDb, saveObservation, upsertSession, closeSession, saveEmbedding } from './db.js';
import { computeFrictionScore } from './analytics.js';
import { compressObservation as compress } from './compress.js';
import { embedWithMeta } from './embeddings.js';

const LINEAR_GQL = 'https://api.linear.app/graphql';

// ─── GraphQL helper ───────────────────────────────────────────────────────

async function linearGql(token, query, variables = {}) {
  const res = await fetch(LINEAR_GQL, {
    method: 'POST',
    headers: {
      Authorization: token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Linear GraphQL ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = await res.json();
  if (json.errors?.length) {
    throw new Error(`Linear GraphQL errors: ${json.errors.map(e => e.message).join(' | ')}`);
  }
  return json.data;
}

// ─── Importance / tagging ─────────────────────────────────────────────────

/** Map Linear priority (0..4) to importance boost. 1 = urgent, 4 = low. */
export function linearPriorityBoost(priority) {
  switch (priority) {
    case 1: return 0.15;  // urgent
    case 2: return 0.08;  // high
    case 3: return 0.0;   // medium (default)
    case 4: return -0.05; // low
    default: return 0.0;  // 0 = no priority
  }
}

export function estimateLinearIssueImportance(issue) {
  const stateType = (issue.state?.type || '').toLowerCase();
  const labels    = (issue.labels?.nodes || []).map(l => (l.name || '').toLowerCase());

  let base = 0.55;
  if (labels.some(l => l.includes('bug')))     base = 0.75;
  else if (labels.some(l => l.includes('feature') || l.includes('enhancement'))) base = 0.6;

  base += linearPriorityBoost(issue.priority);

  // Cancelled/completed issues are less actionable — slight downweight
  if (stateType === 'canceled') base -= 0.1;

  return Math.max(0.1, Math.min(0.95, base));
}

export function linearIssueTags(issue) {
  const tags = ['linear', 'import', 'issue'];
  if (issue.state?.name)   tags.push(`status:${issue.state.name.toLowerCase().replace(/\s+/g, '-')}`);
  if (issue.team?.key)     tags.push(`team:${issue.team.key.toLowerCase()}`);
  if (issue.priority)      tags.push(`priority:${issue.priority}`);
  for (const l of issue.labels?.nodes || []) {
    if (l.name) tags.push(`label:${l.name.toLowerCase().replace(/\s+/g, '-')}`);
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
  const rows = db.prepare("SELECT path FROM import_sources WHERE source = 'linear'").all();
  return new Set(rows.map(r => r.path));
}

function markImported(db, key) {
  const row = db.prepare("SELECT id FROM import_sources WHERE source='linear' AND path=?").get(key);
  if (row) {
    db.prepare("UPDATE import_sources SET imported_at=datetime('now') WHERE source='linear' AND path=?").run(key);
  } else {
    db.prepare("INSERT INTO import_sources (source, path) VALUES ('linear', ?)").run(key);
  }
}

// ─── GraphQL queries ──────────────────────────────────────────────────────

const ISSUES_QUERY = `
  query Issues($after: String, $first: Int!, $filter: IssueFilter) {
    issues(first: $first, after: $after, filter: $filter, orderBy: updatedAt) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        identifier
        title
        description
        priority
        createdAt
        updatedAt
        url
        state   { id name type }
        team    { id key name }
        assignee { displayName name }
        creator  { displayName name }
        labels   { nodes { id name } }
        comments(first: 50) {
          nodes {
            id
            body
            createdAt
            user { displayName name }
          }
        }
      }
    }
  }
`;

// ─── Main import ──────────────────────────────────────────────────────────

/**
 * @param {string} token  Linear API key
 * @param {object} [opts]
 * @param {boolean} [opts.skipAi]
 * @param {string}  [opts.team]    Linear team KEY (e.g. "ENG")
 * @param {number}  [opts.limit]   Cap number of issues imported
 * @param {string}  [opts.label]   Project label for observations (default: 'linear')
 * @param {function}[opts.onProgress]
 */
export async function importLinear(token, opts = {}) {
  if (!token) throw new Error('importLinear: token is required');
  const { skipAi = false, team: teamKey = null, limit = null, label = 'linear', onProgress } = opts;

  const db = getDb();
  const done = loadImportedKeys(db);

  const sessionId = `import-linear-${Date.now()}`;
  upsertSession(sessionId, label);

  // Optional team filter
  const filter = teamKey ? { team: { key: { eq: teamKey } } } : null;

  let imported = 0, skipped = 0, errors = 0, total = 0;
  let cursor = null;

  try {
    while (true) {
      const data = await linearGql(token, ISSUES_QUERY, { first: 50, after: cursor, filter });
      const page = data.issues;
      const nodes = page?.nodes || [];
      if (!nodes.length) break;

      for (const issue of nodes) {
        total++;
        const key = issue.identifier || issue.id;
        if (!key) continue;

        if (done.has(issue.id)) {
          skipped++;
          onProgress?.({ done: imported + skipped + errors, total, current: 'skip:' + key });
          continue;
        }

        try {
          const title    = issue.title || '(no title)';
          const desc     = (issue.description || '').slice(0, 3000);
          const status   = issue.state?.name || '';
          const teamName = issue.team?.key || issue.team?.name || '';
          const assignee = issue.assignee?.displayName || issue.assignee?.name || '';
          const creator  = issue.creator?.displayName  || issue.creator?.name  || '';

          const header = `[${key}] ${title}\n` +
            (teamName ? `Team: ${teamName} | ` : '') +
            `Status: ${status} | Priority: ${issue.priority ?? 'none'}\n` +
            (assignee ? `Assignee: ${assignee}\n` : '') +
            (creator  ? `Creator: ${creator}\n`  : '');
          const content = desc ? `${header}\n${desc}` : header;

          const importance = estimateLinearIssueImportance(issue);
          let summary = content.slice(0, 300);
          let tags    = linearIssueTags(issue);

          if (!skipAi && content.length > 200) {
            try {
              const compressed = await compress({
                tool: 'linear-issue',
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
            tool: 'linear-issue',
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

          // ── Comments ──────────────────────────────────────────────
          const comments = issue.comments?.nodes || [];
          for (const c of comments) {
            const cKey = `${issue.id}#${c.id}`;
            if (done.has(cKey)) continue;

            try {
              const body = (c.body || '').slice(0, 3000);
              if (!body.trim()) continue;
              const author = c.user?.displayName || c.user?.name || '';
              const cSummary = `[${key}] comment by ${author}: ${body.slice(0, 150)}`;
              const cTags    = ['linear', 'import', 'comment', `issue:${key.toLowerCase()}`];
              const cImportance = Math.max(0.3, importance - 0.1);

              const cId = saveObservation({
                sessionId,
                project: label,
                tool: 'linear-comment',
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

              markImported(db, cKey);
            } catch (err) {
              console.error(`[linear:import] comment ${cKey} failed: ${err.message}`);
              errors++;
            }
          }

          markImported(db, issue.id);
          imported++;
        } catch (err) {
          console.error(`[linear:import] issue ${key} failed: ${err.message}`);
          errors++;
        }

        onProgress?.({ done: imported + skipped + errors, total, current: key });

        if (limit && imported >= limit) break;
      }

      if (limit && imported >= limit) break;
      if (!page.pageInfo?.hasNextPage) break;
      cursor = page.pageInfo.endCursor;
    }
  } catch (err) {
    closeSession(sessionId, `Linear import failed: ${err.message}`, { computeFriction: computeFrictionScore });
    throw err;
  }

  const summary = `Linear import: ${imported} issues imported, ${skipped} skipped, ${errors} errors (of ${total} seen).`;
  closeSession(sessionId, summary, { computeFriction: computeFrictionScore });

  return { imported, skipped, errors, total };
}
