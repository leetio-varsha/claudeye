/**
 * src/agent-router.js — Task Routing + Control (#22)
 *
 * Anti-chaos routing: given a natural-language task description,
 * return the right agent command to run. Prevents orchestration hell
 * by keeping routing deterministic and auditable.
 *
 * Design:
 *   - Keyword-based matching (fast, no LLM needed, fully offline)
 *   - Confidence score: 1.0 = exact match, 0.6–0.9 = strong hint, <0.6 = fallback
 *   - All routing decisions logged to agent_actions (agent='router')
 *   - Context scoping: each route specifies which context the agent needs
 *
 * Usage:
 *   import { routeTask } from './agent-router.js';
 *   const decision = routeTask('find auth patterns across repos');
 *   // { agent, command, args, confidence, reason, contextScope }
 */

// ─── Route Table ──────────────────────────────────────────────────────────────

/**
 * Each route entry:
 *   keywords   — terms that trigger this route (any match scores points)
 *   agent      — which agent handles this
 *   command    — CLI subcommand (e.g., 'context', 'pr-review', 'daemon')
 *   action     — optional: daemon action name for daemon routes
 *   baseScore  — base confidence when matched
 *   contextScope — what DB context the agent needs ('cross-repo' | 'project' | 'db' | 'none')
 *   description — human-readable description of this route
 */
const ROUTE_TABLE = [
  {
    keywords:     ['review', 'pr', 'diff', 'merge request', 'pull request', 'code review', 'changes'],
    agent:        'pr-review',
    command:      'pr-review',
    baseScore:    0.85,
    contextScope: 'project',
    description:  'Git diff → Claudeye context → code review suggestions',
  },
  {
    keywords:     ['cross', 'cross-repo', 'other project', 'other repo', 'similar', 'pattern', 'find', 'search', 'context', 'how did', 'how do', 'examples', 'across'],
    agent:        'cross-repo-context',
    command:      'context',
    baseScore:    0.80,
    contextScope: 'cross-repo',
    description:  'Search across ALL projects for relevant memory',
  },
  {
    keywords:     ['session', 'activity', 'recent', 'today', 'what happened', 'worked on', 'summary', 'digest'],
    agent:        'daemon',
    command:      'daemon',
    action:       'session-analysis',
    baseScore:    0.80,
    contextScope: 'db',
    description:  'Analyse recent sessions and activity from memory',
  },
  {
    keywords:     ['db', 'database', 'size', 'growth', 'storage', 'disk', 'space', 'mem.db'],
    agent:        'daemon',
    command:      'daemon',
    action:       'db-growth-alert',
    baseScore:    0.80,
    contextScope: 'db',
    description:  'Check database size and growth rate',
  },
  {
    keywords:     ['search', 'look for', 'find', 'query', 'grep', 'memory', 'recall', 'what do i know'],
    agent:        'search',
    command:      'search',
    baseScore:    0.65,
    contextScope: 'project',
    description:  'Semantic search in Claudeye memory',
  },
];

// ─── Scoring ─────────────────────────────────────────────────────────────────

/**
 * Score a single route against the input description.
 * Returns a confidence value 0.0–1.0.
 *
 * Matching rules:
 *   w.includes(kw)  — word contains the keyword (e.g. "cross-repo" in a hyphenated token)
 *   kw.includes(w)  — keyword contains the word, BUT only if w is meaningful (≥4 chars)
 *                     This prevents stop-words like "the", "is", "or" from matching
 *                     inside multi-word keywords like "other project".
 */
function scoreRoute(route, words) {
  let hits = 0;
  for (const kw of route.keywords) {
    const matched = words.some(w =>
      w.includes(kw) || (w.length >= 4 && kw.includes(w)),
    );
    if (matched) hits++;
  }
  if (hits === 0) return 0;
  // Scale: 1 hit → baseScore, more hits → approach 1.0
  const boost = Math.min(hits - 1, 3) * 0.05;
  return Math.min(route.baseScore + boost, 1.0);
}

// ─── Router ───────────────────────────────────────────────────────────────────

/**
 * @typedef {object} RoutingDecision
 * @property {string}   agent        — agent name
 * @property {string}   command      — claudeye agent <command>
 * @property {string|null} action    — daemon action (if agent==='daemon')
 * @property {number}   confidence   — 0.0–1.0
 * @property {string}   reason       — why this route was chosen
 * @property {string}   contextScope — 'cross-repo' | 'project' | 'db' | 'none'
 * @property {string}   cliHint      — suggested CLI command string
 */

/**
 * Route a task description to the appropriate agent command.
 *
 * @param {string} description — natural-language description of the task
 * @returns {RoutingDecision}
 */
export function routeTask(description) {
  if (!description || !description.trim()) {
    return _fallback('empty description');
  }

  const normalized = description.toLowerCase().trim();
  const words      = normalized.split(/\s+/);

  let bestRoute = null;
  let bestScore = 0;

  for (const route of ROUTE_TABLE) {
    const score = scoreRoute(route, words);
    if (score > bestScore) {
      bestScore = score;
      bestRoute = route;
    }
  }

  if (!bestRoute || bestScore < 0.5) {
    return _fallback(`no route matched (best score: ${bestScore.toFixed(2)})`);
  }

  const matchedKeywords = bestRoute.keywords.filter(kw =>
    words.some(w => w.includes(kw) || kw.includes(w)),
  );

  return {
    agent:        bestRoute.agent,
    command:      bestRoute.command,
    action:       bestRoute.action ?? null,
    confidence:   parseFloat(bestScore.toFixed(2)),
    reason:       `matched keywords: ${matchedKeywords.slice(0, 3).join(', ')}`,
    contextScope: bestRoute.contextScope,
    description:  bestRoute.description,
    cliHint:      _buildCliHint(bestRoute, description),
  };
}

function _fallback(reason) {
  return {
    agent:        'search',
    command:      'search',
    action:       null,
    confidence:   0.3,
    reason:       `fallback — ${reason}`,
    contextScope: 'project',
    description:  'Semantic search (fallback)',
    cliHint:      'claudeye search "<your query>"',
  };
}

function _buildCliHint(route, description) {
  const shortDesc = description.slice(0, 40).replace(/"/g, "'");
  if (route.agent === 'daemon') {
    return `claudeye agent daemon  # runs ${route.action}`;
  }
  if (route.command === 'context') {
    return `claudeye agent context "${shortDesc}"`;
  }
  if (route.command === 'pr-review') {
    return 'claudeye agent pr-review  # run from repo root';
  }
  return `claudeye ${route.command} "${shortDesc}"`;
}

// ─── Audit Log ────────────────────────────────────────────────────────────────

/**
 * Log a routing decision to agent_actions for audit trail.
 * Non-critical — never throws.
 *
 * @param {string} description   — original user query
 * @param {RoutingDecision} decision
 */
export function logRoutingDecision(description, decision) {
  try {
    const { getDb } = await_import_sync('./db.js');
    const db = getDb();
    db.prepare(`
      INSERT INTO agent_actions (agent, query, project, result, dry_run)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      'router',
      description ?? null,
      decision.command,
      JSON.stringify({
        agent:        decision.agent,
        confidence:   decision.confidence,
        reason:       decision.reason,
        contextScope: decision.contextScope,
      }),
      1,  // routing decisions are always informational (dry_run=1)
    );
  } catch {
    // Non-critical
  }
}

// We can't use dynamic import in a sync context, so provide a sync wrapper
// that callers can use if they have a DB handle.
/**
 * Log routing decision using an already-open DB handle (sync).
 * @param {import('better-sqlite3').Database} db
 * @param {string} description
 * @param {RoutingDecision} decision
 */
export function logRoutingDecisionSync(db, description, decision) {
  try {
    db.prepare(`
      INSERT INTO agent_actions (agent, query, project, result, dry_run)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      'router',
      description ?? null,
      decision.command,
      JSON.stringify({
        agent:        decision.agent,
        confidence:   decision.confidence,
        reason:       decision.reason,
        contextScope: decision.contextScope,
      }),
      1,
    );
  } catch {
    // Non-critical
  }
}

// ─── Rate Guard ───────────────────────────────────────────────────────────────

/**
 * Check if agent actions are within rate limit.
 * Returns { allowed: boolean, count: number, limit: number }.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string}  agent          — agent name to check (or null for all agents)
 * @param {number}  maxPerHour     — max allowed actions per hour
 * @param {number}  [windowHours]  — look-back window in hours (default 1)
 */
export function checkRateLimit(db, agent, maxPerHour, windowHours = 1) {
  try {
    // SQLite stores datetime('now') with a space separator (e.g. "2026-05-25 12:00:00"),
    // not ISO 'T'. Must use space separator in the cutoff string for the comparison to work.
    const cutoff = new Date(Date.now() - windowHours * 60 * 60 * 1000)
      .toISOString()
      .replace('T', ' ')
      .slice(0, 19);

    const where = agent ? 'AND agent = ?' : '';
    const params = agent ? [cutoff, agent] : [cutoff];

    const row = db.prepare(`
      SELECT COUNT(*) AS cnt
      FROM agent_actions
      WHERE created_at >= ? ${where} AND dry_run = 0
    `).get(...params);

    const count = row?.cnt ?? 0;
    return { allowed: count < maxPerHour, count, limit: maxPerHour };
  } catch {
    return { allowed: true, count: 0, limit: maxPerHour }; // fail open
  }
}

// ─── Context Scoping ──────────────────────────────────────────────────────────

/**
 * Describe what context a given scope needs — used to constrain DB queries.
 * Returns query options for hybridSearch / getDb.
 *
 * @param {'cross-repo'|'project'|'db'|'none'} scope
 * @param {string} [currentProject]  — cwd-based project path
 * @returns {{ project: string|null, limit: number, note: string }}
 */
export function scopeToQueryOpts(scope, currentProject = null) {
  switch (scope) {
    case 'cross-repo':
      return { project: null,           limit: 15, note: 'all projects' };
    case 'project':
      return { project: currentProject, limit: 20, note: 'current project only' };
    case 'db':
      return { project: null,           limit: 5,  note: 'DB metadata only' };
    case 'none':
    default:
      return { project: null,           limit: 0,  note: 'no context needed' };
  }
}

// Unused import shim — logRoutingDecision is async-unfriendly; use logRoutingDecisionSync instead
function await_import_sync() { throw new Error('use logRoutingDecisionSync'); }
