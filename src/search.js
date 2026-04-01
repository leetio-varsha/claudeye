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

import { ftsSearch, getObservationsWithEmbeddings, getRecentObservations } from './db.js';
import { embed, cosineSimilarity, bufToFloat32 } from './embeddings.js';

const RRF_K = 60;

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
  limit        = 8,
  ftsWeight    = 0.4,
  vectorWeight = 0.6,
} = {}) {

  // Run FTS and vector search in parallel
  const [ftsResults, vectorResults] = await Promise.all([
    runFTS(query, project),
    runVectorSearch(query, project),
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
  }

  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ obs, score }) => ({ ...obs, hybridScore: score }));
}

/**
 * Build the context string to inject into Claude Code.
 * Combines recent observations + hybrid search results.
 */
export async function buildContext(userPrompt, project, opts = {}) {
  // 1. Project-specific: recent + hybrid search
  const [recent, searched] = await Promise.all([
    getRecentObservations(project, 3),
    hybridSearch(userPrompt, project, { limit: 6, ...opts }),
  ]);

  // 2. Cross-project: bring experience from other projects
  const crossResults = await hybridSearch(userPrompt, null, { limit: 4, ...opts });

  // Dedup
  const seenIds = new Set([...recent.map(o => o.id), ...searched.map(o => o.id)]);
  const dedupedSearch = searched.filter(o => !new Set(recent.map(r => r.id)).has(o.id));
  const crossFiltered = crossResults
    .filter(o => !seenIds.has(o.id) && o.project !== project && o.hybridScore >= MIN_CROSS_PROJECT_SCORE)
    .slice(0, 3);

  const lines = [];

  if (recent.length) {
    lines.push('## Recent session context');
    for (const obs of recent) {
      lines.push(`- ${obs.summary}`);
    }
  }

  if (dedupedSearch.length) {
    lines.push('\n## Relevant past context');
    for (const obs of dedupedSearch) {
      const tags = JSON.parse(obs.tags || '[]').join(', ');
      lines.push(`- ${obs.summary}${tags ? ` [${tags}]` : ''}`);
    }
  }

  if (crossFiltered.length) {
    lines.push('\n## Cross-project context (reference only — verify before applying)');
    for (const obs of crossFiltered) {
      const projName = obs.project?.split('/').pop() || 'unknown';
      const tags = JSON.parse(obs.tags || '[]').join(', ');
      lines.push(`- [${projName}] ${obs.summary}${tags ? ` [${tags}]` : ''}`);
    }
  }

  if (!lines.length) return null;

  return [
    '<!-- claude-mem: injected context — do not edit -->',
    ...lines,
    '<!-- end claude-mem context -->',
  ].join('\n');
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

async function runVectorSearch(query, project) {
  try {
    const queryVec = await embed(query);
    const rows     = getObservationsWithEmbeddings(project, 300);

    return rows
      .map(row => {
        const vec = bufToFloat32(row.vector);
        const sim = cosineSimilarity(queryVec, vec);
        return { ...row, vectorScore: sim };
      })
      .sort((a, b) => b.vectorScore - a.vectorScore)
      .slice(0, 30);
  } catch (err) {
    console.error('[mem:vector] search failed:', err.message);
    return [];
  }
}
