/**
 * src/workflow.js — Self-Improving Workflow Engine (#28)
 *
 * Slice 1: Time allocation analysis — какой процент времени уходит на
 * code / debug / review / docs / research / ops.
 *
 * Время оценивается gap-методом: интервал между соседними observations
 * внутри сессии приписывается категории текущей observation, с капом
 * (паузы > GAP_CAP_MS считаются перерывом и не учитываются).
 *
 * All computations are pure SQLite + JS — no external calls.
 */

import { getDb } from './db.js';

// Tools originating from imports — excluded (same rationale as analytics.js)
const IMPORT_TOOLS = ['git-commit', 'jira-issue', 'slack-message', 'sentry-issue', 'notion-page', 'github-pr', 'linear-issue'];

// Gap cap: разрыв между соседними observations больше этого — перерыв, не работа
export const GAP_CAP_MS = 15 * 60 * 1000;
// Last observation in a session has no "next" — give it a flat tail estimate
const TAIL_MS = 60 * 1000;

export const CATEGORIES = ['code', 'debug', 'review', 'docs', 'research', 'ops', 'other'];

const RESEARCH_TOOLS = new Set(['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'ToolSearch', 'Task', 'Agent', 'Explore']);
const CODE_TOOLS     = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/**
 * Classify a single observation into a workflow category.
 * Priority: tags (intent) > file extension (docs) > tool (mechanics).
 *
 * @param {string} tool
 * @param {string|null} tags     — JSON array string from observations.tags
 * @param {string|null} summary
 * @returns {string} one of CATEGORIES
 */
export function classifyObservation(tool, tags, summary) {
  const t = (tags || '').toLowerCase();
  const s = (summary || '').toLowerCase();

  // 1. Intent from tags
  if (/review|pr-review|code-review/.test(t)) return 'review';
  if (/error|bugfix|debug|\bfix\b|"fix"/.test(t)) return 'debug';
  if (/docs|documentation|readme/.test(t)) return 'docs';

  // 2. Docs by artifact: editing markdown/doc files
  if (CODE_TOOLS.has(tool) && /\.(md|mdx|rst|txt)\b|readme|changelog|claude\.md/.test(s)) return 'docs';

  // 3. Tool mechanics
  if (CODE_TOOLS.has(tool)) return 'code';
  if (RESEARCH_TOOLS.has(tool)) return 'research';

  if (tool === 'Bash' || tool.endsWith('__bash')) {
    if (/\btest\b|jest|vitest|npm test|pytest|спадают|тест/.test(s)) return 'debug';
    if (/git |commit|push|merge|rebase|deploy|docker|npm install|brew |launchctl|chmod|systemctl/.test(s)) return 'ops';
    return 'other';
  }

  if (tool.startsWith('mcp__')) return 'ops';
  return 'other';
}

/**
 * Time allocation by category over a window.
 *
 * @param {object} [opts]
 * @param {number}  [opts.days=30]
 * @param {string}  [opts.project]  — filter by full project path
 * @param {object}  [opts.db]       — injectable for tests
 * @returns {{days:number, project:string|null, total_hours:number,
 *            observations:number, sessions:number,
 *            categories: {category:string, hours:number, pct:number, observations:number}[]}}
 */
export function getTimeAllocation({ days = 30, project = null, db = null } = {}) {
  db = db || getDb();

  const where = [
    `o.created_at >= datetime('now', '-' || ? || ' days')`,
    `o.tool NOT IN (${IMPORT_TOOLS.map(t => `'${t}'`).join(',')})`,
  ];
  const args = [days];
  if (project) { where.push('o.project = ?'); args.push(project); }

  const rows = db.prepare(`
    SELECT o.session_id, o.tool, o.tags, o.summary, o.created_at, o.duration_ms
    FROM observations o
    WHERE ${where.join(' AND ')}
    ORDER BY o.session_id, o.created_at
  `).all(...args);

  const acc = Object.fromEntries(CATEGORIES.map(c => [c, { ms: 0, observations: 0 }]));
  const sessions = new Set();
  let totalMs = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    sessions.add(row.session_id);

    const next = rows[i + 1];
    let ms;
    if (next && next.session_id === row.session_id) {
      const gap = new Date(next.created_at) - new Date(row.created_at);
      ms = gap > 0 ? Math.min(gap, GAP_CAP_MS) : (row.duration_ms || TAIL_MS);
    } else {
      // last observation in session — no next gap
      ms = Math.min(row.duration_ms || TAIL_MS, GAP_CAP_MS);
    }

    const cat = classifyObservation(row.tool, row.tags, row.summary);
    acc[cat].ms += ms;
    acc[cat].observations += 1;
    totalMs += ms;
  }

  const categories = CATEGORIES
    .map(c => ({
      category:     c,
      hours:        +(acc[c].ms / 3600000).toFixed(2),
      pct:          totalMs ? +((acc[c].ms / totalMs) * 100).toFixed(1) : 0,
      observations: acc[c].observations,
    }))
    .filter(c => c.observations > 0)
    .sort((a, b) => b.hours - a.hours);

  return {
    days,
    project,
    total_hours:  +(totalMs / 3600000).toFixed(2),
    observations: rows.length,
    sessions:     sessions.size,
    categories,
  };
}
