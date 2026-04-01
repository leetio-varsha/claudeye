/**
 * src/server.js — Minimal web viewer API
 * Serves the viewer UI + REST endpoints for browsing observations.
 * Localhost only. No auth needed (personal tool, local only).
 */

import express from 'express';
import { join } from 'path';
import { getDb, getStats } from './db.js';

const __dir = new URL('.', import.meta.url).pathname;

export function createServer(port = 47777) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // Only accept localhost connections
  app.use((req, res, next) => {
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
    const project = req.query.project;
    const limit   = Math.min(200, parseInt(req.query.limit) || 50);
    const offset  = parseInt(req.query.offset) || 0;

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

  // ─── Chart data endpoints ─────────────────────────────────────────────

  app.get('/api/charts/activity', (req, res) => {
    const db = getDb();
    const days = Math.min(90, parseInt(req.query.days) || 30);
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
    const { query, project } = req.query;
    if (!query) return res.status(400).json({ error: 'query required' });
    try {
      const { hybridSearch } = await import('./search.js');
      const results = await hybridSearch(query, project || process.cwd(), { limit: 20 });
      res.json(results);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Viewer UI ────────────────────────────────────────────────────────
  app.get('/', (req, res) => {
    res.send(viewerHTML());
  });

  app.listen(port, '127.0.0.1', () => {
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
    .stats { display: flex; gap: 24px; margin-left: auto; font-size: 13px; color: #8b949e; }
    .stat span { color: #58a6ff; font-weight: 600; }
    .tabs { display: flex; gap: 0; background: #161b22; border-bottom: 1px solid #30363d; padding: 0 24px; }
    .tab { padding: 12px 20px; cursor: pointer; font-size: 14px; color: #8b949e; border-bottom: 2px solid transparent; transition: all .15s; }
    .tab:hover { color: #c9d1d9; }
    .tab.active { color: #f0f6fc; border-bottom-color: #f78166; }
    main { max-width: 1200px; margin: 0 auto; padding: 24px; }
    .view { display: none; }
    .view.active { display: block; }
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
    .tool { background: #0d419d; color: #58a6ff; border-radius: 4px; padding: 2px 7px; font-size: 12px; font-weight: 600; }
    .imp { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
    .imp-high { background: #f85149; }
    .imp-med  { background: #e3b341; }
    .imp-low  { background: #3fb950; }
    .obs-summary { font-size: 14px; line-height: 1.5; color: #e6edf3; }
    .tags { margin-top: 8px; display: flex; gap: 4px; flex-wrap: wrap; }
    .tag { background: #21262d; color: #8b949e; border-radius: 4px; padding: 2px 8px; font-size: 12px; }
    .meta { margin-top: 6px; font-size: 12px; color: #6e7681; }
    .empty { text-align: center; padding: 60px; color: #6e7681; }
    .pagination { display: flex; gap: 8px; justify-content: center; margin-top: 24px; }
    .btn-page { background: #21262d; }
    .charts-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
    .chart-card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 20px; }
    .chart-card h3 { font-size: 14px; color: #8b949e; margin-bottom: 16px; font-weight: 500; }
    .chart-card.wide { grid-column: 1 / -1; }
    .kpi-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 24px; }
    .kpi { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 20px; text-align: center; }
    .kpi .value { font-size: 28px; font-weight: 700; color: #f0f6fc; }
    .kpi .label { font-size: 12px; color: #8b949e; margin-top: 4px; }
    @media (max-width: 768px) {
      .charts-grid { grid-template-columns: 1fr; }
      .kpi-row { grid-template-columns: repeat(2, 1fr); }
      .search-bar { flex-direction: column; }
      input { min-width: 100%; }
    }
  </style>
</head>
<body>
  <header>
    <h1>Claudeye</h1>
    <div class="stats">
      <div id="stat-obs">Loading...</div>
      <div id="stat-sess"></div>
      <div id="stat-proj"></div>
    </div>
  </header>
  <div class="tabs">
    <div class="tab active" data-view="dashboard" onclick="switchTab(this)">Dashboard</div>
    <div class="tab" data-view="observations" onclick="switchTab(this)">Observations</div>
  </div>
  <main>
    <!-- Dashboard view -->
    <div id="view-dashboard" class="view active">
      <div class="kpi-row" id="kpi-row"></div>
      <div class="charts-grid">
        <div class="chart-card wide">
          <h3>Daily Activity (last 30 days)</h3>
          <canvas id="chart-activity" height="80"></canvas>
        </div>
        <div class="chart-card">
          <h3>Tools Distribution</h3>
          <canvas id="chart-tools"></canvas>
        </div>
        <div class="chart-card">
          <h3>Importance Levels</h3>
          <canvas id="chart-importance"></canvas>
        </div>
        <div class="chart-card wide">
          <h3>Projects Overview</h3>
          <canvas id="chart-projects" height="60"></canvas>
        </div>
      </div>
    </div>

    <!-- Observations view -->
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
  </main>
  <script>
    // ─── Tab switching ───────────────────────────────────────────────
    function switchTab(el) {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
      el.classList.add('active');
      document.getElementById('view-' + el.dataset.view).classList.add('active');
    }

    // ─── Chart.js defaults ───────────────────────────────────────────
    Chart.defaults.color = '#8b949e';
    Chart.defaults.borderColor = '#30363d';
    Chart.defaults.font.family = '-apple-system, BlinkMacSystemFont, sans-serif';

    // ─── KPIs + Charts ──────────────────────────────────────────────
    async function loadDashboard() {
      const [stats, activity, tools, importance, projects] = await Promise.all([
        fetch('/api/stats').then(r => r.json()),
        fetch('/api/charts/activity?days=30').then(r => r.json()),
        fetch('/api/charts/tools').then(r => r.json()),
        fetch('/api/charts/importance').then(r => r.json()),
        fetch('/api/charts/projects').then(r => r.json()),
      ]);

      // KPIs
      const days = stats.recentActivity?.length || 0;
      const avgPerDay = days ? Math.round(stats.totalObservations / Math.max(days, 1)) : 0;
      document.getElementById('kpi-row').innerHTML = [
        { value: stats.totalObservations.toLocaleString(), label: 'Total Observations' },
        { value: stats.totalSessions, label: 'Sessions' },
        { value: stats.projects.length, label: 'Projects' },
        { value: avgPerDay, label: 'Avg/Day (active)' },
      ].map(k => '<div class="kpi"><div class="value">' + k.value + '</div><div class="label">' + k.label + '</div></div>').join('');

      // Activity stacked bar chart
      new Chart(document.getElementById('chart-activity'), {
        type: 'bar',
        data: {
          labels: activity.map(d => d.day.slice(5)),
          datasets: [
            { label: 'Hook observations', data: activity.map(d => d.hook_obs), backgroundColor: '#58a6ff', borderRadius: 3 },
            { label: 'Git commits', data: activity.map(d => d.git_commits), backgroundColor: '#3fb950', borderRadius: 3 },
          ]
        },
        options: {
          responsive: true, scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true } },
          plugins: { legend: { position: 'top' } }
        }
      });

      // Tools doughnut
      const topTools = tools.slice(0, 8);
      const toolColors = ['#58a6ff','#f78166','#3fb950','#d2a8ff','#e3b341','#f85149','#79c0ff','#a5d6ff'];
      new Chart(document.getElementById('chart-tools'), {
        type: 'doughnut',
        data: {
          labels: topTools.map(t => t.tool),
          datasets: [{ data: topTools.map(t => t.count), backgroundColor: toolColors }]
        },
        options: {
          responsive: true,
          plugins: { legend: { position: 'right', labels: { boxWidth: 12, padding: 12 } } }
        }
      });

      // Importance pie
      const impColors = { critical: '#f85149', medium: '#e3b341', low: '#3fb950', noise: '#484f58' };
      new Chart(document.getElementById('chart-importance'), {
        type: 'doughnut',
        data: {
          labels: importance.map(i => i.level),
          datasets: [{ data: importance.map(i => i.count), backgroundColor: importance.map(i => impColors[i.level] || '#58a6ff') }]
        },
        options: {
          responsive: true,
          plugins: { legend: { position: 'right', labels: { boxWidth: 12, padding: 12 } } }
        }
      });

      // Projects horizontal bar
      new Chart(document.getElementById('chart-projects'), {
        type: 'bar',
        data: {
          labels: projects.map(p => p.project.split('/').pop()),
          datasets: [{ label: 'Observations', data: projects.map(p => p.obs_count), backgroundColor: '#58a6ff', borderRadius: 3 }]
        },
        options: {
          responsive: true, indexAxis: 'y',
          plugins: { legend: { display: false } },
          scales: { x: { beginAtZero: true } }
        }
      });
    }

    // ─── Stats / filter init ──────────────────────────────────────────
    let offset = 0, total = 0, project = '';
    const LIMIT = 30;

    async function loadStats() {
      const s = await fetch('/api/stats').then(r => r.json());
      document.getElementById('stat-obs').innerHTML  = '<span>' + s.totalObservations + '</span> obs';
      document.getElementById('stat-sess').innerHTML = '<span>' + s.totalSessions + '</span> sessions';
      document.getElementById('stat-proj').innerHTML = '<span>' + s.projects.length + '</span> projects';
      const sel = document.getElementById('project-filter');
      for (const p of s.projects) {
        const opt = document.createElement('option');
        opt.value = p.project;
        opt.text  = p.project.split('/').pop() + ' (' + p.n + ')';
        sel.appendChild(opt);
      }
    }

    // ─── Observations tab ────────────────────────────────────────────
    async function loadRecent(off = 0) {
      project = document.getElementById('project-filter').value;
      const url = '/api/observations?limit=' + LIMIT + '&offset=' + off + (project ? '&project=' + encodeURIComponent(project) : '');
      const data = await fetch(url).then(r => r.json());
      renderList(data.rows);
      total = data.total; offset = off;
      renderPagination();
    }

    async function doSearch() {
      const q = document.getElementById('search').value.trim();
      project = document.getElementById('project-filter').value;
      if (!q) return loadRecent();
      const url = '/api/search?query=' + encodeURIComponent(q) + (project ? '&project=' + encodeURIComponent(project) : '');
      const data = await fetch(url).then(r => r.json());
      renderList(data);
      document.getElementById('pagination').innerHTML = '';
    }

    function renderList(rows) {
      const el = document.getElementById('list');
      if (!rows.length) { el.innerHTML = '<div class="empty">No observations found.</div>'; return; }
      el.innerHTML = rows.map(obs => {
        const imp = obs.importance >= 0.8 ? 'high' : obs.importance >= 0.5 ? 'med' : 'low';
        const tags = JSON.parse(obs.tags || '[]');
        const proj = (obs.project || '').split('/').pop();
        return \`<div class="obs">
          <div class="obs-header">
            <div class="imp imp-\${imp}"></div>
            <span class="tool">\${obs.tool}</span>
            <span style="font-size:12px;color:#6e7681">\${proj}</span>
          </div>
          <div class="obs-summary">\${escHtml(obs.summary)}</div>
          \${tags.length ? '<div class="tags">' + tags.map(t => '<span class="tag">#' + escHtml(t) + '</span>').join('') + '</div>' : ''}
          <div class="meta">\${obs.created_at || ''}</div>
        </div>\`;
      }).join('');
    }

    function renderPagination() {
      const el = document.getElementById('pagination');
      const pages = Math.ceil(total / LIMIT);
      const cur   = Math.floor(offset / LIMIT);
      if (pages <= 1) { el.innerHTML = ''; return; }
      let html = '';
      const start = Math.max(0, cur - 3), end = Math.min(pages, cur + 4);
      if (start > 0) html += '<button class="btn-page" onclick="loadRecent(0)">1</button><span style="color:#6e7681">...</span>';
      for (let i = start; i < end; i++) {
        const active = i === cur ? 'background:#0d419d' : '';
        html += \`<button class="btn-page" style="\${active}" onclick="loadRecent(\${i * LIMIT})">\${i + 1}</button>\`;
      }
      if (end < pages) html += '<span style="color:#6e7681">...</span><button class="btn-page" onclick="loadRecent(' + ((pages-1)*LIMIT) + ')">' + pages + '</button>';
      el.innerHTML = html;
    }

    function escHtml(s) {
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    // ─── Init ────────────────────────────────────────────────────────
    loadStats();
    loadDashboard();
  </script>
</body>
</html>`;
}
