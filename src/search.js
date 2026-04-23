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

import { ftsSearch, getObservationsWithEmbeddings, getRecentObservations, getDb } from './db.js';
import { embed, cosineSimilarity, bufToFloat32 } from './embeddings.js';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const RRF_K = 60;

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
    // Decision boost (#25): observations with decisions are high-value context
    const tags = JSON.parse(entry.obs.tags || '[]');
    if (tags.includes('decision')) {
      entry.score *= 1.5;
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

  // 2. Cross-project: bring experience from other projects
  const crossResults = await hybridSearch(userPrompt, null, { limit: 4, ...opts });

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

async function runVectorSearch(query, project) {
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
    return results;
  } catch (err) {
    console.error('[mem:vector] search failed:', err.message);
    return [];
  }
}
