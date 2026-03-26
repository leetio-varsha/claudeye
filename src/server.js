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
  <title>Claude Mem Viewer</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0d1117; color: #c9d1d9; }
    header { background: #161b22; border-bottom: 1px solid #30363d; padding: 16px 24px; display: flex; align-items: center; gap: 16px; }
    header h1 { font-size: 16px; font-weight: 600; color: #f0f6fc; }
    .stats { display: flex; gap: 24px; margin-left: auto; font-size: 13px; color: #8b949e; }
    .stat span { color: #58a6ff; font-weight: 600; }
    main { max-width: 1100px; margin: 0 auto; padding: 24px; }
    .search-bar { display: flex; gap: 8px; margin-bottom: 24px; }
    input, select { background: #161b22; border: 1px solid #30363d; color: #c9d1d9; border-radius: 6px; padding: 8px 12px; font-size: 14px; }
    input { flex: 1; }
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
  </style>
</head>
<body>
  <header>
    <h1>🧠 Claude Mem</h1>
    <div class="stats">
      <div id="stat-obs">Loading...</div>
      <div id="stat-sess"></div>
    </div>
  </header>
  <main>
    <div class="search-bar">
      <input id="search" type="text" placeholder="Search observations..." onkeydown="if(event.key==='Enter')doSearch()">
      <select id="project-filter"><option value="">All projects</option></select>
      <button onclick="doSearch()">Search</button>
      <button onclick="loadRecent()" style="background:#21262d">Recent</button>
    </div>
    <div class="obs-list" id="list"></div>
    <div class="pagination" id="pagination"></div>
  </main>
  <script>
    let offset = 0, total = 0, project = '';
    const LIMIT = 30;

    async function loadStats() {
      const s = await fetch('/api/stats').then(r => r.json());
      document.getElementById('stat-obs').innerHTML  = '<span>' + s.totalObservations + '</span> observations';
      document.getElementById('stat-sess').innerHTML = '<span>' + s.totalSessions + '</span> sessions';
      const sel = document.getElementById('project-filter');
      for (const p of s.projects) {
        const opt = document.createElement('option');
        opt.value = p.project;
        opt.text  = p.project.replace(location.origin, '~') + ' (' + p.n + ')';
        sel.appendChild(opt);
      }
    }

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
        const proj = (obs.project || '').replace(location.origin, '~');
        return \`<div class="obs">
          <div class="obs-header">
            <div class="imp imp-\${imp}"></div>
            <span class="tool">\${obs.tool}</span>
            <span style="font-size:12px;color:#6e7681">\${proj.split('/').pop()}</span>
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
      for (let i = 0; i < pages; i++) {
        const active = i === cur ? 'background:#0d419d' : '';
        html += \`<button class="btn-page" style="\${active}" onclick="loadRecent(\${i * LIMIT})">\${i + 1}</button>\`;
      }
      el.innerHTML = html;
    }

    function escHtml(s) {
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    loadStats();
    loadRecent();
  </script>
</body>
</html>`;
}
