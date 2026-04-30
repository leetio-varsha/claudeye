/**
 * src/agent.js — Agent v1 (#20)
 *
 * Первый агент Claudeye. ОДИН pipeline: читает контекст из mem.db,
 * выполняет действие, сохраняет результат обратно в agent_actions.
 *
 * Поддерживаемые use-cases:
 *   cross-repo-context  — поиск по всем проектам, группировка по проектам
 *   pr-review           — git diff → Claudeye context → советы по ревью
 *
 * Философия: агент = mem.db read → action → mem.db write (feedback loop).
 * Все запросы логируются в agent_actions для дальнейшего анализа паттернов.
 */

import { spawnSync } from 'child_process';
import { getDb } from './db.js';
import { hybridSearch } from './search.js';

const HOME = process.env.HOME || '';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function shortPath(p) {
  return p ? p.replace(HOME, '~') : '(unknown)';
}

/**
 * Log an agent action to agent_actions table for feedback loop.
 */
export function logAgentAction({ agent, query, project, result, dryRun = false }) {
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO agent_actions (agent, query, project, result, dry_run)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      agent,
      query ?? null,
      project ?? null,
      result != null ? JSON.stringify(result) : null,
      dryRun ? 1 : 0,
    );
  } catch {
    // Non-critical — don't crash the agent if logging fails
  }
}

/**
 * Get recent agent actions for display or analysis.
 */
export function getAgentHistory({ agent, limit = 20 } = {}) {
  const db = getDb();
  const where = agent ? 'WHERE agent = ?' : '';
  const args  = agent ? [agent] : [];
  return db.prepare(`
    SELECT id, agent, query, project, result, dry_run, created_at
    FROM agent_actions
    ${where}
    ORDER BY created_at DESC
    LIMIT ?
  `).all(...args, limit);
}

// ─── Agent: cross-repo-context ────────────────────────────────────────────────

/**
 * Cross-repo context agent.
 *
 * Searches ALL projects (project=null) for query, groups by project,
 * returns formatted results. Filters out low-relevance noise.
 *
 * @param {string} query
 * @param {object} opts
 * @param {string}  opts.project  — current project (used for logging only)
 * @param {number}  opts.limit    — max total results (default 15)
 * @param {boolean} opts.dryRun   — if true, skip logging
 * @returns {Promise<CrossRepoResult>}
 */
export async function crossRepoContext(query, {
  project = null,
  limit   = 15,
  dryRun  = false,
} = {}) {
  const results = await hybridSearch(query, null, { limit });

  // Group by project
  const byProject = new Map();
  for (const obs of results) {
    const proj = obs.project || '(unknown)';
    if (!byProject.has(proj)) byProject.set(proj, []);
    byProject.get(proj).push(obs);
  }

  // Build sorted project list (by best score in project)
  const projects = [...byProject.entries()]
    .map(([proj, items]) => ({
      project: proj,
      shortProject: shortPath(proj),
      items: items.sort((a, b) => b.hybridScore - a.hybridScore),
      topScore: items[0]?.hybridScore ?? 0,
    }))
    .sort((a, b) => b.topScore - a.topScore);

  const result = {
    query,
    totalResults: results.length,
    projects: projects.map(p => ({
      project: p.project,
      shortProject: p.shortProject,
      count: p.items.length,
    })),
  };

  if (!dryRun) {
    logAgentAction({ agent: 'cross-repo-context', query, project, result, dryRun });
  }

  return { query, results, projects, totalResults: results.length };
}

// ─── Agent: pr-review ─────────────────────────────────────────────────────────

/**
 * PR review context agent.
 *
 * Reads git diff from current project, searches Claudeye memory for:
 *   - past decisions related to changed files/patterns
 *   - similar fixes or hotspots
 *   - relevant cross-project experience
 *
 * Returns context that would be useful for reviewing this PR.
 *
 * @param {object} opts
 * @param {string}  opts.project  — git repo path (default: cwd)
 * @param {string}  opts.diff     — pre-supplied diff string (skips git call)
 * @param {number}  opts.limit    — max context observations (default 10)
 * @param {boolean} opts.dryRun   — if true, skip logging
 * @returns {Promise<PrReviewResult>}
 */
export async function prReview({
  project = process.cwd(),
  diff    = null,
  limit   = 10,
  dryRun  = false,
} = {}) {
  // Get git diff if not supplied
  let diffText = diff;
  if (!diffText) {
    const gitResult = spawnSync('git', ['diff', '--stat', 'HEAD~1', 'HEAD'], {
      cwd: project,
      encoding: 'utf8',
    });
    if (gitResult.error || gitResult.status !== 0) {
      // Fallback: staged changes
      const staged = spawnSync('git', ['diff', '--stat', '--cached'], {
        cwd: project,
        encoding: 'utf8',
      });
      diffText = staged.stdout || '';
    } else {
      diffText = gitResult.stdout || '';
    }
  }

  // Extract file names from diff stat for a focused query
  const changedFiles = diffText
    .split('\n')
    .filter(line => line.includes('|') || line.match(/\.(js|ts|py|go|rs|md)$/))
    .map(line => line.trim().split(/\s+/)[0])
    .filter(Boolean)
    .slice(0, 5);

  const query = changedFiles.length > 0
    ? `changes to ${changedFiles.join(', ')}`
    : 'recent code changes review';

  // Search current project for relevant context
  const [projectResults, crossResults] = await Promise.all([
    hybridSearch(query, project, { limit: Math.ceil(limit * 0.7) }),
    hybridSearch(query, null,    { limit: Math.ceil(limit * 0.3) }),
  ]);

  // Dedup cross results
  const seenIds = new Set(projectResults.map(o => o.id));
  const dedupedCross = crossResults
    .filter(o => !seenIds.has(o.id) && o.project !== project)
    .slice(0, 3);

  // Extract key decisions and high-importance observations
  const decisions = projectResults
    .filter(o => {
      const tags = JSON.parse(o.tags || '[]');
      return tags.includes('decision') || o.importance >= 0.8;
    });

  const result = {
    changedFiles,
    query,
    projectContextCount: projectResults.length,
    crossContextCount: dedupedCross.length,
    decisionsFound: decisions.length,
    diffStat: diffText.split('\n').slice(-3).join(' ').trim(),
  };

  if (!dryRun) {
    logAgentAction({ agent: 'pr-review', query, project, result, dryRun });
  }

  return {
    query,
    diffText,
    changedFiles,
    projectResults,
    crossResults: dedupedCross,
    decisions,
  };
}
