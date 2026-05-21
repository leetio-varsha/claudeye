/**
 * src/import-notion.js — Notion import for Claudeye (#9)
 *
 * Imports Notion pages and database rows as observations in mem.db.
 * Uses the Notion REST API v1 with an integration token.
 *
 * Idempotent: tracks imported items in import_sources (source='notion', path=<page_id>).
 * Incremental: re-running only imports new/untracked items.
 *
 * Usage (via CLI):
 *   claudeye import notion --token <token>
 *   claudeye import notion --token <token> --database-only
 *   NOTION_API_KEY=<token> claudeye import notion
 */

import { getDb, saveObservation, upsertSession, closeSession, saveEmbedding } from './db.js';
import { computeFrictionScore } from './analytics.js';
import { compressObservation as compress } from './compress.js';
import { embedWithMeta } from './embeddings.js';
import { addObservationToGraph } from './graph.js';

const NOTION_API_BASE = 'https://api.notion.com/v1';
const NOTION_VERSION  = '2022-06-28';

// ─── Notion REST helpers ──────────────────────────────────────────────────

async function notionFetch(token, path, opts = {}) {
  const { method = 'GET', body = null } = opts;
  const res = await fetch(`${NOTION_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Notion API ${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

/** Paginate through a Notion endpoint that returns { results, has_more, next_cursor }. */
async function paginateNotion(token, path, body = {}) {
  const results = [];
  let cursor = undefined;
  do {
    const payload = cursor ? { ...body, start_cursor: cursor } : body;
    const data = await notionFetch(token, path, { method: 'POST', body: payload });
    results.push(...(data.results || []));
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return results;
}

/** Fetch all block children for a page (one level deep — avoids deep recursion). */
async function fetchPageBlocks(token, pageId) {
  try {
    const data = await notionFetch(token, `/blocks/${pageId}/children?page_size=100`);
    return data.results || [];
  } catch {
    return [];
  }
}

// ─── Content extraction ───────────────────────────────────────────────────

/** Extract plain text from a rich_text array. */
function richTextToString(richText) {
  if (!Array.isArray(richText)) return '';
  return richText.map(r => r.plain_text || '').join('');
}

/** Extract readable text from a block object. */
function blockToText(block) {
  const type = block.type;
  const content = block[type];
  if (!content) return '';

  // Blocks that have rich_text
  const textBlocks = ['paragraph','heading_1','heading_2','heading_3','bulleted_list_item',
                      'numbered_list_item','toggle','quote','callout','code'];
  if (textBlocks.includes(type)) {
    return richTextToString(content.rich_text || []);
  }
  if (type === 'to_do') {
    const checked = content.checked ? '[x]' : '[ ]';
    return `${checked} ${richTextToString(content.rich_text || [])}`;
  }
  if (type === 'divider') return '---';
  if (type === 'child_page') return `[child page: ${content.title || ''}]`;
  if (type === 'child_database') return `[child database: ${content.title || ''}]`;
  return '';
}

/** Convert blocks to plain text, capped at maxChars. */
function blocksToText(blocks, maxChars = 3000) {
  const lines = blocks.map(blockToText).filter(Boolean);
  return lines.join('\n').slice(0, maxChars);
}

/** Extract a title from a Notion page object. */
function pageTitle(page) {
  // Database pages have properties; standalone pages have a title property
  if (page.properties) {
    for (const [key, prop] of Object.entries(page.properties)) {
      if (prop.type === 'title') {
        return richTextToString(prop.title || []) || key;
      }
    }
  }
  // Fallback to page.title (standalone)
  return page.title ? richTextToString(page.title) : '(untitled)';
}

/**
 * Estimate importance for a Notion item.
 * Databases tend to be more structured/important than random pages.
 */
function estimateImportance(type, textLength) {
  if (type === 'database') return 0.7;
  if (textLength > 1000) return 0.6;
  if (textLength > 300)  return 0.5;
  return 0.35;
}

/** Convert a database row's properties to a readable string. */
function dbRowToText(row) {
  const parts = [];
  for (const [key, prop] of Object.entries(row.properties || {})) {
    let value = '';
    switch (prop.type) {
      case 'title':       value = richTextToString(prop.title   || []); break;
      case 'rich_text':   value = richTextToString(prop.rich_text || []); break;
      case 'number':      value = prop.number != null ? String(prop.number) : ''; break;
      case 'select':      value = prop.select?.name || ''; break;
      case 'multi_select':value = (prop.multi_select || []).map(s => s.name).join(', '); break;
      case 'status':      value = prop.status?.name || ''; break;
      case 'checkbox':    value = prop.checkbox ? 'true' : 'false'; break;
      case 'date':        value = prop.date?.start || ''; break;
      case 'url':         value = prop.url || ''; break;
      case 'email':       value = prop.email || ''; break;
      case 'phone_number':value = prop.phone_number || ''; break;
      case 'formula':     value = prop.formula?.string || String(prop.formula?.number ?? ''); break;
      case 'relation':    value = `[${(prop.relation || []).length} linked items]`; break;
      default:            value = '';
    }
    if (value) parts.push(`${key}: ${value}`);
  }
  return parts.join('\n');
}

// ─── Import logic ─────────────────────────────────────────────────────────

/**
 * Ensure import_sources table exists and return a lookup function.
 * Returns a Set of already-imported notion page/db IDs.
 */
function getImportedIds(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS import_sources (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      source      TEXT NOT NULL,
      path        TEXT NOT NULL,
      last_hash   TEXT,
      imported_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  const rows = db.prepare("SELECT path FROM import_sources WHERE source = 'notion'").all();
  return new Set(rows.map(r => r.path));
}

function markImported(db, notionId) {
  const existing = db.prepare("SELECT id FROM import_sources WHERE source='notion' AND path=?").get(notionId);
  if (existing) {
    db.prepare("UPDATE import_sources SET imported_at=datetime('now') WHERE source='notion' AND path=?").run(notionId);
  } else {
    db.prepare("INSERT INTO import_sources (source, path) VALUES ('notion', ?)").run(notionId);
  }
}

/**
 * Main entry point: import all Notion pages and databases accessible via token.
 *
 * @param {string} token          Notion integration token
 * @param {object} opts
 * @param {boolean} [opts.skipAi]         Skip AI compression (faster)
 * @param {boolean} [opts.databaseOnly]   Only import database rows
 * @param {boolean} [opts.pagesOnly]      Only import standalone pages
 * @param {string}  [opts.project]        Project label for observations (defaults to 'notion')
 * @param {function} [opts.onProgress]    Progress callback (count, total)
 * @returns {{ imported: number, skipped: number, errors: number }}
 */
export async function importNotion(token, opts = {}) {
  const { skipAi = false, databaseOnly = false, pagesOnly = false, project = 'notion', onProgress } = opts;

  const db    = getDb();
  const done  = getImportedIds(db);

  const sessionId = `import-notion-${Date.now()}`;
  upsertSession(sessionId, project);

  let imported = 0, skipped = 0, errors = 0;

  // Search for all accessible pages and databases
  let allItems;
  try {
    allItems = await paginateNotion(token, '/search', { page_size: 100 });
  } catch (err) {
    closeSession(sessionId, `Notion import failed: ${err.message}`, { computeFriction: computeFrictionScore });
    throw err;
  }

  const pages     = allItems.filter(i => i.object === 'page'     && !databaseOnly);
  const databases = allItems.filter(i => i.object === 'database' && !pagesOnly);

  const total = pages.length + databases.length;

  // ── Import standalone pages ──────────────────────────────────────────
  for (const page of pages) {
    const id = page.id;

    if (done.has(id)) {
      skipped++;
      onProgress?.({ done: imported + skipped, total, current: 'skip:' + id });
      continue;
    }

    try {
      const title   = pageTitle(page);
      const blocks  = await fetchPageBlocks(token, id);
      const text    = blocksToText(blocks);
      const content = text ? `${title}\n\n${text}` : title;
      const importance = estimateImportance('page', text.length);

      let summary = content.slice(0, 300);
      let tags    = ['notion', 'import', 'page'];

      if (!skipAi && content.length > 200) {
        try {
          const compressed = await compress({
            tool: 'notion-page',
            input: title,
            output: content,
            project,
          });
          if (compressed) {
            summary = compressed.summary || summary;
            tags    = [...tags, ...(compressed.tags || [])];
          }
        } catch { /* use fallback */ }
      }

      const obsId = saveObservation({
        sessionId,
        project,
        tool: 'notion-page',
        summary,
        rawInput:  title,
        rawOutput: content.slice(0, 2000),
        tags,
        importance,
      });

      try {
        const meta = await embedWithMeta(summary);
        if (meta?.vector) saveEmbedding(obsId, meta.vector, meta.model);
      } catch {}
      try { addObservationToGraph({ id: obsId, project, tool: 'notion-page', summary, tags: JSON.stringify(tags), importance, decision_rationale: null, raw_input: title }); } catch { /* non-critical */ }

      markImported(db, id);
      imported++;
    } catch (err) {
      console.error(`[notion:import] page ${id} failed: ${err.message}`);
      errors++;
    }

    onProgress?.({ done: imported + skipped + errors, total, current: id });
  }

  // ── Import database rows ─────────────────────────────────────────────
  for (const database of databases) {
    const dbId    = database.id;
    const dbTitle = richTextToString(database.title || []) || '(untitled database)';

    try {
      const rows = await paginateNotion(token, `/databases/${dbId}/query`, { page_size: 100 });

      for (const row of rows) {
        const rowId = row.id;

        if (done.has(rowId)) {
          skipped++;
          continue;
        }

        try {
          const rowText   = dbRowToText(row);
          const rowTitle  = pageTitle(row) || '(untitled row)';
          const content   = `[Database: ${dbTitle}]\n${rowTitle}\n\n${rowText}`;
          const importance = estimateImportance('database', rowText.length);

          let summary = `[${dbTitle}] ${rowTitle}: ${rowText.slice(0, 150)}`;
          let tags    = ['notion', 'import', 'database'];

          if (!skipAi && rowText.length > 100) {
            try {
              const compressed = await compress({
                tool: 'notion-database-row',
                input: `${dbTitle} / ${rowTitle}`,
                output: rowText,
                project,
              });
              if (compressed) {
                summary = compressed.summary || summary;
                tags    = [...tags, ...(compressed.tags || [])];
              }
            } catch { /* use fallback */ }
          }

          const obsId = saveObservation({
            sessionId,
            project,
            tool:      'notion-database-row',
            summary,
            rawInput:  `${dbTitle} / ${rowTitle}`,
            rawOutput: rowText.slice(0, 2000),
            tags,
            importance,
          });

          try {
            const meta = await embedWithMeta(summary);
            if (meta?.vector) saveEmbedding(obsId, meta.vector, meta.model);
          } catch {}
          try { addObservationToGraph({ id: obsId, project, tool: 'notion-database-row', summary, tags: JSON.stringify(tags), importance, decision_rationale: null, raw_input: null }); } catch { /* non-critical */ }

          markImported(db, rowId);
          imported++;
        } catch (err) {
          console.error(`[notion:import] row ${rowId} failed: ${err.message}`);
          errors++;
        }

        onProgress?.({ done: imported + skipped + errors, total, current: rowId });
      }
    } catch (err) {
      console.error(`[notion:import] database ${dbId} failed: ${err.message}`);
      errors++;
    }
  }

  const summary = `Notion import: ${imported} items from ${total} accessible (${skipped} skipped, ${errors} errors)`;
  closeSession(sessionId, summary, { computeFriction: computeFrictionScore });

  return { imported, skipped, errors, total };
}
