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
    SELECT id, agent, query, project, result, dry_run,
           feedback, feedback_at, feedback_note, created_at
    FROM agent_actions
    ${where}
    ORDER BY created_at DESC
    LIMIT ?
  `).all(...args, limit);
}

// ─── Feedback loop (#21) ──────────────────────────────────────────────────────

const FEEDBACK_VALUES = new Set(['accepted', 'rejected']);

/**
 * Record accept/reject feedback on an agent action (#21).
 * This is the signal the feedback loop learns from: which agent actions the
 * user found useful (accepted) vs. noise (rejected).
 *
 * @param {number} id                 — agent_actions.id
 * @param {'accepted'|'rejected'} feedback
 * @param {string} [note]             — optional reason
 * @returns {{ ok: boolean, id: number, feedback?: string, error?: string }}
 */
export function setActionFeedback(id, feedback, note = null) {
  if (!FEEDBACK_VALUES.has(feedback)) {
    return { ok: false, id, error: `feedback must be 'accepted' or 'rejected' (got '${feedback}')` };
  }
  const db = getDb();
  const row = db.prepare('SELECT id FROM agent_actions WHERE id = ?').get(id);
  if (!row) return { ok: false, id, error: `agent_action #${id} not found` };

  db.prepare(`
    UPDATE agent_actions
    SET feedback = ?, feedback_at = ?, feedback_note = ?
    WHERE id = ?
  `).run(feedback, new Date().toISOString(), note ?? null, id);

  return { ok: true, id, feedback };
}

/**
 * Get agent actions still awaiting feedback (feedback IS NULL).
 * Pending = the queue the user reviews to accept/reject.
 *
 * @param {object} [opts]
 * @param {string}  [opts.agent]  — filter by agent name
 * @param {number}  [opts.limit]  — default 20
 * @returns {object[]}
 */
export function getPendingActions({ agent, limit = 20 } = {}) {
  const db = getDb();
  const where = ['feedback IS NULL'];
  const args  = [];
  if (agent) { where.push('agent = ?'); args.push(agent); }
  return db.prepare(`
    SELECT id, agent, query, project, result, dry_run, created_at
    FROM agent_actions
    WHERE ${where.join(' AND ')}
    ORDER BY created_at DESC
    LIMIT ?
  `).all(...args, limit);
}

/**
 * Agent effectiveness summary for the feedback loop / dashboard (#21).
 * Computes accept/reject counts, rejection rate, and a per-agent breakdown.
 * Rejection rate > 0.5 is the signal #21 uses to reduce agent aggressiveness.
 *
 * @param {object} [opts]
 * @param {number} [opts.sinceDays]  — window in days (default: all-time)
 * @returns {{ total: number, reviewed: number, accepted: number, rejected: number,
 *             pending: number, rejectionRate: number|null, byAgent: object[] }}
 */
export function getAgentEffectiveness({ sinceDays = null } = {}) {
  const db = getDb();
  const where = [];
  const args  = [];
  if (sinceDays != null) {
    const cutoff = new Date(Date.now() - sinceDays * 86_400_000).toISOString();
    where.push('created_at >= ?');
    args.push(cutoff);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const totals = db.prepare(`
    SELECT
      COUNT(*)                                              AS total,
      SUM(CASE WHEN feedback = 'accepted' THEN 1 ELSE 0 END) AS accepted,
      SUM(CASE WHEN feedback = 'rejected' THEN 1 ELSE 0 END) AS rejected,
      SUM(CASE WHEN feedback IS NULL      THEN 1 ELSE 0 END) AS pending
    FROM agent_actions
    ${whereSql}
  `).get(...args);

  const accepted = totals.accepted ?? 0;
  const rejected = totals.rejected ?? 0;
  const reviewed = accepted + rejected;
  const rejectionRate = reviewed > 0 ? rejected / reviewed : null;

  const byAgent = db.prepare(`
    SELECT
      agent,
      COUNT(*)                                              AS total,
      SUM(CASE WHEN feedback = 'accepted' THEN 1 ELSE 0 END) AS accepted,
      SUM(CASE WHEN feedback = 'rejected' THEN 1 ELSE 0 END) AS rejected,
      SUM(CASE WHEN feedback IS NULL      THEN 1 ELSE 0 END) AS pending
    FROM agent_actions
    ${whereSql}
    GROUP BY agent
    ORDER BY total DESC
  `).all(...args).map(r => {
    const rev = (r.accepted ?? 0) + (r.rejected ?? 0);
    return { ...r, rejectionRate: rev > 0 ? (r.rejected ?? 0) / rev : null };
  });

  return {
    total:    totals.total ?? 0,
    reviewed,
    accepted,
    rejected,
    pending:  totals.pending ?? 0,
    rejectionRate,
    byAgent,
  };
}

/**
 * Review-queue status for the feedback loop nudge (#115).
 *
 * The feedback loop (#21) is dead when actions pile up un-reviewed: the analyzer
 * kept seeing 0 accepted / 0 rejected while pending grew, because nobody ran
 * `claudeye agent pending` by hand. This helper powers the two surfaces that
 * make the backlog visible: the daily-insights warning and the inject-hook
 * stderr nudge.
 *
 * @param {object} [opts]
 * @param {number} [opts.reviewedWindowDays]  — window for "recently reviewed" (default 7)
 * @returns {{ pending: number, reviewedRecent: number, windowDays: number }}
 */
export function getReviewQueueStatus({ reviewedWindowDays = 7 } = {}) {
  const db = getDb();
  const pending = db.prepare(
    `SELECT COUNT(*) AS n FROM agent_actions WHERE feedback IS NULL`
  ).get().n ?? 0;

  const cutoff = new Date(Date.now() - reviewedWindowDays * 86_400_000).toISOString();
  const reviewedRecent = db.prepare(
    `SELECT COUNT(*) AS n FROM agent_actions
     WHERE feedback IN ('accepted', 'rejected') AND feedback_at >= ?`
  ).get(cutoff).n ?? 0;

  return { pending, reviewedRecent, windowDays: reviewedWindowDays };
}

// ─── Time saved vs review time (#21) ──────────────────────────────────────────

/**
 * Heuristic estimate of minutes the agent saves per *accepted* action — i.e.
 * the manual context-gathering work the developer would otherwise have done by
 * hand. Deliberately conservative: the metric tracks the *trend* (is the agent
 * net-positive on time?), not wall-clock truth. Per-agent because a cross-repo
 * search and a PR-review context pull cost very different amounts to do manually.
 */
const EST_MINUTES_SAVED = {
  'cross-repo-context': 8,   // manual search across every project's history
  'pr-review':          12,  // digging up past decisions / hotspots for a diff
};
const DEFAULT_MINUTES_SAVED = 5;
// Cost of the human reviewing one action (glance + accept/reject).
const EST_REVIEW_MINUTES = 1;

/**
 * Time saved by the agent vs. time spent reviewing its output (#21).
 *
 * Only ACCEPTED actions count as time saved (rejected = noise that saved
 * nothing). Reviewing any action — accepted or rejected — costs a fixed amount
 * of attention. Pending (un-reviewed) actions count toward neither: their value
 * is unconfirmed and they haven't cost review time yet.
 *
 *   net = Σ(accepted × minutesSavedPerAgent) − (reviewed × reviewMinutes)
 *
 * A positive `netMinutesSaved` means the agent is earning back more than it
 * costs to supervise; negative means supervision outweighs its usefulness.
 *
 * @param {object} [opts]
 * @param {number} [opts.sinceDays]  — window in days (default: all-time)
 * @returns {{ accepted: number, reviewed: number, estMinutesSaved: number,
 *             estReviewMinutes: number, netMinutesSaved: number,
 *             reviewMinutesPerAction: number, byAgent: object[] }}
 */
export function getAgentTimeSavings({ sinceDays = null } = {}) {
  const db = getDb();
  const where = [];
  const args  = [];
  if (sinceDays != null) {
    const cutoff = new Date(Date.now() - sinceDays * 86_400_000).toISOString();
    where.push('created_at >= ?');
    args.push(cutoff);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const rows = db.prepare(`
    SELECT
      agent,
      SUM(CASE WHEN feedback = 'accepted' THEN 1 ELSE 0 END) AS accepted,
      SUM(CASE WHEN feedback = 'rejected' THEN 1 ELSE 0 END) AS rejected
    FROM agent_actions
    ${whereSql}
    GROUP BY agent
  `).all(...args);

  let estMinutesSaved  = 0;
  let estReviewMinutes = 0;
  let accepted = 0;
  let reviewed = 0;

  const byAgent = rows.map(r => {
    const acc = r.accepted ?? 0;
    const rej = r.rejected ?? 0;
    const rev = acc + rej;
    const perAction = EST_MINUTES_SAVED[r.agent] ?? DEFAULT_MINUTES_SAVED;
    const saved  = acc * perAction;
    const review = rev * EST_REVIEW_MINUTES;

    estMinutesSaved  += saved;
    estReviewMinutes += review;
    accepted += acc;
    reviewed += rev;

    return {
      agent: r.agent,
      accepted: acc,
      reviewed: rev,
      minutesSavedPerAction: perAction,
      estMinutesSaved: saved,
      estReviewMinutes: review,
      netMinutesSaved: saved - review,
    };
  }).sort((a, b) => b.netMinutesSaved - a.netMinutesSaved);

  return {
    accepted,
    reviewed,
    estMinutesSaved,
    estReviewMinutes,
    netMinutesSaved: estMinutesSaved - estReviewMinutes,
    reviewMinutesPerAction: EST_REVIEW_MINUTES,
    byAgent,
  };
}

/**
 * Weekly agent digest (#21): что агент сделал, что было полезно, что нет.
 *
 * Summarizes the last `days` of agent activity for a human-readable digest:
 * per-agent accept/reject counts, daily volume, the notes on rejected actions
 * (the "what wasn't useful" signal), and actionable recommendations derived
 * from the feedback loop (high rejection rate → reduce aggressiveness; large
 * review backlog → prompt the user to give feedback).
 *
 * AUP-safe: exposes only agent name, counts, timestamps and user-written
 * feedback notes — never raw_input/raw_output or stored query/result payloads.
 *
 * @param {object} [opts]
 * @param {number} [opts.days]  — window in days (default 7)
 * @returns {{ days: number, since: string, total: number, accepted: number,
 *             rejected: number, pending: number, reviewed: number,
 *             rejectionRate: number|null, byAgent: object[], byDay: object[],
 *             rejectedNotes: object[], recommendations: string[] }}
 */
export function getAgentDigest({ days = 7 } = {}) {
  const db = getDb();
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const eff = getAgentEffectiveness({ sinceDays: days });
  const timeSavings = getAgentTimeSavings({ sinceDays: days });

  // Daily volume of agent actions in the window.
  const byDay = db.prepare(`
    SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS count
    FROM agent_actions
    WHERE created_at >= ?
    GROUP BY day
    ORDER BY day ASC
  `).all(cutoff);

  // Rejected actions with their notes — the "what wasn't useful" signal.
  // Only metadata + user-written note is read (no query/result payloads).
  const rejectedNotes = db.prepare(`
    SELECT id, agent, feedback_note, created_at
    FROM agent_actions
    WHERE feedback = 'rejected' AND created_at >= ?
    ORDER BY created_at DESC
    LIMIT 10
  `).all(cutoff);

  // Actionable recommendations from the feedback loop.
  const recommendations = [];
  if (eff.rejectionRate != null && eff.rejectionRate > 0.5) {
    recommendations.push(
      `Rejection rate ${(eff.rejectionRate * 100).toFixed(0)}% > 50% — reduce agent aggressiveness.`,
    );
  }
  if (eff.reviewed === 0 && eff.total > 0) {
    recommendations.push(
      `No feedback given yet on ${eff.total} actions — the loop can't learn until you accept/reject some (claudeye agent pending).`,
    );
  } else if (eff.pending >= 20) {
    recommendations.push(
      `${eff.pending} actions awaiting review — run 'claudeye agent pending' to keep the loop fed.`,
    );
  }
  // Time-saved vs review-time signal (#21): is the agent net-positive?
  if (eff.reviewed > 0) {
    if (timeSavings.netMinutesSaved < 0) {
      recommendations.push(
        `Agent is net-negative on time: ~${Math.abs(timeSavings.netMinutesSaved)} min spent reviewing vs ${timeSavings.estMinutesSaved} min saved — tighten what it generates.`,
      );
    } else {
      recommendations.push(
        `Agent saved ~${timeSavings.netMinutesSaved} min net (${timeSavings.estMinutesSaved} saved − ${timeSavings.estReviewMinutes} reviewing) over the last ${days}d.`,
      );
    }
  }

  return {
    days,
    since:         cutoff,
    total:         eff.total,
    accepted:      eff.accepted,
    rejected:      eff.rejected,
    pending:       eff.pending,
    reviewed:      eff.reviewed,
    rejectionRate: eff.rejectionRate,
    byAgent:       eff.byAgent,
    byDay,
    rejectedNotes,
    timeSavings,
    recommendations,
  };
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
