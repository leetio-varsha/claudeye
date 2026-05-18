/**
 * src/server.js — Minimal web viewer API
 * Serves the viewer UI + REST endpoints for browsing observations.
 * Localhost-only for all personal routes.
 * /shared/:token/* routes accept remote connections — protected by token (#33).
 */

import express from 'express';
import { join } from 'path';
import { getDb, getStats, createShareToken, getShareToken, listShareTokens, revokeShareToken } from './db.js';

const __dir = new URL('.', import.meta.url).pathname;

// ─── Input validation helpers (#70) ───────────────────────────────────────

/** Parse an integer query param within [min, max], returning `def` on bad input */
function safeInt(val, { min = 0, max = 1000, def = 0 } = {}) {
  const n = parseInt(val, 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

/** Sanitize a string query param: limit length, strip control chars */
function safeStr(val, maxLen = 500) {
  if (typeof val !== 'string') return undefined;
  return val.slice(0, maxLen).replace(/[\x00-\x1f]/g, '');
}

export function createServer(port = 47777) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // All routes except /shared/:token/* are localhost-only (#33)
  app.use((req, res, next) => {
    if (req.path.startsWith('/shared/')) return next(); // share routes handle their own auth
    const ip = req.ip || req.connection.remoteAddress || '';
    if (!['::1', '127.0.0.1', '::ffff:127.0.0.1'].includes(ip)) {
      return res.status(403).json({ error: 'Localhost only' });
    }
    next();
  });

  // ─── API ─────────────────────────────────────────────────────────────

  app.get('/api/stats', (req, res) => {
    res.json(getStats());
  });

  app.get('/api/observations', (req, res) => {
    const db      = getDb();
    const project = safeStr(req.query.project);
    const limit   = safeInt(req.query.limit, { min: 1, max: 200, def: 50 });
    const offset  = safeInt(req.query.offset, { min: 0, max: 100000, def: 0 });

    const where = project ? 'WHERE project = ?' : '';
    const params = project ? [project, limit, offset] : [limit, offset];

    const rows = db.prepare(`
      SELECT id, project, tool, summary, tags, importance, created_at
      FROM observations
      ${where}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params);

    const total = db.prepare(`SELECT COUNT(*) as n FROM observations ${where}`)
      .get(...(project ? [project] : [])).n;

    res.json({ rows, total, limit, offset });
  });

  app.get('/api/observations/:id', (req, res) => {
    const obs = getDb().prepare('SELECT * FROM observations WHERE id = ?').get(req.params.id);
    if (!obs) return res.status(404).json({ error: 'Not found' });
    res.json(obs);
  });

  app.get('/api/sessions', (req, res) => {
    const db = getDb();
    const sessions = db.prepare(`
      SELECT s.id, s.project, s.started_at, s.ended_at, s.summary,
             COUNT(o.id) as obs_count
      FROM sessions s
      LEFT JOIN observations o ON o.session_id = s.id
      GROUP BY s.id
      ORDER BY s.started_at DESC
      LIMIT 50
    `).all();
    res.json(sessions);
  });

  app.get('/api/projects', (req, res) => {
    const db = getDb();
    const projects = db.prepare(`
      SELECT project, COUNT(*) as obs_count, MAX(created_at) as last_activity
      FROM observations
      GROUP BY project
      ORDER BY last_activity DESC
    `).all();
    res.json(projects);
  });

  // ─── Insight endpoints ──────────────────────────────────────────────

  // Friction hotspots: projects and tools with highest error rates
  app.get('/api/insights/friction', (req, res) => {
    const db = getDb();
    const days = safeInt(req.query.days, { min: 1, max: 90, def: 7 });

    // Projects ranked by friction (avg importance of high-imp observations)
    const projects = db.prepare(`
      SELECT
        REPLACE(REPLACE(project, '/Users/lord/Sites/', ''), '/Users/lord/Documents/Claude/Projects/', '') as project,
        COUNT(*) as total_obs,
        SUM(CASE WHEN importance >= 0.8 THEN 1 ELSE 0 END) as critical_obs,
        ROUND(AVG(importance), 3) as avg_importance,
        ROUND(CAST(SUM(CASE WHEN importance >= 0.8 THEN 1 ELSE 0 END) AS REAL) / COUNT(*) * 100, 1) as error_pct
      FROM observations
      WHERE created_at >= date('now', '-' || ? || ' days') AND tool != 'git-commit'
      GROUP BY project
      HAVING total_obs >= 5
      ORDER BY error_pct DESC
      LIMIT 10
    `).all(days);

    // Top friction observations (recent critical)
    const hotObs = db.prepare(`
      SELECT summary, tool, importance, created_at,
        REPLACE(REPLACE(project, '/Users/lord/Sites/', ''), '/Users/lord/Documents/Claude/Projects/', '') as project
      FROM observations
      WHERE importance >= 0.8 AND created_at >= date('now', '-' || ? || ' days') AND tool != 'git-commit'
      ORDER BY created_at DESC
      LIMIT 8
    `).all(days);

    res.json({ projects, hotObs });
  });

  // Time & focus: activity by hour, project switching, session lengths
  app.get('/api/insights/time', (req, res) => {
    const db = getDb();
    const days = safeInt(req.query.days, { min: 1, max: 90, def: 7 });

    // Activity by hour (hook observations only)
    const byHour = db.prepare(`
      SELECT CAST(strftime('%H', created_at) AS INTEGER) as hour, COUNT(*) as count
      FROM observations
      WHERE created_at >= date('now', '-' || ? || ' days') AND tool != 'git-commit'
      GROUP BY hour ORDER BY hour
    `).all(days);

    // Daily focus: which project dominated each day
    const dailyFocus = db.prepare(`
      SELECT
        date(created_at) as day,
        REPLACE(REPLACE(project, '/Users/lord/Sites/', ''), '/Users/lord/Documents/Claude/Projects/', '') as project,
        COUNT(*) as obs
      FROM observations
      WHERE created_at >= date('now', '-' || ? || ' days') AND tool != 'git-commit'
      GROUP BY day, project
      ORDER BY day, obs DESC
    `).all(days);

    // Aggregate: top project per day
    const focusMap = {};
    for (const r of dailyFocus) {
      if (!focusMap[r.day] || r.obs > focusMap[r.day].obs) {
        focusMap[r.day] = r;
      }
    }

    // Project context switches per day
    const switches = db.prepare(`
      SELECT date(created_at) as day,
             COUNT(DISTINCT project) as project_count
      FROM observations
      WHERE created_at >= date('now', '-' || ? || ' days') AND tool != 'git-commit'
      GROUP BY day ORDER BY day
    `).all(days);

    res.json({ byHour, dailyFocus: Object.values(focusMap), switches });
  });

  // Progress & trends: week-over-week comparison
  app.get('/api/insights/trends', (req, res) => {
    const db = getDb();

    // This week vs last week
    const thisWeek = db.prepare(`
      SELECT COUNT(*) as obs,
             COUNT(DISTINCT session_id) as sessions,
             COUNT(DISTINCT project) as projects,
             SUM(CASE WHEN importance >= 0.8 THEN 1 ELSE 0 END) as critical,
             ROUND(AVG(importance), 3) as avg_imp
      FROM observations
      WHERE created_at >= date('now', '-7 days') AND tool != 'git-commit'
    `).get();

    const lastWeek = db.prepare(`
      SELECT COUNT(*) as obs,
             COUNT(DISTINCT session_id) as sessions,
             COUNT(DISTINCT project) as projects,
             SUM(CASE WHEN importance >= 0.8 THEN 1 ELSE 0 END) as critical,
             ROUND(AVG(importance), 3) as avg_imp
      FROM observations
      WHERE created_at >= date('now', '-14 days') AND created_at < date('now', '-7 days') AND tool != 'git-commit'
    `).get();

    // Daily trend for sparkline
    const daily = db.prepare(`
      SELECT date(created_at) as day,
             COUNT(*) as obs,
             SUM(CASE WHEN importance >= 0.8 THEN 1 ELSE 0 END) as critical,
             ROUND(AVG(importance), 3) as avg_imp
      FROM observations
      WHERE created_at >= date('now', '-14 days') AND tool != 'git-commit'
      GROUP BY day ORDER BY day
    `).all();

    res.json({ thisWeek, lastWeek, daily });
  });

  // Recommendations: repeating patterns, automatable workflows
  app.get('/api/insights/recommendations', (req, res) => {
    const db = getDb();

    // Most repeated tool+tag combos (potential automation targets)
    const repeating = db.prepare(`
      SELECT tool, tags, COUNT(*) as count, ROUND(AVG(importance), 2) as avg_imp
      FROM observations
      WHERE created_at >= date('now', '-7 days') AND tool != 'git-commit' AND importance >= 0.3
      GROUP BY tool, tags
      HAVING count >= 3
      ORDER BY count DESC
      LIMIT 8
    `).all();

    // Most touched files/areas (from summaries mentioning file paths)
    const hotFiles = db.prepare(`
      SELECT summary, COUNT(*) as mentions
      FROM observations
      WHERE created_at >= date('now', '-7 days') AND tool IN ('Edit', 'Write', 'Read') AND importance >= 0.5
      GROUP BY summary
      HAVING mentions >= 2
      ORDER BY mentions DESC
      LIMIT 5
    `).all();

    // Sessions with high friction (many critical obs in single session)
    const hardSessions = db.prepare(`
      SELECT session_id,
        REPLACE(REPLACE(project, '/Users/lord/Sites/', ''), '/Users/lord/Documents/Claude/Projects/', '') as project,
        COUNT(*) as obs,
        SUM(CASE WHEN importance >= 0.8 THEN 1 ELSE 0 END) as critical,
        MIN(created_at) as started, MAX(created_at) as ended
      FROM observations
      WHERE created_at >= date('now', '-7 days') AND tool != 'git-commit'
      GROUP BY session_id
      HAVING critical >= 3
      ORDER BY critical DESC
      LIMIT 5
    `).all();

    res.json({ repeating, hotFiles, hardSessions });
  });

  // ─── Heatmap endpoint (#56) ─────────────────────────────────────────────

  app.get('/api/insights/heatmap', async (req, res) => {
    try {
      const { generateProjectHeatmap } = await import('../scripts/weekly-project-report.js');
      const days = safeInt(req.query.days, { min: 1, max: 90, def: 7 });
      res.json(generateProjectHeatmap({ days }));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Chart data endpoints (legacy, used by Details tab) ───────────────

  app.get('/api/charts/activity', (req, res) => {
    const db = getDb();
    const days = safeInt(req.query.days, { min: 1, max: 90, def: 30 });
    const rows = db.prepare(`
      SELECT date(created_at) as day,
             SUM(CASE WHEN tool = 'git-commit' THEN 1 ELSE 0 END) as git_commits,
             SUM(CASE WHEN tool != 'git-commit' THEN 1 ELSE 0 END) as hook_obs,
             COUNT(*) as total
      FROM observations
      WHERE created_at >= date('now', '-' || ? || ' days')
      GROUP BY day ORDER BY day
    `).all(days);
    res.json(rows);
  });

  app.get('/api/charts/tools', (req, res) => {
    const db = getDb();
    const rows = db.prepare(`
      SELECT tool, COUNT(*) as count, ROUND(AVG(importance), 2) as avg_importance
      FROM observations
      GROUP BY tool ORDER BY count DESC LIMIT 15
    `).all();
    res.json(rows);
  });

  app.get('/api/charts/importance', (req, res) => {
    const db = getDb();
    const rows = db.prepare(`
      SELECT
        CASE
          WHEN importance >= 0.8 THEN 'critical'
          WHEN importance >= 0.5 THEN 'medium'
          WHEN importance >= 0.1 THEN 'low'
          ELSE 'noise'
        END as level,
        COUNT(*) as count
      FROM observations
      GROUP BY level
    `).all();
    res.json(rows);
  });

  app.get('/api/charts/projects', (req, res) => {
    const db = getDb();
    const rows = db.prepare(`
      SELECT
        REPLACE(project, '/Users/lord/Sites/', '~/') as project,
        COUNT(*) as obs_count,
        ROUND(AVG(importance), 2) as avg_importance,
        COUNT(DISTINCT session_id) as sessions,
        MAX(created_at) as last_activity
      FROM observations
      GROUP BY project ORDER BY obs_count DESC LIMIT 10
    `).all();
    res.json(rows);
  });

  app.get('/api/search', async (req, res) => {
    const query = safeStr(req.query.query, 200);
    const project = safeStr(req.query.project);
    if (!query) return res.status(400).json({ error: 'query required' });
    try {
      const { hybridSearch } = await import('./search.js');
      const results = await hybridSearch(query, project || process.cwd(), { limit: 20 });
      res.json(results);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Share token management (localhost-only) (#33) ────────────────────

  /** POST /api/share — create a new share link */
  app.post('/api/share', (req, res) => {
    const { project, label, ttlDays } = req.body || {};
    const ttl = safeInt(ttlDays, { min: 1, max: 365, def: 7 });
    const result = createShareToken({
      project: project ? safeStr(project) : null,
      label: safeStr(label || '', 100) || '',
      ttlDays: ttl,
    });
    res.json(result);
  });

  /** GET /api/share — list active share tokens */
  app.get('/api/share', (req, res) => {
    res.json(listShareTokens());
  });

  /** DELETE /api/share/:token — revoke a token */
  app.delete('/api/share/:token', (req, res) => {
    const revoked = revokeShareToken(req.params.token);
    res.json({ revoked });
  });

  // ─── Shared read-only viewer (#33) ─────────────────────────────────────

  /** Middleware: validate share token and attach to req.shareToken */
  function requireShareToken(req, res, next) {
    const tokenVal = req.params.token;
    if (!tokenVal || !/^[0-9a-f]{32}$/.test(tokenVal)) {
      return res.status(400).json({ error: 'Invalid token format' });
    }
    const tok = getShareToken(tokenVal);
    if (!tok) return res.status(401).json({ error: 'Invalid or expired share link' });
    req.shareToken = tok;
    next();
  }

  /** GET /shared/:token — read-only dashboard viewer page */
  app.get('/shared/:token', requireShareToken, (req, res) => {
    res.send(sharedViewerHTML(req.shareToken));
  });

  /** GET /shared/:token/api/stats — aggregate stats (no raw data) */
  app.get('/shared/:token/api/stats', requireShareToken, (req, res) => {
    const db = getDb();
    const tok = req.shareToken;
    const projectFilter = tok.project ? 'WHERE project = ?' : '';
    const params = tok.project ? [tok.project] : [];

    const totalObs = db.prepare(`SELECT COUNT(*) as n FROM observations ${projectFilter}`).get(...params).n;
    const totalSessions = db.prepare(`SELECT COUNT(*) as n FROM sessions ${tok.project ? 'WHERE project = ?' : ''}`).get(...params).n;
    const projectCount = db.prepare(`SELECT COUNT(DISTINCT project) as n FROM observations ${projectFilter}`).get(...params).n;
    const recentActivity = db.prepare(`
      SELECT date(created_at) as day, COUNT(*) as n
      FROM observations
      WHERE created_at >= date('now', '-30 days') ${tok.project ? 'AND project = ?' : ''}
      GROUP BY day ORDER BY day DESC
    `).all(...params);

    res.json({ totalObs, totalSessions, projectCount, recentActivity, label: tok.label, expiresAt: tok.expires_at });
  });

  /** GET /shared/:token/api/trends — weekly trends */
  app.get('/shared/:token/api/trends', requireShareToken, (req, res) => {
    const db = getDb();
    const tok = req.shareToken;
    const pf = tok.project ? 'AND project = ?' : '';
    const params = tok.project ? [tok.project] : [];

    const thisWeek = db.prepare(`
      SELECT COUNT(*) as obs, COUNT(DISTINCT session_id) as sessions,
             SUM(CASE WHEN importance >= 0.8 THEN 1 ELSE 0 END) as critical,
             ROUND(AVG(importance), 3) as avg_imp
      FROM observations WHERE created_at >= date('now', '-7 days') AND tool != 'git-commit' ${pf}
    `).get(...params);

    const lastWeek = db.prepare(`
      SELECT COUNT(*) as obs, COUNT(DISTINCT session_id) as sessions,
             SUM(CASE WHEN importance >= 0.8 THEN 1 ELSE 0 END) as critical,
             ROUND(AVG(importance), 3) as avg_imp
      FROM observations WHERE created_at >= date('now', '-14 days') AND created_at < date('now', '-7 days') AND tool != 'git-commit' ${pf}
    `).get(...params);

    const daily = db.prepare(`
      SELECT date(created_at) as day, COUNT(*) as obs,
             ROUND(AVG(importance), 3) as avg_imp
      FROM observations WHERE created_at >= date('now', '-14 days') AND tool != 'git-commit' ${pf}
      GROUP BY day ORDER BY day
    `).all(...params);

    const tools = db.prepare(`
      SELECT tool, COUNT(*) as count
      FROM observations WHERE tool != 'git-commit' ${pf}
      GROUP BY tool ORDER BY count DESC LIMIT 8
    `).all(...params);

    res.json({ thisWeek, lastWeek, daily, tools });
  });

  /** GET /shared/:token/api/sessions — session list (no raw obs) */
  app.get('/shared/:token/api/sessions', requireShareToken, (req, res) => {
    const db = getDb();
    const tok = req.shareToken;
    const pf = tok.project ? 'AND s.project = ?' : '';
    const params = tok.project ? [tok.project] : [];

    const sessions = db.prepare(`
      SELECT s.id, s.project, s.started_at, s.ended_at, s.summary,
             COUNT(o.id) as obs_count,
             ROUND(AVG(o.importance), 2) as avg_imp
      FROM sessions s
      LEFT JOIN observations o ON o.session_id = s.id
      WHERE 1=1 ${pf}
      GROUP BY s.id
      ORDER BY s.started_at DESC
      LIMIT 30
    `).all(...params);
    res.json(sessions);
  });

  // ─── Global error handler (#70) ────────────────────────────────────────
  app.use((err, req, res, _next) => {
    console.error('[server] Unhandled error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  });

  // ─── Viewer UI ────────────────────────────────────────────────────────
  app.get('/', (req, res) => {
    res.send(viewerHTML());
  });

  // Listen on all interfaces so /shared/:token/* is reachable remotely (#33)
  app.listen(port, '0.0.0.0', () => {
    console.log(`[mem:viewer] http://localhost:${port}`);
  });

  return app;
}

function viewerHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Claudeye Dashboard</title>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0d1117; color: #c9d1d9; }
    header { background: #161b22; border-bottom: 1px solid #30363d; padding: 16px 24px; display: flex; align-items: center; gap: 16px; }
    header h1 { font-size: 18px; font-weight: 600; color: #f0f6fc; }
    .header-right { display: flex; gap: 24px; margin-left: auto; font-size: 13px; color: #8b949e; align-items: center; }
    .header-right span.v { color: #58a6ff; font-weight: 600; }
    .tabs { display: flex; gap: 0; background: #161b22; border-bottom: 1px solid #30363d; padding: 0 24px; }
    .tab { padding: 12px 20px; cursor: pointer; font-size: 14px; color: #8b949e; border-bottom: 2px solid transparent; transition: all .15s; }
    .tab:hover { color: #c9d1d9; }
    .tab.active { color: #f0f6fc; border-bottom-color: #f78166; }
    main { max-width: 1200px; margin: 0 auto; padding: 24px; }
    .view { display: none; }
    .view.active { display: block; }

    /* ─── Insight cards ─── */
    .section-title { font-size: 13px; text-transform: uppercase; letter-spacing: 1px; color: #6e7681; margin: 24px 0 12px; }
    .section-title:first-child { margin-top: 0; }
    .insight-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    .insight-card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 20px; }
    .insight-card.wide { grid-column: 1 / -1; }
    .insight-card h3 { font-size: 15px; color: #e6edf3; margin-bottom: 14px; font-weight: 600; }
    .insight-card h3 .icon { margin-right: 6px; }

    /* Trend KPIs */
    .trend-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 20px; }
    .trend-kpi { background: #0d1117; border: 1px solid #30363d; border-radius: 8px; padding: 16px; text-align: center; }
    .trend-kpi .val { font-size: 24px; font-weight: 700; color: #f0f6fc; }
    .trend-kpi .lbl { font-size: 11px; color: #8b949e; margin-top: 2px; }
    .trend-kpi .delta { font-size: 12px; margin-top: 4px; }
    .delta.up { color: #3fb950; }
    .delta.down { color: #f85149; }
    .delta.neutral { color: #8b949e; }

    /* Friction table */
    .f-table { width: 100%; border-collapse: collapse; font-size: 13px; }
    .f-table th { text-align: left; color: #8b949e; font-weight: 500; padding: 6px 8px; border-bottom: 1px solid #30363d; }
    .f-table td { padding: 8px; border-bottom: 1px solid #21262d; color: #c9d1d9; }
    .f-table tr:hover td { background: #0d1117; }
    .bar-cell { position: relative; }
    .bar-fill { height: 6px; border-radius: 3px; background: #f85149; }

    /* Hour heatmap */
    .hour-grid { display: flex; gap: 2px; flex-wrap: wrap; }
    .hour-cell { width: 36px; height: 36px; border-radius: 4px; display: flex; align-items: center; justify-content: center; font-size: 10px; color: #8b949e; }

    /* Recommendations */
    .rec-item { padding: 10px 0; border-bottom: 1px solid #21262d; }
    .rec-item:last-child { border-bottom: none; }
    .rec-label { font-size: 13px; color: #e6edf3; }
    .rec-meta { font-size: 12px; color: #6e7681; margin-top: 2px; }
    .rec-badge { display: inline-block; background: #0d419d; color: #58a6ff; border-radius: 4px; padding: 1px 6px; font-size: 11px; font-weight: 600; margin-right: 6px; }

    /* Focus timeline */
    .focus-row { display: flex; gap: 4px; align-items: center; padding: 4px 0; font-size: 13px; }
    .focus-day { width: 50px; color: #6e7681; flex-shrink: 0; }
    .focus-bar { height: 22px; border-radius: 4px; display: flex; align-items: center; padding: 0 8px; font-size: 11px; color: #f0f6fc; font-weight: 600; }
    .focus-switches { font-size: 11px; color: #8b949e; margin-left: 8px; }

    /* Hot observations */
    .hot-obs { padding: 8px 0; border-bottom: 1px solid #21262d; font-size: 13px; }
    .hot-obs:last-child { border-bottom: none; }
    .hot-obs .ho-proj { color: #58a6ff; font-weight: 600; font-size: 12px; }
    .hot-obs .ho-text { color: #c9d1d9; margin-top: 2px; line-height: 1.4; }
    .hot-obs .ho-time { color: #6e7681; font-size: 11px; }

    /* ─── Legacy charts + observations ─── */
    .charts-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
    .chart-card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 20px; }
    .chart-card h3 { font-size: 14px; color: #8b949e; margin-bottom: 16px; font-weight: 500; }
    .chart-card.wide { grid-column: 1 / -1; }

    .search-bar { display: flex; gap: 8px; margin-bottom: 24px; flex-wrap: wrap; }
    input, select { background: #161b22; border: 1px solid #30363d; color: #c9d1d9; border-radius: 6px; padding: 8px 12px; font-size: 14px; }
    input { flex: 1; min-width: 200px; }
    input:focus, select:focus { outline: none; border-color: #58a6ff; }
    button { background: #238636; color: #fff; border: none; border-radius: 6px; padding: 8px 16px; cursor: pointer; font-size: 14px; }
    button:hover { background: #2ea043; }
    .obs-list { display: flex; flex-direction: column; gap: 8px; }
    .obs { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 14px 16px; cursor: pointer; transition: border-color .15s; }
    .obs:hover { border-color: #58a6ff; }
    .obs-header { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
    .tool-badge { background: #0d419d; color: #58a6ff; border-radius: 4px; padding: 2px 7px; font-size: 12px; font-weight: 600; }
    .imp { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
    .imp-high { background: #f85149; } .imp-med { background: #e3b341; } .imp-low { background: #3fb950; }
    .obs-summary { font-size: 14px; line-height: 1.5; color: #e6edf3; }
    .tags { margin-top: 8px; display: flex; gap: 4px; flex-wrap: wrap; }
    .tag { background: #21262d; color: #8b949e; border-radius: 4px; padding: 2px 8px; font-size: 12px; }
    .meta { margin-top: 6px; font-size: 12px; color: #6e7681; }
    .empty { text-align: center; padding: 60px; color: #6e7681; }
    .pagination { display: flex; gap: 8px; justify-content: center; margin-top: 24px; }
    .btn-page { background: #21262d; }

    @media (max-width: 768px) {
      .insight-grid, .charts-grid { grid-template-columns: 1fr; }
      .trend-row { grid-template-columns: repeat(2, 1fr); }
      .search-bar { flex-direction: column; }
      input { min-width: 100%; }
    }
  </style>
</head>
<body>
  <header>
    <h1>Claudeye</h1>
    <div class="header-right" id="header-stats">Loading...</div>
  </header>
  <div class="tabs">
    <div class="tab active" data-view="insights" onclick="switchTab(this)">Insights</div>
    <div class="tab" data-view="observations" onclick="switchTab(this)">Observations</div>
    <div class="tab" data-view="details" onclick="switchTab(this)">Details</div>
  </div>
  <main>
    <!-- ═══ Insights view ═══ -->
    <div id="view-insights" class="view active">
      <div class="section-title">This week vs last week</div>
      <div class="trend-row" id="trend-row"></div>

      <div class="insight-grid">
        <!-- Friction hotspots -->
        <div class="insight-card">
          <h3><span class="icon">!!</span> Friction Hotspots</h3>
          <div id="friction-table"></div>
        </div>

        <!-- Time & focus -->
        <div class="insight-card">
          <h3><span class="icon">~</span> Time &amp; Focus</h3>
          <canvas id="chart-hours" height="160"></canvas>
          <div id="focus-timeline" style="margin-top:16px"></div>
        </div>

        <!-- Recommendations -->
        <div class="insight-card">
          <h3><span class="icon">&gt;</span> Recommendations</h3>
          <div id="recommendations"></div>
        </div>

        <!-- Recent critical observations -->
        <div class="insight-card">
          <h3><span class="icon">*</span> Recent Critical Events</h3>
          <div id="hot-observations"></div>
        </div>

        <!-- Trend sparkline -->
        <div class="insight-card wide">
          <h3>14-Day Activity Trend</h3>
          <canvas id="chart-trend" height="50"></canvas>
        </div>
      </div>
    </div>

    <!-- ═══ Observations view ═══ -->
    <div id="view-observations" class="view">
      <div class="search-bar">
        <input id="search" type="text" placeholder="Search observations..." onkeydown="if(event.key==='Enter')doSearch()">
        <select id="project-filter"><option value="">All projects</option></select>
        <button onclick="doSearch()">Search</button>
        <button onclick="loadRecent()" style="background:#21262d">Recent</button>
      </div>
      <div class="obs-list" id="list"></div>
      <div class="pagination" id="pagination"></div>
    </div>

    <!-- ═══ Details view (legacy charts) ═══ -->
    <div id="view-details" class="view">
      <div class="charts-grid">
        <div class="chart-card wide">
          <h3>Daily Activity (last 30 days)</h3>
          <canvas id="chart-activity" height="80"></canvas>
        </div>
        <div class="chart-card"><h3>Tools Distribution</h3><canvas id="chart-tools"></canvas></div>
        <div class="chart-card"><h3>Importance Levels</h3><canvas id="chart-importance"></canvas></div>
        <div class="chart-card wide"><h3>Projects Overview</h3><canvas id="chart-projects" height="60"></canvas></div>
      </div>
    </div>
  </main>
<script>
// ─── Tab switching ─────────────────────────────────────────────
function switchTab(el) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  el.classList.add('active');
  const view = el.dataset.view;
  document.getElementById('view-' + view).classList.add('active');
  if (view === 'details' && !window._detailsLoaded) { loadDetails(); window._detailsLoaded = true; }
  if (view === 'observations' && !window._obsLoaded) { loadRecent(); window._obsLoaded = true; }
}

Chart.defaults.color = '#8b949e';
Chart.defaults.borderColor = '#30363d';
Chart.defaults.font.family = '-apple-system, BlinkMacSystemFont, sans-serif';

function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function delta(cur, prev, inverse) {
  if (!prev) return '<span class="delta neutral">--</span>';
  const pct = prev === 0 ? 0 : Math.round((cur - prev) / prev * 100);
  const arrow = pct > 0 ? '+' : '';
  let cls = 'neutral';
  if (pct > 5) cls = inverse ? 'down' : 'up';
  if (pct < -5) cls = inverse ? 'up' : 'down';
  return '<span class="delta ' + cls + '">' + arrow + pct + '%</span>';
}

const projColors = ['#58a6ff','#f78166','#3fb950','#d2a8ff','#e3b341','#f85149','#79c0ff','#a5d6ff','#ff7b72','#7ee787'];

// ─── Load insights ──────────────────────────────────────────────
async function loadInsights() {
  const [trends, friction, time, recs, stats] = await Promise.all([
    fetch('/api/insights/trends').then(r => r.json()),
    fetch('/api/insights/friction').then(r => r.json()),
    fetch('/api/insights/time').then(r => r.json()),
    fetch('/api/insights/recommendations').then(r => r.json()),
    fetch('/api/stats').then(r => r.json()),
  ]);

  // Header stats
  document.getElementById('header-stats').innerHTML =
    '<span class="v">' + stats.totalObservations + '</span> obs &nbsp; ' +
    '<span class="v">' + stats.totalSessions + '</span> sessions &nbsp; ' +
    '<span class="v">' + stats.projects.length + '</span> projects';

  // Project filter
  const sel = document.getElementById('project-filter');
  for (const p of stats.projects) {
    const opt = document.createElement('option');
    opt.value = p.project;
    opt.text = p.project.split('/').pop() + ' (' + p.n + ')';
    sel.appendChild(opt);
  }

  // ── Trend KPIs ──
  const tw = trends.thisWeek, lw = trends.lastWeek;
  document.getElementById('trend-row').innerHTML = [
    { val: tw.obs, lbl: 'Observations', prev: lw.obs, inv: false },
    { val: tw.sessions, lbl: 'Sessions', prev: lw.sessions, inv: false },
    { val: tw.critical, lbl: 'Critical Events', prev: lw.critical, inv: true },
    { val: tw.projects, lbl: 'Active Projects', prev: lw.projects, inv: false },
  ].map(k => '<div class="trend-kpi"><div class="val">' + k.val +
    '</div><div class="lbl">' + k.lbl + '</div>' + delta(k.val, k.prev, k.inv) + '</div>').join('');

  // ── Friction table ──
  const maxErr = Math.max(...friction.projects.map(p => p.error_pct), 1);
  document.getElementById('friction-table').innerHTML = friction.projects.length
    ? '<table class="f-table"><tr><th>Project</th><th>Obs</th><th>Error %</th><th></th></tr>' +
      friction.projects.map(p =>
        '<tr><td>' + esc(p.project.split('/').pop()) + '</td><td>' + p.total_obs +
        '</td><td style="color:' + (p.error_pct > 20 ? '#f85149' : p.error_pct > 10 ? '#e3b341' : '#3fb950') + '">' +
        p.error_pct + '%</td><td class="bar-cell"><div class="bar-fill" style="width:' +
        Math.round(p.error_pct / maxErr * 100) + '%"></div></td></tr>'
      ).join('') + '</table>'
    : '<div class="empty" style="padding:20px">No friction data yet</div>';

  // ── Hot observations ──
  document.getElementById('hot-observations').innerHTML = friction.hotObs.length
    ? friction.hotObs.map(o =>
        '<div class="hot-obs"><span class="ho-proj">' + esc(o.project.split('/').pop()) +
        '</span> <span class="ho-time">' + (o.created_at||'').slice(5,16) + '</span>' +
        '<div class="ho-text">' + esc(o.summary.slice(0, 160)) + '</div></div>'
      ).join('')
    : '<div class="empty" style="padding:20px">No critical events this week</div>';

  // ── Hours chart ──
  const hours = Array(24).fill(0);
  time.byHour.forEach(h => hours[h.hour] = h.count);
  new Chart(document.getElementById('chart-hours'), {
    type: 'bar',
    data: {
      labels: hours.map((_, i) => i + 'h'),
      datasets: [{
        data: hours,
        backgroundColor: hours.map(v => {
          const max = Math.max(...hours);
          const pct = max ? v / max : 0;
          return 'rgba(88,166,255,' + (0.15 + pct * 0.85).toFixed(2) + ')';
        }),
        borderRadius: 2
      }]
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false }, tooltip: { callbacks: { title: (c) => c[0].label, label: (c) => c.raw + ' observations' } } },
      scales: { y: { display: false }, x: { grid: { display: false } } }
    }
  });

  // ── Focus timeline ──
  document.getElementById('focus-timeline').innerHTML = '<div style="font-size:12px;color:#6e7681;margin-bottom:6px">Daily focus</div>' +
    time.dailyFocus.map((d, i) => {
      const sw = time.switches.find(s => s.day === d.day);
      const swCount = sw ? sw.project_count : 1;
      return '<div class="focus-row"><span class="focus-day">' + d.day.slice(5) +
        '</span><div class="focus-bar" style="width:' + Math.min(200, d.obs * 2) + 'px;background:' + projColors[i % projColors.length] + '">' +
        esc(d.project.split('/').pop()) + '</div>' +
        (swCount > 1 ? '<span class="focus-switches">' + swCount + ' projects</span>' : '') + '</div>';
    }).join('');

  // ── Recommendations ──
  const recEl = document.getElementById('recommendations');
  let recHtml = '';

  // Repeating patterns
  if (recs.repeating.length) {
    recHtml += recs.repeating.slice(0, 4).map(r => {
      const tags = JSON.parse(r.tags || '[]').slice(0, 3).join(', ');
      return '<div class="rec-item"><span class="rec-badge">' + r.count + 'x</span>' +
        '<span class="rec-label">' + esc(r.tool) + (tags ? ' [' + esc(tags) + ']' : '') +
        '</span><div class="rec-meta">avg importance ' + r.avg_imp + ' — potential automation target</div></div>';
    }).join('');
  }

  // Hard sessions
  if (recs.hardSessions.length) {
    recHtml += '<div style="margin-top:12px;font-size:12px;color:#6e7681;margin-bottom:4px">High-friction sessions</div>';
    recHtml += recs.hardSessions.slice(0, 3).map(s =>
      '<div class="rec-item"><span class="rec-badge" style="background:#3d1116;color:#f85149">' + s.critical + ' errors</span>' +
      '<span class="rec-label">' + esc(s.project.split('/').pop()) + '</span>' +
      '<div class="rec-meta">' + s.obs + ' total obs, ' + (s.started||'').slice(5,16) + '</div></div>'
    ).join('');
  }

  recEl.innerHTML = recHtml || '<div class="empty" style="padding:20px">Collecting patterns...</div>';

  // ── 14-day trend sparkline ──
  new Chart(document.getElementById('chart-trend'), {
    type: 'line',
    data: {
      labels: trends.daily.map(d => d.day.slice(5)),
      datasets: [
        { label: 'Observations', data: trends.daily.map(d => d.obs), borderColor: '#58a6ff', backgroundColor: 'rgba(88,166,255,0.1)', fill: true, tension: 0.3, pointRadius: 3 },
        { label: 'Critical', data: trends.daily.map(d => d.critical), borderColor: '#f85149', backgroundColor: 'rgba(248,81,73,0.1)', fill: true, tension: 0.3, pointRadius: 3 },
      ]
    },
    options: { responsive: true, plugins: { legend: { position: 'top' } }, scales: { y: { beginAtZero: true } } }
  });
}

// ─── Details tab (legacy charts) ──────────────────────────────────
async function loadDetails() {
  const [activity, tools, importance, projects] = await Promise.all([
    fetch('/api/charts/activity?days=30').then(r => r.json()),
    fetch('/api/charts/tools').then(r => r.json()),
    fetch('/api/charts/importance').then(r => r.json()),
    fetch('/api/charts/projects').then(r => r.json()),
  ]);
  new Chart(document.getElementById('chart-activity'), {
    type: 'bar', data: { labels: activity.map(d => d.day.slice(5)), datasets: [
      { label: 'Hook', data: activity.map(d => d.hook_obs), backgroundColor: '#58a6ff', borderRadius: 3 },
      { label: 'Git', data: activity.map(d => d.git_commits), backgroundColor: '#3fb950', borderRadius: 3 },
    ]}, options: { responsive: true, scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true } }, plugins: { legend: { position: 'top' } } }
  });
  const tc = ['#58a6ff','#f78166','#3fb950','#d2a8ff','#e3b341','#f85149','#79c0ff','#a5d6ff'];
  new Chart(document.getElementById('chart-tools'), {
    type: 'doughnut', data: { labels: tools.slice(0,8).map(t=>t.tool), datasets: [{ data: tools.slice(0,8).map(t=>t.count), backgroundColor: tc }] },
    options: { responsive: true, plugins: { legend: { position: 'right', labels: { boxWidth: 12 } } } }
  });
  const ic = { critical:'#f85149', medium:'#e3b341', low:'#3fb950', noise:'#484f58' };
  new Chart(document.getElementById('chart-importance'), {
    type: 'doughnut', data: { labels: importance.map(i=>i.level), datasets: [{ data: importance.map(i=>i.count), backgroundColor: importance.map(i=>ic[i.level]||'#58a6ff') }] },
    options: { responsive: true, plugins: { legend: { position: 'right', labels: { boxWidth: 12 } } } }
  });
  new Chart(document.getElementById('chart-projects'), {
    type: 'bar', data: { labels: projects.map(p=>p.project.split('/').pop()), datasets: [{ label: 'Observations', data: projects.map(p=>p.obs_count), backgroundColor: '#58a6ff', borderRadius: 3 }] },
    options: { responsive: true, indexAxis: 'y', plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true } } }
  });
}

// ─── Observations tab ──────────────────────────────────────────
let offset = 0, total = 0, project = '';
const LIMIT = 30;

async function loadRecent(off = 0) {
  project = document.getElementById('project-filter').value;
  const url = '/api/observations?limit=' + LIMIT + '&offset=' + off + (project ? '&project=' + encodeURIComponent(project) : '');
  const data = await fetch(url).then(r => r.json());
  renderList(data.rows); total = data.total; offset = off; renderPagination();
}
async function doSearch() {
  const q = document.getElementById('search').value.trim();
  project = document.getElementById('project-filter').value;
  if (!q) return loadRecent();
  const url = '/api/search?query=' + encodeURIComponent(q) + (project ? '&project=' + encodeURIComponent(project) : '');
  const data = await fetch(url).then(r => r.json());
  renderList(data); document.getElementById('pagination').innerHTML = '';
}
function renderList(rows) {
  const el = document.getElementById('list');
  if (!rows.length) { el.innerHTML = '<div class="empty">No observations found.</div>'; return; }
  el.innerHTML = rows.map(obs => {
    const imp = obs.importance >= 0.8 ? 'high' : obs.importance >= 0.5 ? 'med' : 'low';
    const tags = JSON.parse(obs.tags || '[]');
    const proj = (obs.project || '').split('/').pop();
    return '<div class="obs"><div class="obs-header"><div class="imp imp-' + imp + '"></div>' +
      '<span class="tool-badge">' + obs.tool + '</span>' +
      '<span style="font-size:12px;color:#6e7681">' + proj + '</span></div>' +
      '<div class="obs-summary">' + esc(obs.summary) + '</div>' +
      (tags.length ? '<div class="tags">' + tags.map(t => '<span class="tag">#' + esc(t) + '</span>').join('') + '</div>' : '') +
      '<div class="meta">' + (obs.created_at || '') + '</div></div>';
  }).join('');
}
function renderPagination() {
  const el = document.getElementById('pagination');
  const pages = Math.ceil(total / LIMIT), cur = Math.floor(offset / LIMIT);
  if (pages <= 1) { el.innerHTML = ''; return; }
  let html = '';
  const start = Math.max(0, cur-3), end = Math.min(pages, cur+4);
  if (start > 0) html += '<button class="btn-page" onclick="loadRecent(0)">1</button><span style="color:#6e7681">...</span>';
  for (let i = start; i < end; i++) {
    html += '<button class="btn-page" style="' + (i===cur?'background:#0d419d':'') + '" onclick="loadRecent(' + (i*LIMIT) + ')">' + (i+1) + '</button>';
  }
  if (end < pages) html += '<span style="color:#6e7681">...</span><button class="btn-page" onclick="loadRecent(' + ((pages-1)*LIMIT) + ')">' + pages + '</button>';
  el.innerHTML = html;
}

// ─── Init ──────────────────────────────────────────────────────
loadInsights();
</script>
</body>
</html>`;
}

// ─── Shared read-only viewer HTML (#33) ─────────────────────────────────────

function sharedViewerHTML(tok) {
  const label = tok.label ? esc2(tok.label) : 'Claudeye';
  const expires = tok.expires_at ? tok.expires_at.slice(0, 10) : '';
  const base = `/shared/${tok.token}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${label} — Claudeye (shared)</title>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0d1117; color: #c9d1d9; }
    header { background: #161b22; border-bottom: 1px solid #30363d; padding: 16px 24px; display: flex; align-items: center; gap: 16px; }
    header h1 { font-size: 18px; font-weight: 600; color: #f0f6fc; }
    .badge { background: #0d419d; color: #58a6ff; border-radius: 4px; padding: 2px 8px; font-size: 12px; font-weight: 600; }
    .expiry { font-size: 12px; color: #8b949e; margin-left: auto; }
    main { max-width: 1100px; margin: 0 auto; padding: 24px; }
    .kpi-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-bottom: 24px; }
    .kpi { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 20px; text-align: center; }
    .kpi .val { font-size: 32px; font-weight: 700; color: #f0f6fc; }
    .kpi .lbl { font-size: 12px; color: #8b949e; margin-top: 4px; }
    .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 24px; }
    .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 20px; }
    .card.wide { grid-column: 1 / -1; }
    .card h3 { font-size: 14px; color: #8b949e; margin-bottom: 16px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.5px; }
    .trend-kpi { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
    .tkpi { text-align: center; }
    .tkpi .v { font-size: 22px; font-weight: 700; color: #f0f6fc; }
    .tkpi .l { font-size: 11px; color: #8b949e; margin-top: 2px; }
    .tkpi .d { font-size: 12px; margin-top: 3px; }
    .up { color: #3fb950; } .dn { color: #f85149; } .ne { color: #8b949e; }
    .sess-item { padding: 10px 0; border-bottom: 1px solid #21262d; font-size: 13px; }
    .sess-item:last-child { border-bottom: none; }
    .sess-proj { color: #58a6ff; font-weight: 600; font-size: 12px; }
    .sess-sum { color: #c9d1d9; margin-top: 3px; line-height: 1.4; }
    .sess-meta { color: #6e7681; font-size: 11px; margin-top: 2px; }
    .bar { display: flex; gap: 4px; align-items: center; margin-bottom: 6px; font-size: 12px; }
    .bar-label { width: 100px; color: #8b949e; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .bar-fill { height: 14px; border-radius: 3px; background: #1f6feb; min-width: 2px; }
    .bar-count { color: #6e7681; margin-left: 4px; }
    .readonly-badge { font-size: 11px; background: #161b22; border: 1px solid #30363d; color: #6e7681; border-radius: 4px; padding: 2px 8px; }
    @media (max-width: 768px) { .kpi-row, .grid2, .trend-kpi { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
<header>
  <h1>${label}</h1>
  <span class="badge">read-only</span>
  ${expires ? `<span class="expiry">Expires ${expires}</span>` : ''}
</header>
<main>
  <div class="kpi-row" id="kpi-row"><div class="kpi"><div class="val">…</div><div class="lbl">Loading</div></div></div>
  <div class="grid2">
    <div class="card">
      <h3>This week vs last week</h3>
      <div class="trend-kpi" id="trend-kpi"></div>
    </div>
    <div class="card">
      <h3>Top tools</h3>
      <div id="tools-bars"></div>
    </div>
    <div class="card wide">
      <h3>Daily activity (14 days)</h3>
      <canvas id="activity-chart" height="80"></canvas>
    </div>
    <div class="card wide">
      <h3>Recent sessions</h3>
      <div id="sessions-list"></div>
    </div>
  </div>
</main>
<script>
const BASE = '${base}';
function esc(s) { const d = document.createElement('div'); d.textContent = String(s||''); return d.innerHTML; }
function fmt(n) { return n >= 1000 ? (n/1000).toFixed(1)+'k' : String(n||0); }
function delta(a, b, lbl) {
  if (b === 0) return '<span class="ne">—</span>';
  const d = ((a-b)/b*100).toFixed(0);
  const cls = a >= b ? 'up' : 'dn';
  const sign = a >= b ? '+' : '';
  return '<span class="'+cls+'">'+sign+d+'% '+lbl+'</span>';
}

async function loadAll() {
  const [stats, trends, sessions] = await Promise.all([
    fetch(BASE+'/api/stats').then(r=>r.json()),
    fetch(BASE+'/api/trends').then(r=>r.json()),
    fetch(BASE+'/api/sessions').then(r=>r.json()),
  ]);

  // KPIs
  document.getElementById('kpi-row').innerHTML = [
    { val: fmt(stats.totalObs), lbl: 'Observations' },
    { val: fmt(stats.totalSessions), lbl: 'Sessions' },
    { val: fmt(stats.projectCount), lbl: 'Projects' },
  ].map(k => '<div class="kpi"><div class="val">'+k.val+'</div><div class="lbl">'+k.lbl+'</div></div>').join('');

  // Trends
  const tw = trends.thisWeek || {}, lw = trends.lastWeek || {};
  document.getElementById('trend-kpi').innerHTML = [
    { v: fmt(tw.obs||0),      l: 'Observations', d: delta(tw.obs, lw.obs, 'w/w') },
    { v: fmt(tw.sessions||0), l: 'Sessions',     d: delta(tw.sessions, lw.sessions, 'w/w') },
    { v: fmt(tw.critical||0), l: 'Critical obs', d: delta(tw.critical, lw.critical, 'w/w') },
    { v: ((tw.avg_imp||0)*100).toFixed(0)+'%', l: 'Avg importance', d: '' },
  ].map(k => '<div class="tkpi"><div class="v">'+k.v+'</div><div class="l">'+k.l+'</div>'+(k.d?'<div class="d">'+k.d+'</div>':'')+'</div>').join('');

  // Tools bars
  const toolsMax = Math.max(...(trends.tools||[]).map(t=>t.count), 1);
  document.getElementById('tools-bars').innerHTML = (trends.tools||[]).map(t =>
    '<div class="bar"><span class="bar-label" title="'+esc(t.tool)+'">'+esc(t.tool)+'</span>' +
    '<div class="bar-fill" style="width:'+Math.round(t.count/toolsMax*200)+'px"></div>' +
    '<span class="bar-count">'+fmt(t.count)+'</span></div>'
  ).join('');

  // Activity chart
  const days = (trends.daily||[]);
  if (days.length) {
    new Chart(document.getElementById('activity-chart'), {
      type: 'bar',
      data: {
        labels: days.map(d => d.day.slice(5)),
        datasets: [{ label: 'Observations', data: days.map(d=>d.obs), backgroundColor: '#1f6feb', borderRadius: 3 }]
      },
      options: { responsive: true, plugins: { legend: { display: false } },
        scales: { x: { ticks: { color: '#6e7681' }, grid: { color: '#21262d' } },
                  y: { ticks: { color: '#6e7681' }, grid: { color: '#21262d' } } } }
    });
  }

  // Sessions
  document.getElementById('sessions-list').innerHTML = sessions.length
    ? sessions.map(s => {
        const proj = (s.project||'').split('/').pop();
        const started = (s.started_at||'').slice(0,16).replace('T',' ');
        return '<div class="sess-item">' +
          '<div class="sess-proj">'+esc(proj)+'</div>' +
          (s.summary ? '<div class="sess-sum">'+esc(s.summary)+'</div>' : '') +
          '<div class="sess-meta">'+started+' · '+fmt(s.obs_count)+' obs</div>' +
          '</div>';
      }).join('')
    : '<div style="color:#6e7681;padding:20px 0">No sessions found.</div>';
}
loadAll().catch(e => console.error(e));
</script>
</body>
</html>`;
}

// Simple HTML-escape helper (not in module scope)
function esc2(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
