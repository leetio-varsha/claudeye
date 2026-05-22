/**
 * search.js — Hybrid FTS5 + vector search with Reciprocal Rank Fusion
 *
 * Strategy:
 *   1. FTS5 search → ranked list of observation IDs
 *   2. Vector cosine similarity → ranked list of observation IDs
 *   3. RRF fusion → merge both ranked lists into a final score
 *   4. Return top-K deduped results
 *
 * RRF score = Σ 1 / (k + rank_i)  where k=60 (standard)
 */

import Database from 'better-sqlite3';
import { ftsSearch, getObservationsWithEmbeddings, getRecentObservations, getDb, ARCHIVE_PATH } from './db.js';
import { embed, cosineSimilarity, bufToFloat32 } from './embeddings.js';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const RRF_K = 60;

// Archive fallback: if hot DB returns fewer than this many results, also search archive.db.
// Keeps historical context accessible without paying the archive cost on every query.
const ARCHIVE_FALLBACK_MIN = 3;

// ─── Token budget (#90) ──────────────────────────────────────────────────
//
// inject-hook prepends context to every user prompt, so any bloat here is
// silently amortized over hundreds of prompts per session. Budget caps the
// total injection size so we don't balloon context on prompts that happen
// to hit a project with many high-importance decisions + a handoff + an
// advise all at once.
//
// The gate drops lowest-priority sections first (cross-project, then low-
// scoring searched hits), never dropping decisions or recent below a floor.

const DEFAULT_INJECT_BUDGET_TOKENS = 1000;   // ≈ 4KB total
const TOKEN_TO_BYTES = 4;                    // rough; keeps the math boring
// Section floors — we will never trim below these even under budget pressure.
const SECTION_FLOOR = {
  decisions: 2,
  recent:    2,
  searched:  3,
  cross:     0,  // cross-project is purely optional
};

function readInjectBudgetTokens() {
  const env = parseInt(process.env.CLAUDEYE_INJECT_BUDGET_TOKENS, 10);
  if (Number.isFinite(env) && env > 0) return env;
  try {
    const p = join(homedir(), '.claudeye', 'settings.json');
    if (!existsSync(p)) return DEFAULT_INJECT_BUDGET_TOKENS;
    const cfg = JSON.parse(readFileSync(p, 'utf8'));
    const v = parseInt(cfg.inject_budget_tokens ?? cfg.injectBudgetTokens, 10);
    return Number.isFinite(v) && v > 0 ? v : DEFAULT_INJECT_BUDGET_TOKENS;
  } catch { return DEFAULT_INJECT_BUDGET_TOKENS; }
}

/**
 * Normalize worktree paths to parent project (#78).
 * `.claude/worktrees/<name>` → parent project path.
 * This ensures worktree sessions get context from the main project.
 */
export function normalizeProject(project) {
  if (!project) return project;
  const worktreeMatch = project.match(/^(.+?)\/\.claude\/worktrees\/.+$/);
  return worktreeMatch ? worktreeMatch[1] : project;
}

// Minimum hybrid score for cross-project results to be shown.
// Prevents low-relevance noise from unrelated projects.
const MIN_CROSS_PROJECT_SCORE = 0.004;

// Source-aware demotion: git-commit observations are 73% of the DB
// but are less useful than real hook observations for context injection.
// Apply a multiplier to their RRF score so they don't crowd out hook data.
const GIT_COMMIT_DEMOTION = 0.3;

/**
 * Main hybrid search entry point.
 *
 * @param {string} query      — natural language query (usually the user's prompt)
 * @param {string} project    — current working directory / project path
 * @param {object} opts
 * @param {number} opts.limit — max results to return (default 8)
 * @param {number} opts.ftsWeight    — weight for FTS rank (default 0.4)
 * @param {number} opts.vectorWeight — weight for vector rank (default 0.6)
 * @returns {Promise<Array>}  — sorted observations with hybrid scores
 */
export async function hybridSearch(query, project, {
  limit           = 8,
  ftsWeight       = 0.4,
  vectorWeight    = 0.6,
  archiveFallback = true,  // #30 Etap 2: fallback to archive.db when hot has few results
} = {}) {

  // Run FTS and vector search in parallel.
  // runVectorSearchWithVec returns {results, queryVec} so we can reuse the embedding
  // for archive fallback without a second API call.
  const [ftsResults, { results: vectorResults, queryVec }] = await Promise.all([
    runFTS(query, project),
    runVectorSearchWithVec(query, project),
  ]);

  // Build RRF score map: id → score
  const scores = new Map();

  ftsResults.forEach((obs, rank) => {
    const id = obs.id;
    const prev = scores.get(id) || { obs, score: 0 };
    prev.score += ftsWeight * (1 / (RRF_K + rank + 1));
    scores.set(id, prev);
  });

  vectorResults.forEach((obs, rank) => {
    const id = obs.id;
    const prev = scores.get(id) || { obs, score: 0 };
    prev.score += vectorWeight * (1 / (RRF_K + rank + 1));
    // Boost by importance
    prev.score *= (0.5 + obs.importance * 0.5);
    scores.set(id, prev);
  });

  // Apply source-aware demotion: git-commit data is bulk-imported and
  // less relevant than real-time hook observations for context injection
  for (const entry of scores.values()) {
    if (entry.obs.tool === 'git-commit') {
      entry.score *= GIT_COMMIT_DEMOTION;
    }
    // Decision boost (#25): observations with decisions are high-value context
    const tags = JSON.parse(entry.obs.tags || '[]');
    if (tags.includes('decision')) {
      entry.score *= 1.5;
    }
  }

  const hotResults = [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ obs, score }) => ({ ...obs, hybridScore: score }));

  // #30 Etap 2: archive fallback — search archive.db when hot DB has few results.
  // Triggered only when archive.db exists and hot results fall below ARCHIVE_FALLBACK_MIN.
  // Uses the already-computed queryVec to avoid a second embed() API call.
  if (archiveFallback && hotResults.length < ARCHIVE_FALLBACK_MIN && queryVec) {
    const remaining = limit - hotResults.length;
    const archiveResults = await runArchiveHybrid(query, project, queryVec, remaining, {
      ftsWeight,
      vectorWeight,
    });
    const hotIds = new Set(hotResults.map(o => o.id));
    const freshArchive = archiveResults.filter(o => !hotIds.has(o.id));
    return [...hotResults, ...freshArchive].slice(0, limit);
  }

  return hotResults;
}

/**
 * Build the context string to inject into Claude Code.
 * Combines recent observations + hybrid search results.
 *
 * Backwards-compatible wrapper around buildContextWithMetrics (#90).
 */
export async function buildContext(userPrompt, project, opts = {}) {
  const { text } = await buildContextWithMetrics(userPrompt, project, opts);
  return text;
}

/**
 * Full version: returns the injected text plus a metrics object describing
 * size and per-section breakdown, so inject-hook can record it in
 * injection_stats (#90).
 *
 * @returns {{
 *   text: string|null,
 *   bytes: number,
 *   tokensEst: number,
 *   sections: Array<{ name, count, bytes }>,
 *   budgetHit: boolean,
 *   budgetTokens: number,
 * }}
 */
export async function buildContextWithMetrics(userPrompt, project, opts = {}) {
  // Normalize worktree paths so worktrees get context from parent project (#78)
  const normalizedProject = normalizeProject(project);

  // 1. Project-specific: recent + hybrid search
  const [recent, searched] = await Promise.all([
    getRecentObservations(normalizedProject, 3),
    hybridSearch(userPrompt, normalizedProject, { limit: 6, ...opts }),
  ]);

  // 2. Cross-project: bring experience from other projects.
  // archiveFallback=false: cross-project archive search would be too broad and slow.
  const crossResults = await hybridSearch(userPrompt, null, { limit: 4, archiveFallback: false, ...opts });

  // Dedup
  const seenIds = new Set([...recent.map(o => o.id), ...searched.map(o => o.id)]);
  const dedupedSearch = searched.filter(o => !new Set(recent.map(r => r.id)).has(o.id));
  const crossFiltered = crossResults
    .filter(o => !seenIds.has(o.id) && o.project !== project && o.hybridScore >= MIN_CROSS_PROJECT_SCORE)
    .slice(0, 3);

  // 3. Fetch recent decisions for this project (#25 Decision Memory)
  let decisions = [];
  try {
    decisions = getDb().prepare(`
      SELECT summary, decision_rationale, created_at
      FROM observations
      WHERE project = ? AND decision_rationale IS NOT NULL
      ORDER BY importance DESC, created_at DESC
      LIMIT 5
    `).all(project);
  } catch { /* decision_rationale column may not exist yet */ }

  // Build per-section line arrays so the budget gate can trim them later.
  const sections = [
    {
      name:   'decisions',
      header: '## Key decisions (project context)',
      lines:  decisions.map(d => `- ${d.decision_rationale}`),
    },
    {
      name:   'recent',
      header: '## Recent session context',
      lines:  recent.map(o => `- ${o.summary}`),
    },
    {
      name:   'searched',
      header: '## Relevant past context',
      lines:  dedupedSearch.map(obs => {
        const tags = JSON.parse(obs.tags || '[]').join(', ');
        return `- ${obs.summary}${tags ? ` [${tags}]` : ''}`;
      }),
    },
    {
      name:   'cross',
      header: '## Cross-project context (reference only — verify before applying)',
      lines:  crossFiltered.map(obs => {
        const projName = obs.project?.split('/').pop() || 'unknown';
        const tags = JSON.parse(obs.tags || '[]').join(', ');
        return `- [${projName}] ${obs.summary}${tags ? ` [${tags}]` : ''}`;
      }),
    },
  ];

  const budgetTokens = readInjectBudgetTokens();
  const { budgetHit } = applyInjectBudget(sections, budgetTokens);

  const used = sections.filter(s => s.lines.length > 0);
  if (!used.length) {
    return { text: null, bytes: 0, tokensEst: 0, sections: [], budgetHit: false, budgetTokens };
  }

  const bodyLines = [];
  used.forEach((s, i) => {
    if (i > 0) bodyLines.push('');
    bodyLines.push(s.header);
    bodyLines.push(...s.lines);
  });

  const text = [
    '<!-- claude-mem: injected context — do not edit -->',
    ...bodyLines,
    '<!-- end claude-mem context -->',
  ].join('\n');

  const bytes = Buffer.byteLength(text, 'utf8');
  const tokensEst = Math.ceil(bytes / TOKEN_TO_BYTES);

  const metricsSections = sections.map(s => ({
    name:  s.name,
    count: s.lines.length,
    bytes: s.lines.reduce((n, l) => n + Buffer.byteLength(l, 'utf8') + 1, 0),
  }));

  return { text, bytes, tokensEst, sections: metricsSections, budgetHit, budgetTokens };
}

/**
 * Drop lines from least-important sections until the projected injection size
 * fits under the token budget. Mutates `sections` in place.
 */
function applyInjectBudget(sections, budgetTokens) {
  const byteBudget = budgetTokens * TOKEN_TO_BYTES;
  let budgetHit = false;

  const currentBytes = () => {
    let n = 0;
    for (const s of sections) {
      if (!s.lines.length) continue;
      n += Buffer.byteLength(s.header, 'utf8') + 1;
      for (const l of s.lines) n += Buffer.byteLength(l, 'utf8') + 1;
    }
    return n;
  };

  if (currentBytes() <= byteBudget) return { budgetHit: false };
  budgetHit = true;

  // Trim from lowest-priority to highest, respecting per-section floor.
  const order = ['cross', 'searched', 'recent', 'decisions'];
  for (const name of order) {
    const s = sections.find(x => x.name === name);
    if (!s) continue;
    const floor = SECTION_FLOOR[name] ?? 0;
    while (s.lines.length > floor && currentBytes() > byteBudget) {
      s.lines.pop();
    }
    if (currentBytes() <= byteBudget) break;
  }

  return { budgetHit };
}

// ─── Internal ─────────────────────────────────────────────────────────────

async function runFTS(query, project) {
  try {
    return ftsSearch(query, project, 20);
  } catch (err) {
    console.error('[mem:fts] search failed:', err.message);
    return [];
  }
}

/**
 * Run vector search against hot DB.
 * Returns { results, queryVec } so callers can reuse the embedding for archive fallback.
 */
async function runVectorSearchWithVec(query, project) {
  try {
    const queryVec = await embed(query);
    const rows     = getObservationsWithEmbeddings(project, 300);

    let dimMismatchCount = 0;
    const results = rows
      .map(row => {
        const vec = bufToFloat32(row.vector);
        if (queryVec.length !== vec.length) { dimMismatchCount++; return null; }
        const sim = cosineSimilarity(queryVec, vec);
        return { ...row, vectorScore: sim };
      })
      .filter(Boolean)
      .sort((a, b) => b.vectorScore - a.vectorScore)
      .slice(0, 30);

    if (dimMismatchCount > 0) {
      console.error(`[mem:vector] ${dimMismatchCount}/${rows.length} embeddings skipped (dimension mismatch) — run 'claudeye reindex'`);
    }
    return { results, queryVec };
  } catch (err) {
    console.error('[mem:vector] search failed:', err.message);
    return { results: [], queryVec: null };
  }
}

// ─── Archive fallback (#30 Etap 2) ───────────────────────────────────────────

/**
 * Open archive.db read-only. Returns null if archive doesn't exist or fails to open.
 */
function openArchiveDb() {
  if (!existsSync(ARCHIVE_PATH)) return null;
  try {
    return new Database(ARCHIVE_PATH, { readonly: true });
  } catch {
    return null;
  }
}

/**
 * Run FTS5 search on an arbitrary SQLite db instance.
 */
function _ftsOnDb(db, query, project, limit = 20) {
  const safe = query.replace(/[^\w\s]/g, ' ').trim();
  if (!safe) return [];
  const ftsQuery = safe.split(/\s+/).filter(Boolean).join(' OR ');
  try {
    if (project) {
      return db.prepare(`
        SELECT o.id, o.summary, o.tool, o.tags, o.importance, o.decision_rationale, o.created_at, o.project,
               bm25(fts_obs) AS fts_score
        FROM fts_obs
        JOIN observations o ON o.id = fts_obs.rowid
        WHERE fts_obs MATCH ? AND o.project = ?
        ORDER BY fts_score LIMIT ?
      `).all(ftsQuery, project, limit);
    }
    return db.prepare(`
      SELECT o.id, o.summary, o.tool, o.tags, o.importance, o.decision_rationale, o.created_at, o.project,
             bm25(fts_obs) AS fts_score
      FROM fts_obs
      JOIN observations o ON o.id = fts_obs.rowid
      WHERE fts_obs MATCH ?
      ORDER BY fts_score LIMIT ?
    `).all(ftsQuery, limit);
  } catch {
    return [];
  }
}

/**
 * Run vector similarity search on an arbitrary SQLite db instance.
 * Uses a pre-computed queryVec (Float32Array) — no extra embed() call.
 */
function _vectorOnDb(db, queryVec, project, limit = 300) {
  try {
    let rows;
    if (project) {
      rows = db.prepare(`
        SELECT o.id, o.summary, o.tool, o.tags, o.importance, o.decision_rationale, o.created_at, o.project, e.vector
        FROM observations o JOIN embeddings e ON e.observation_id = o.id
        WHERE o.project = ?
        ORDER BY o.created_at DESC LIMIT ?
      `).all(project, limit);
    } else {
      rows = db.prepare(`
        SELECT o.id, o.summary, o.tool, o.tags, o.importance, o.decision_rationale, o.created_at, o.project, e.vector
        FROM observations o JOIN embeddings e ON e.observation_id = o.id
        ORDER BY o.created_at DESC LIMIT ?
      `).all(limit);
    }
    return rows
      .map(row => {
        const vec = bufToFloat32(row.vector);
        if (queryVec.length !== vec.length) return null;
        return { ...row, vectorScore: cosineSimilarity(queryVec, vec) };
      })
      .filter(Boolean)
      .sort((a, b) => b.vectorScore - a.vectorScore)
      .slice(0, 30);
  } catch {
    return [];
  }
}

/**
 * Hybrid search against archive.db using a pre-computed query embedding.
 * Results are tagged with fromArchive: true so callers can optionally label them.
 *
 * @param {string}     query     — original query string (for FTS)
 * @param {string}     project   — project path (or null for cross-project)
 * @param {Float32Array} queryVec — pre-computed embedding from hot DB search
 * @param {number}     limit     — max results to return
 * @param {object}     opts      — ftsWeight, vectorWeight
 */
async function runArchiveHybrid(query, project, queryVec, limit, {
  ftsWeight    = 0.4,
  vectorWeight = 0.6,
} = {}) {
  const archiveDb = openArchiveDb();
  if (!archiveDb) return [];

  try {
    const ftsResults    = _ftsOnDb(archiveDb, query, project, 20);
    const vectorResults = _vectorOnDb(archiveDb, queryVec, project, 300);

    const scores = new Map();

    ftsResults.forEach((obs, rank) => {
      const key  = `a_${obs.id}`;
      const prev = scores.get(key) || { obs: { ...obs, fromArchive: true }, score: 0 };
      prev.score += ftsWeight * (1 / (RRF_K + rank + 1));
      scores.set(key, prev);
    });

    vectorResults.forEach((obs, rank) => {
      const key  = `a_${obs.id}`;
      const prev = scores.get(key) || { obs: { ...obs, fromArchive: true }, score: 0 };
      prev.score += vectorWeight * (1 / (RRF_K + rank + 1));
      prev.score *= (0.5 + obs.importance * 0.5);
      scores.set(key, prev);
    });

    // Apply same demotion/boost as hot search
    for (const entry of scores.values()) {
      if (entry.obs.tool === 'git-commit') entry.score *= GIT_COMMIT_DEMOTION;
      const tags = JSON.parse(entry.obs.tags || '[]');
      if (tags.includes('decision')) entry.score *= 1.5;
    }

    return [...scores.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ obs, score }) => ({ ...obs, hybridScore: score }));
  } finally {
    archiveDb.close();
  }
}
