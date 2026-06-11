/**
 * src/workflow.js — Self-Improving Workflow Engine (#28)
 *
 * Slice 1: Time allocation analysis — какой процент времени уходит на
 * code / debug / review / docs / research / ops.
 *
 * Slice 2: Bottleneck detection — конкретные места workflow, где friction
 * максимален: медленные шаги по категориям, дорогие переходы между
 * категориями, churn-файлы (многократные правки в одной сессии),
 * high-friction сессии.
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

// ─── Slice 2: Bottleneck detection ───────────────────────────────────────────

// Файл считается churn-кандидатом, если правился столько раз в одной сессии
export const CHURN_MIN_EDITS = 3;

// Извлечение пути файла из summary (AI-compressed текст упоминает пути)
const FILE_RE = /[\w@./~-]+\.(?:[cm]?jsx?|tsx?|py|go|rs|java|rb|php|css|scss|html|json|ya?ml|md|sql|sh|vue|svelte)\b/;

/**
 * Bottleneck detection (#28, slice 2).
 *
 * Четыре сигнала:
 *  - slow_steps:   категории, где средний шаг (gap-метод) медленнее общего среднего;
 *  - transitions:  переходы между категориями с максимальной средней стоимостью
 *                  (gap последней observation категории A до первой категории B);
 *  - churn_files:  файлы, правленные ≥ CHURN_MIN_EDITS раз в одной сессии
 *                  (edit-test-edit циклы — маркер friction);
 *  - friction_sessions: топ сессий по sessions.friction_score за окно.
 *
 * @param {object} [opts]
 * @param {number}  [opts.days=30]
 * @param {string}  [opts.project] — filter by full project path
 * @param {number}  [opts.top=5]   — сколько элементов в каждом списке
 * @param {number}  [opts.minObs=5] — мин. observations в категории для slow_steps
 * @param {object}  [opts.db]      — injectable for tests
 */
export function getBottlenecks({ days = 30, project = null, top = 5, minObs = 5, db = null } = {}) {
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

  const catAcc   = Object.fromEntries(CATEGORIES.map(c => [c, { ms: 0, observations: 0 }]));
  const transAcc = new Map();           // 'a→b' → { ms, count }
  const editAcc  = new Map();           // 'session\0file' → count
  const sessCat  = new Map();           // session_id → { cat: ms } (для dominant)
  const sessions = new Set();
  let totalMs = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    sessions.add(row.session_id);
    const cat  = classifyObservation(row.tool, row.tags, row.summary);
    const next = rows[i + 1];
    const sameSession = next && next.session_id === row.session_id;

    let ms;
    if (sameSession) {
      const gap = new Date(next.created_at) - new Date(row.created_at);
      ms = gap > 0 ? Math.min(gap, GAP_CAP_MS) : (row.duration_ms || TAIL_MS);
    } else {
      ms = Math.min(row.duration_ms || TAIL_MS, GAP_CAP_MS);
    }

    catAcc[cat].ms += ms;
    catAcc[cat].observations += 1;
    totalMs += ms;

    const sc = sessCat.get(row.session_id) || {};
    sc[cat] = (sc[cat] || 0) + ms;
    sessCat.set(row.session_id, sc);

    // Переход категории внутри сессии: стоимость = gap текущей observation
    if (sameSession) {
      const nextCat = classifyObservation(next.tool, next.tags, next.summary);
      if (nextCat !== cat) {
        const key = `${cat}→${nextCat}`;
        const t = transAcc.get(key) || { ms: 0, count: 0 };
        t.ms += ms; t.count += 1;
        transAcc.set(key, t);
      }
    }

    // Churn: правки одного файла в одной сессии
    if (CODE_TOOLS.has(row.tool)) {
      const m = (row.summary || '').match(FILE_RE);
      if (m) {
        const key = `${row.session_id} ${m[0]}`;
        editAcc.set(key, (editAcc.get(key) || 0) + 1);
      }
    }
  }

  const overallAvgSec = rows.length ? +(totalMs / rows.length / 1000).toFixed(1) : 0;

  const slow_steps = CATEGORIES
    .filter(c => catAcc[c].observations >= minObs)
    .map(c => ({
      category:     c,
      avg_sec:      +(catAcc[c].ms / catAcc[c].observations / 1000).toFixed(1),
      slowdown:     overallAvgSec ? +((catAcc[c].ms / catAcc[c].observations / 1000) / overallAvgSec).toFixed(2) : 0,
      observations: catAcc[c].observations,
      hours:        +(catAcc[c].ms / 3600000).toFixed(2),
    }))
    .sort((a, b) => b.avg_sec - a.avg_sec)
    .slice(0, top);

  const transitions = [...transAcc.entries()]
    .map(([key, t]) => {
      const [from, to] = key.split('→');
      return { from, to, avg_sec: +(t.ms / t.count / 1000).toFixed(1), count: t.count };
    })
    .sort((a, b) => b.avg_sec - a.avg_sec)
    .slice(0, top);

  // Churn-файлы: эпизод = сессия с ≥ CHURN_MIN_EDITS правками файла
  const churnByFile = new Map(); // file → { sessions, edits }
  for (const [key, count] of editAcc) {
    if (count < CHURN_MIN_EDITS) continue;
    const file = key.split(' ')[1];
    const c = churnByFile.get(file) || { sessions: 0, edits: 0 };
    c.sessions += 1; c.edits += count;
    churnByFile.set(file, c);
  }
  const churn_files = [...churnByFile.entries()]
    .map(([file, c]) => ({ file, sessions: c.sessions, edits: c.edits }))
    .sort((a, b) => b.edits - a.edits)
    .slice(0, top);

  // High-friction сессии (sessions.friction_score), guard: таблицы может не быть в тестовой БД
  let friction_sessions = [];
  try {
    const sWhere = [`s.started_at >= datetime('now', '-' || ? || ' days')`, 's.friction_score > 0'];
    const sArgs = [days];
    if (project) { sWhere.push('s.project = ?'); sArgs.push(project); }
    friction_sessions = db.prepare(`
      SELECT s.id, s.started_at, s.friction_score
      FROM sessions s WHERE ${sWhere.join(' AND ')}
      ORDER BY s.friction_score DESC LIMIT ?
    `).all(...sArgs, top)
      .map(s => {
        const sc = sessCat.get(s.id) || {};
        const dominant = Object.entries(sc).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
        return { id: s.id, started_at: s.started_at, friction_score: +s.friction_score.toFixed(2), dominant };
      });
  } catch { /* no sessions table (tests) or no friction_score column */ }

  // Hints — человекочитаемые выводы из сигналов
  const hints = [];
  const slowest = slow_steps[0];
  if (slowest && slowest.slowdown >= 1.5 && ['debug', 'ops', 'other'].includes(slowest.category)) {
    hints.push(`Шаги категории «${slowest.category}» в ${slowest.slowdown}× медленнее среднего (${slowest.avg_sec}s vs ${overallAvgSec}s) — главный кандидат на оптимизацию.`);
  }
  const slowTrans = transitions[0];
  if (slowTrans && overallAvgSec && slowTrans.avg_sec >= overallAvgSec * 2 && slowTrans.count >= 3) {
    hints.push(`Переход ${slowTrans.from}→${slowTrans.to} стоит в среднем ${slowTrans.avg_sec}s (${slowTrans.count} раз) — контекст-свитч с максимальной ценой.`);
  }
  const churnLeader = churn_files[0];
  if (churnLeader) {
    hints.push(`${churnLeader.file} правился ${churnLeader.edits} раз в ${churnLeader.sessions} сессии(ях) — edit-test-edit цикл; кандидат на рефакторинг или больше тестов.`);
  }
  const fricLeader = friction_sessions[0];
  if (fricLeader && fricLeader.friction_score >= 0.5) {
    hints.push(`Сессия ${fricLeader.id} имеет friction ${fricLeader.friction_score}${fricLeader.dominant ? ` (доминирует ${fricLeader.dominant})` : ''} — стоит посмотреть, что пошло не так.`);
  }

  return {
    days,
    project,
    observations:    rows.length,
    sessions:        sessions.size,
    overall_avg_sec: overallAvgSec,
    slow_steps,
    transitions,
    churn_files,
    friction_sessions,
    hints,
  };
}
