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
 * Slice 3: Personal benchmarks — твоя скорость vs твоя средняя, тренд по
 * неделям. Каждая observation бакетится в свою ISO-неделю (понедельник UTC),
 * активное время оценивается тем же gap-методом. Для последней недели
 * считаются дельты к личному среднему и направление тренда (least-squares
 * slope) по каждой метрике.
 *
 * Slice 4: Workflow templates — «для задач типа X оптимальный порядок A→B→C».
 * Сессии группируются по доминирующей (по времени) категории = тип задачи.
 * Внутри типа категория попадает в шаблон, если встречается минимум в
 * TEMPLATE_PRESENCE сессий; порядок шагов = среднее нормированное время первого
 * появления категории внутри сессии (0 = начало, 1 = конец).
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

// ─── Slice 3: Personal benchmarks ────────────────────────────────────────────

// Метрики, по которым считаются benchmark/тренд. Помечаем «больше = лучше»:
// для производных (throughput) рост хорош, для часов/объёма — нейтрально.
export const BENCHMARK_METRICS = [
  { key: 'active_hours',    higher_is_better: null },
  { key: 'observations',    higher_is_better: null },
  { key: 'sessions',        higher_is_better: null },
  { key: 'obs_per_hour',    higher_is_better: true  },
  { key: 'avg_session_obs', higher_is_better: true  },
];

/**
 * Понедельник (UTC) недели, содержащей дату, в формате YYYY-MM-DD.
 * @param {string} dateStr — ISO-ish datetime
 * @returns {string}
 */
export function weekStart(dateStr) {
  const d = new Date(dateStr.includes('T') ? dateStr : dateStr.replace(' ', 'T') + 'Z');
  const day = d.getUTCDay();                  // 0=Вс..6=Сб
  const diff = day === 0 ? -6 : 1 - day;      // сдвиг к понедельнику
  const mon = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + diff));
  return mon.toISOString().slice(0, 10);
}

/**
 * Направление тренда по ряду значений: least-squares slope, нормированный
 * на среднее. Возвращает 'up' | 'down' | 'flat'.
 * @param {number[]} vals — в хронологическом порядке
 * @param {number} [eps=0.03] — порог относительного наклона за шаг
 */
export function trendOf(vals, eps = 0.03) {
  const n = vals.length;
  if (n < 2) return 'flat';
  const mx = (n - 1) / 2;
  const my = vals.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (i - mx) * (vals[i] - my); den += (i - mx) ** 2; }
  const slope = den ? num / den : 0;
  const rel = my ? slope / Math.abs(my) : 0;  // наклон за неделю относительно уровня
  if (rel > eps) return 'up';
  if (rel < -eps) return 'down';
  return 'flat';
}

/**
 * Personal benchmarks (#28, slice 3).
 *
 * Бьёт окно на ISO-недели, считает по каждой метрику активности и сравнивает
 * последнюю завершённую динамику с личным средним за окно.
 *
 * @param {object} [opts]
 * @param {number}  [opts.weeks=8]   — сколько недель назад смотреть
 * @param {string}  [opts.project]   — фильтр по полному пути проекта
 * @param {object}  [opts.db]        — injectable for tests
 * @returns {{weeks:number, project:string|null, observations:number,
 *            weeks_data:object[], benchmarks:object[], hints:string[]}}
 */
export function getPersonalBenchmarks({ weeks = 8, project = null, db = null } = {}) {
  db = db || getDb();
  const days = weeks * 7;

  const where = [
    `o.created_at >= datetime('now', '-' || ? || ' days')`,
    `o.tool NOT IN (${IMPORT_TOOLS.map(t => `'${t}'`).join(',')})`,
  ];
  const args = [days];
  if (project) { where.push('o.project = ?'); args.push(project); }

  const rows = db.prepare(`
    SELECT o.session_id, o.tool, o.created_at, o.duration_ms
    FROM observations o
    WHERE ${where.join(' AND ')}
    ORDER BY o.session_id, o.created_at
  `).all(...args);

  const wk = new Map(); // weekKey → { ms, observations, sessions:Set }
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const next = rows[i + 1];
    let ms;
    if (next && next.session_id === row.session_id) {
      const gap = new Date(next.created_at) - new Date(row.created_at);
      ms = gap > 0 ? Math.min(gap, GAP_CAP_MS) : (row.duration_ms || TAIL_MS);
    } else {
      ms = Math.min(row.duration_ms || TAIL_MS, GAP_CAP_MS);
    }
    const key = weekStart(row.created_at);
    let b = wk.get(key);
    if (!b) { b = { ms: 0, observations: 0, sessions: new Set() }; wk.set(key, b); }
    b.ms += ms; b.observations += 1; b.sessions.add(row.session_id);
  }

  const weeks_data = [...wk.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([week, b]) => {
      const hours = b.ms / 3600000;
      return {
        week,
        observations:    b.observations,
        sessions:        b.sessions.size,
        active_hours:    +hours.toFixed(2),
        obs_per_hour:    hours > 0 ? +(b.observations / hours).toFixed(1) : 0,
        avg_session_obs: b.sessions.size ? +(b.observations / b.sessions.size).toFixed(1) : 0,
      };
    });

  const latest = weeks_data[weeks_data.length - 1] || null;

  const benchmarks = BENCHMARK_METRICS.map(({ key, higher_is_better }) => {
    const vals = weeks_data.map(w => w[key]);
    const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
    const cur = latest ? latest[key] : 0;
    return {
      metric:       key,
      latest:       cur,
      personal_avg: +avg.toFixed(2),
      vs_avg_pct:   avg ? +(((cur - avg) / avg) * 100).toFixed(1) : 0,
      trend:        trendOf(vals),
      higher_is_better,
    };
  });

  // Hints — человекочитаемые выводы по производным метрикам (throughput)
  const hints = [];
  if (weeks_data.length >= 2 && latest) {
    const tp = benchmarks.find(b => b.metric === 'obs_per_hour');
    if (tp && tp.vs_avg_pct >= 15) {
      hints.push(`На этой неделе throughput ${tp.latest} obs/ч — на ${tp.vs_avg_pct}% выше личного среднего (${tp.personal_avg}).`);
    } else if (tp && tp.vs_avg_pct <= -15) {
      hints.push(`Throughput просел до ${tp.latest} obs/ч — на ${Math.abs(tp.vs_avg_pct)}% ниже личного среднего (${tp.personal_avg}); возможно, неделя ушла в research/debug.`);
    }
    if (tp && tp.trend === 'up') {
      hints.push(`Тренд throughput за ${weeks_data.length} недель — растущий: скорость работы повышается.`);
    } else if (tp && tp.trend === 'down') {
      hints.push(`Тренд throughput за ${weeks_data.length} недель — падающий: стоит посмотреть bottlenecks.`);
    }
    const ah = benchmarks.find(b => b.metric === 'active_hours');
    if (ah && ah.vs_avg_pct <= -25 && tp && tp.vs_avg_pct >= 0) {
      hints.push(`Активных часов меньше среднего на ${Math.abs(ah.vs_avg_pct)}%, но throughput не упал — неделя получилась эффективнее.`);
    }
  }

  return {
    weeks,
    project,
    observations: rows.length,
    weeks_data,
    benchmarks,
    hints,
  };
}

// ─── Slice 4: Workflow templates ─────────────────────────────────────────────

// Категории-шум: не несут смысла как шаг шаблона
const TEMPLATE_SKIP = new Set(['other']);
// Доля сессий типа, в которой категория должна встречаться, чтобы войти в шаблон
export const TEMPLATE_PRESENCE = 0.5;

/**
 * Workflow templates (#28, slice 4).
 *
 * Для каждого «типа задачи» (доминирующая по времени категория сессии)
 * выводит рекомендованный порядок шагов: категории, встречающиеся минимум в
 * TEMPLATE_PRESENCE сессий этого типа, упорядоченные по среднему нормированному
 * времени первого появления внутри сессии.
 *
 * Чистый SQLite + JS, без внешних вызовов. friction_score — опционально
 * (graceful degradation, если таблицы sessions нет — как в тестовой БД).
 *
 * @param {object} [opts]
 * @param {number}  [opts.days=30]
 * @param {string}  [opts.project]     — фильтр по полному пути проекта
 * @param {number}  [opts.minSessions=3] — мин. сессий типа, чтобы вывести шаблон
 * @param {object}  [opts.db]          — injectable for tests
 * @returns {{days:number, project:string|null, observations:number, sessions:number,
 *            templates: object[], hints:string[]}}
 */
export function getWorkflowTemplates({ days = 30, project = null, minSessions = 3, db = null } = {}) {
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

  // Сгруппировать observations по сессии с gap-оценкой времени категории
  const bySession = new Map(); // session_id → [{ cat, ms }]
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const next = rows[i + 1];
    let ms;
    if (next && next.session_id === row.session_id) {
      const gap = new Date(next.created_at) - new Date(row.created_at);
      ms = gap > 0 ? Math.min(gap, GAP_CAP_MS) : (row.duration_ms || TAIL_MS);
    } else {
      ms = Math.min(row.duration_ms || TAIL_MS, GAP_CAP_MS);
    }
    const cat = classifyObservation(row.tool, row.tags, row.summary);
    let arr = bySession.get(row.session_id);
    if (!arr) { arr = []; bySession.set(row.session_id, arr); }
    arr.push({ cat, ms });
  }

  // friction по сессиям (guard на отсутствие таблицы/колонки в тестовой БД)
  const fric = new Map();
  try {
    const fWhere = [`s.started_at >= datetime('now', '-' || ? || ' days')`];
    const fArgs = [days];
    if (project) { fWhere.push('s.project = ?'); fArgs.push(project); }
    for (const s of db.prepare(`SELECT s.id, s.friction_score FROM sessions s WHERE ${fWhere.join(' AND ')}`).all(...fArgs)) {
      if (s.friction_score != null) fric.set(s.id, s.friction_score);
    }
  } catch { /* нет таблицы sessions */ }

  // Аккумулятор по типам задач (dominant category)
  const types = new Map(); // dominant → { sessions, friction:[], hours:[], firstIdx: Map(cat→[norm]), present: Map(cat→cnt) }

  for (const [sid, obs] of bySession) {
    const catMs = {};     // cat → ms (для dominant)
    const firstAt = {};   // cat → индекс первого появления
    obs.forEach((o, idx) => {
      catMs[o.cat] = (catMs[o.cat] || 0) + o.ms;
      if (firstAt[o.cat] === undefined) firstAt[o.cat] = idx;
    });
    const dominant = Object.entries(catMs).sort((a, b) => b[1] - a[1])[0][0];
    const denom = Math.max(1, obs.length - 1);
    let totMs = 0; for (const c in catMs) totMs += catMs[c];

    let g = types.get(dominant);
    if (!g) { g = { sessions: 0, friction: [], hours: [], firstIdx: new Map(), present: new Map() }; types.set(dominant, g); }
    g.sessions += 1;
    if (fric.has(sid)) g.friction.push(fric.get(sid));
    g.hours.push(totMs / 3600000);
    for (const cat in firstAt) {
      if (TEMPLATE_SKIP.has(cat)) continue;
      const norm = firstAt[cat] / denom;
      if (!g.firstIdx.has(cat)) g.firstIdx.set(cat, []);
      g.firstIdx.get(cat).push(norm);
      g.present.set(cat, (g.present.get(cat) || 0) + 1);
    }
  }

  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

  const templates = [...types.entries()]
    .filter(([, g]) => g.sessions >= minSessions)
    .map(([type, g]) => {
      const steps = [...g.present.entries()]
        .filter(([, cnt]) => cnt / g.sessions >= TEMPLATE_PRESENCE)
        .map(([cat]) => ({ category: cat, presence: +(g.present.get(cat) / g.sessions).toFixed(2), avg_position: +avg(g.firstIdx.get(cat)).toFixed(2) }))
        .sort((a, b) => a.avg_position - b.avg_position);
      return {
        type,
        sessions:     g.sessions,
        sequence:     steps.map(s => s.category),
        steps,
        avg_friction: g.friction.length ? +avg(g.friction).toFixed(2) : null,
        avg_hours:    +avg(g.hours).toFixed(2),
      };
    })
    .sort((a, b) => b.sessions - a.sessions);

  const hints = [];
  for (const t of templates) {
    if (t.sequence.length >= 2) {
      const fr = t.avg_friction != null ? `, средний friction ${t.avg_friction}` : '';
      hints.push(`Для задач типа «${t.type}» (${t.sessions} сессий${fr}) типичный порядок: ${t.sequence.join(' → ')}.`);
    }
  }

  return { days, project, observations: rows.length, sessions: bySession.size, templates, hints };
}

// ─── Slice 5: Before/after comparison ────────────────────────────────────────

/**
 * Метрики для before/after-сравнения. higher_is_better управляет интерпретацией
 * дельты: true → рост = улучшение, false → падение = улучшение, null → нейтрально
 * (просто up/down, без оценки «лучше/хуже»).
 */
const COMPARE_METRICS = [
  { key: 'active_hours',    higher_is_better: null  },
  { key: 'observations',    higher_is_better: null  },
  { key: 'sessions',        higher_is_better: null  },
  { key: 'obs_per_hour',    higher_is_better: true  },
  { key: 'avg_session_obs', higher_is_better: true  },
  { key: 'avg_friction',    higher_is_better: false },
];

/**
 * created_at последнего insight = дата последней рекомендации. Используется как
 * pivot по умолчанию («после рекомендации»). Таблица insights может
 * отсутствовать (graceful degradation) — тогда null.
 * @returns {string|null} ISO datetime или null
 */
function latestInsightAt(db) {
  try {
    const row = db.prepare(`SELECT created_at FROM insights ORDER BY created_at DESC LIMIT 1`).get();
    return row?.created_at || null;
  } catch { return null; }
}

/**
 * Агрегирует активность за окно [startIso, endIso) тем же gap-методом, что и
 * остальной workflow-движок. Возвращает метрики + распределение времени по
 * категориям (доли в %).
 */
function aggregateWindow(db, startIso, endIso, project) {
  const where = [
    `o.created_at >= ?`,
    `o.created_at < ?`,
    `o.tool NOT IN (${IMPORT_TOOLS.map(t => `'${t}'`).join(',')})`,
  ];
  const args = [startIso, endIso];
  if (project) { where.push('o.project = ?'); args.push(project); }

  const rows = db.prepare(`
    SELECT o.session_id, o.tool, o.tags, o.summary, o.created_at, o.duration_ms
    FROM observations o
    WHERE ${where.join(' AND ')}
    ORDER BY o.session_id, o.created_at
  `).all(...args);

  let totalMs = 0;
  const sessions = new Set();
  const catMs = Object.fromEntries(CATEGORIES.map(c => [c, 0]));
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const next = rows[i + 1];
    let ms;
    if (next && next.session_id === row.session_id) {
      const gap = new Date(next.created_at) - new Date(row.created_at);
      ms = gap > 0 ? Math.min(gap, GAP_CAP_MS) : (row.duration_ms || TAIL_MS);
    } else {
      ms = Math.min(row.duration_ms || TAIL_MS, GAP_CAP_MS);
    }
    totalMs += ms;
    sessions.add(row.session_id);
    catMs[classifyObservation(row.tool, row.tags, row.summary)] += ms;
  }

  const hours = totalMs / 3600000;
  const obs = rows.length;

  // Средний friction по затронутым сессиям. Через подзапрос (а не IN-список id),
  // чтобы не упереться в лимит переменных SQLite на широких окнах.
  let avgFriction = null;
  if (sessions.size) {
    try {
      const fr = db.prepare(`
        SELECT AVG(friction_score) a FROM sessions
        WHERE id IN (SELECT DISTINCT o.session_id FROM observations o WHERE ${where.join(' AND ')})
      `).get(...args);
      avgFriction = fr?.a != null ? +fr.a.toFixed(3) : null;
    } catch { /* sessions table missing — friction unavailable */ }
  }

  const category_share = {};
  for (const c of CATEGORIES) {
    category_share[c] = totalMs > 0 ? +((catMs[c] / totalMs) * 100).toFixed(1) : 0;
  }

  return {
    active_hours:    +hours.toFixed(2),
    observations:    obs,
    sessions:        sessions.size,
    obs_per_hour:    hours > 0 ? +(obs / hours).toFixed(1) : 0,
    avg_session_obs: sessions.size ? +(obs / sessions.size).toFixed(1) : 0,
    avg_friction:    avgFriction,
    category_share,
  };
}

/**
 * Before/after comparison (#28, slice 5).
 *
 * Делит активность на два окна одинаковой длины — до и после pivot-даты — и
 * сравнивает метрики, чтобы показать, как изменился workflow «после
 * рекомендации». Pivot по умолчанию — дата последнего insight (последней
 * рекомендации); можно задать явно через opts.pivot.
 *
 * Каждая метрика получает before/after/delta/delta_pct и direction:
 *   - higher_is_better=null → 'up' | 'down' | 'flat' (нейтрально)
 *   - higher_is_better заданo → 'improved' | 'regressed' | 'flat'
 * Дельта в пределах ±5% от before считается 'flat'.
 *
 * @param {object} [opts]
 * @param {number}  [opts.windowDays=14] — длина каждого окна в днях
 * @param {string}  [opts.pivot]         — ISO datetime границы (по умолч. — последний insight)
 * @param {string}  [opts.project]       — фильтр по полному пути проекта
 * @param {object}  [opts.db]            — injectable for tests
 * @returns {{window_days:number, pivot:string, pivot_source:string, project:string|null,
 *            before:object, after:object, comparison:object[], category_shift:object[], hints:string[]}}
 */
export function getBeforeAfter({ windowDays = 14, pivot = null, project = null, db = null } = {}) {
  db = db || getDb();

  const autoPivot = latestInsightAt(db);
  const pivotIso = pivot || autoPivot || new Date(Date.now() - windowDays * 86400000).toISOString();
  const pivotMs = new Date(pivotIso.includes('T') ? pivotIso : pivotIso.replace(' ', 'T') + 'Z').getTime();

  // Формат под колонку observations.created_at: 'YYYY-MM-DD HH:MM:SS' (UTC).
  const toCol = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
  const pivotCol    = toCol(pivotMs);
  const beforeStart = toCol(pivotMs - windowDays * 86400000);
  const afterEnd    = toCol(pivotMs + windowDays * 86400000);

  const before = aggregateWindow(db, beforeStart, pivotCol, project);
  const after  = aggregateWindow(db, pivotCol, afterEnd, project);

  const comparison = COMPARE_METRICS.map(({ key, higher_is_better }) => {
    const b = before[key];
    const a = after[key];
    let delta = null, delta_pct = null, direction = 'flat';
    if (b != null && a != null) {
      delta = +(a - b).toFixed(3);
      delta_pct = b !== 0 ? +(((a - b) / Math.abs(b)) * 100).toFixed(1) : (a !== 0 ? null : 0);
      const eps = Math.abs(b) * 0.05;
      if (Math.abs(delta) <= eps) direction = 'flat';
      else if (higher_is_better == null) direction = delta > 0 ? 'up' : 'down';
      else direction = (higher_is_better ? delta > 0 : delta < 0) ? 'improved' : 'regressed';
    }
    return { metric: key, before: b, after: a, delta, delta_pct, direction, higher_is_better };
  });

  // Сдвиг распределения времени по категориям (в процентных пунктах).
  const category_shift = CATEGORIES
    .map(c => ({
      category: c,
      before:   before.category_share[c],
      after:    after.category_share[c],
      delta_pp: +(after.category_share[c] - before.category_share[c]).toFixed(1),
    }))
    .filter(x => Math.abs(x.delta_pp) >= 1)
    .sort((a, b) => Math.abs(b.delta_pp) - Math.abs(a.delta_pp));

  const hints = [];
  const tp = comparison.find(c => c.metric === 'obs_per_hour');
  if (tp && tp.before != null && tp.after != null && tp.delta_pct != null) {
    if (tp.direction === 'improved') hints.push(`Throughput вырос на ${tp.delta_pct}% (${tp.before}→${tp.after} obs/ч) после ${pivotCol}.`);
    else if (tp.direction === 'regressed') hints.push(`Throughput упал на ${Math.abs(tp.delta_pct)}% (${tp.before}→${tp.after} obs/ч) после ${pivotCol}.`);
  }
  const fr = comparison.find(c => c.metric === 'avg_friction');
  if (fr && fr.before != null && fr.after != null && fr.direction !== 'flat') {
    if (fr.direction === 'improved') hints.push(`Friction снизился: ${fr.before} → ${fr.after}.`);
    else hints.push(`Friction вырос: ${fr.before} → ${fr.after} — рекомендация не помогла или появились новые тормоза.`);
  }
  if (category_shift.length) {
    const top = category_shift[0];
    hints.push(`Доля «${top.category}» ${top.delta_pp > 0 ? 'выросла' : 'снизилась'} на ${Math.abs(top.delta_pp)} п.п. (${top.before}% → ${top.after}%).`);
  }

  return {
    window_days:  windowDays,
    pivot:        pivotCol,
    pivot_source: pivot ? 'explicit' : (autoPivot ? 'latest_insight' : 'default'),
    project,
    before,
    after,
    comparison,
    category_shift,
    hints,
  };
}
