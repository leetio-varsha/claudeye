#!/usr/bin/env node
/**
 * cli.js — claudeye CLI
 *
 * Usage:
 *   claudeye stats              — show database stats
 *   claudeye search <query>     — search observations
 *   claudeye recent [n]         — show recent observations
 *   claudeye sessions           — list recent sessions
 *   claudeye viewer             — open web viewer
 *   claudeye setup              — first-time setup
 *   claudeye clear [--project]  — clear data
 */

import { program } from 'commander';
import chalk from 'chalk';
import { registerAnalyticsCommands } from './src/analytics-cli.js';

program
  .name('claudeye')
  .description('Personal memory & analytics for Claude Code')
  .version('1.0.0');

// ─── stats ────────────────────────────────────────────────────────────────

program.command('stats')
  .description('Show memory database statistics')
  .action(async () => {
    const { getStats, getDbMetrics } = await import('./src/db.js');
    const stats = getStats();
    const metrics = getDbMetrics();

    console.log(chalk.bold('\n📊 Claude Mem Stats\n'));
    console.log(`  Total observations: ${chalk.cyan(stats.totalObservations)}`);
    console.log(`  Total sessions:     ${chalk.cyan(stats.totalSessions)}`);
    console.log(`  Embeddings:         ${chalk.cyan(metrics.embCount)}`);

    // Embedding dimension distribution (#53)
    if (metrics.embDims.length > 0) {
      const parts = metrics.embDims.map(d => `${d.dims}-dim: ${d.n}`).join(', ');
      const mixed = metrics.embDims.length > 1;
      console.log(`  Embedding dims:     ${mixed ? chalk.yellow(parts + " ⚠ mixed — run 'claudeye reindex'") : chalk.green(parts)}`);
    }

    if (stats.projects.length) {
      console.log(chalk.bold('\n  Projects:'));
      for (const p of stats.projects) {
        const short = p.project.replace(process.env.HOME, '~');
        console.log(`    ${chalk.green(short.padEnd(50))} ${chalk.yellow(p.n)} obs`);
      }
    }

    if (stats.recentActivity.length) {
      console.log(chalk.bold('\n  Last 7 days:'));
      for (const d of stats.recentActivity.slice(0, 7)) {
        const bar = '█'.repeat(Math.min(30, d.n));
        console.log(`    ${d.day}  ${chalk.blue(bar)} ${d.n}`);
      }
    }
    console.log('');
  });

// ─── search ───────────────────────────────────────────────────────────────

program.command('search <query>')
  .description('Hybrid search observations')
  .option('-p, --project <path>', 'Filter by project', process.cwd())
  .option('-n, --limit <n>', 'Max results', '10')
  .option('--all', 'Search across ALL projects (Personal AI OS #27)', false)
  .action(async (query, opts) => {
    const { hybridSearch } = await import('./src/search.js');
    const ora = (await import('ora')).default;

    // --all: null project triggers cross-project search in hybridSearch
    const projectScope = opts.all ? null : opts.project;
    const spinnerText  = opts.all ? `Searching all projects for: "${query}"` : 'Searching...';

    const spinner = ora(spinnerText).start();
    try {
      const results = await hybridSearch(query, projectScope, { limit: parseInt(opts.limit) });
      spinner.stop();

      if (!results.length) {
        console.log(chalk.yellow('\n  No results found.\n'));
        return;
      }

      const header = opts.all
        ? chalk.bold(`\n🌐 Results across all projects for "${query}"\n`)
        : chalk.bold(`\n🔍 Results for "${query}"\n`);
      console.log(header);

      for (const obs of results) {
        const score    = (obs.hybridScore * 100).toFixed(1);
        const tags     = JSON.parse(obs.tags || '[]');
        const projName = opts.all && obs.project
          ? chalk.gray(` [${obs.project.split('/').pop()}]`)
          : '';
        console.log(`  ${chalk.cyan('●')} ${obs.summary}${projName}`);
        if (tags.length) console.log(`    ${chalk.gray(tags.map(t => `#${t}`).join(' '))}`);
        console.log(`    ${chalk.gray(obs.created_at)} ${chalk.yellow(`score: ${score}`)}\n`);
      }
    } catch (err) {
      spinner.fail(err.message);
    }
  });

// ─── projects (#27) ───────────────────────────────────────────────────────

program.command('projects')
  .description('List all registered projects (Personal AI OS #27)')
  .option('--json', 'Output as JSON', false)
  .action(async (opts) => {
    const { listProjects, projectCount } = await import('./src/project-registry.js');
    const projects = listProjects();

    if (opts.json) {
      console.log(JSON.stringify(projects, null, 2));
      return;
    }

    if (!projects.length) {
      console.log(chalk.yellow('\n  No projects registered yet.\n'));
      console.log(chalk.gray('  Projects are auto-registered when Claudeye hooks run in a directory.\n'));
      return;
    }

    console.log(chalk.bold(`\n📁 Registered projects (${projects.length})\n`));
    for (const p of projects) {
      const lastSeen  = p.lastSeen.slice(0, 10);
      const firstSeen = p.firstSeen.slice(0, 10);
      const shortPath = p.path.replace(process.env.HOME || '', '~');
      console.log(`  ${chalk.cyan(p.shortName)}`);
      console.log(`    ${chalk.gray(shortPath)}`);
      console.log(`    ${chalk.gray(`first: ${firstSeen}  last: ${lastSeen}`)}\n`);
    }
  });

// ─── recent ───────────────────────────────────────────────────────────────

program.command('recent [n]')
  .description('Show recent observations')
  .option('-p, --project <path>', 'Filter by project', process.cwd())
  .action(async (n, opts) => {
    const { getRecentObservations } = await import('./src/db.js');
    const results = getRecentObservations(opts.project, parseInt(n || '15'));

    if (!results.length) {
      console.log(chalk.yellow('\n  No observations yet.\n'));
      return;
    }

    console.log(chalk.bold(`\n📋 Recent observations (${opts.project.replace(process.env.HOME, '~')})\n`));
    for (const obs of results) {
      const imp = obs.importance >= 0.8 ? chalk.red('🔴') :
                  obs.importance >= 0.5 ? chalk.yellow('🟡') : chalk.green('🟢');
      const tags = JSON.parse(obs.tags || '[]');
      console.log(`  ${imp} ${obs.summary}`);
      if (tags.length) console.log(`     ${chalk.gray(tags.map(t => `#${t}`).join(' '))}`);
      console.log(`     ${chalk.gray(obs.created_at)}\n`);
    }
  });

// ─── sessions ─────────────────────────────────────────────────────────────

program.command('sessions')
  .description('List recent sessions')
  .action(async () => {
    const { getDb } = await import('./src/db.js');
    const db = getDb();
    const sessions = db.prepare(`
      SELECT s.id, s.project, s.started_at, s.ended_at, s.summary,
             COUNT(o.id) as obs_count
      FROM sessions s
      LEFT JOIN observations o ON o.session_id = s.id
      GROUP BY s.id
      ORDER BY s.started_at DESC
      LIMIT 20
    `).all();

    console.log(chalk.bold('\n📅 Recent Sessions\n'));
    for (const s of sessions) {
      const proj  = s.project.replace(process.env.HOME, '~');
      const ended = s.ended_at ? '' : chalk.green(' [active]');
      console.log(`  ${chalk.cyan(s.started_at.slice(0, 16))}  ${chalk.bold(proj)}${ended}`);
      console.log(`    ${chalk.yellow(s.obs_count)} observations`);
      if (s.summary) console.log(`    ${chalk.gray(s.summary.slice(0, 120))}...`);
      console.log('');
    }
  });

// ─── viewer ───────────────────────────────────────────────────────────────

program.command('viewer')
  .description('Open web viewer at http://localhost:47777')
  .action(async () => {
    const { createServer } = await import('./src/server.js');
    createServer(47777);
    console.log(chalk.green('\n🌐 Viewer running at http://localhost:47777\n'));
    console.log(chalk.gray('  Press Ctrl+C to stop\n'));
  });

// ─── injection-stats (#90) ──────────────────────────────────────────────

program.command('injection-stats')
  .description('Activity report: sessions, output (edits/writes/bash), memory (RAG injections)')
  .option('-d, --days <n>', 'Days to look back', '7')
  .option('-p, --project <path>', 'Filter by project')
  .action(async (opts) => {
    const days = parseInt(opts.days, 10);
    const { getInjectionStats, getDb } = await import('./src/db.js');
    const db = getDb();
    const HOME = process.env.HOME || '';
    const shortPath = p => p.replace(HOME, '~').replace(/.*\/([^/]+\/[^/]+)$/, '$1');

    // ── Activity: sessions + token consumption ───────────────────────────
    const projectFilter = opts.project ? `AND project = '${opts.project.replace(/'/g, "''")}'` : '';
    // Count sessions from sessions table directly (avoid obs join duplication)
    const actRow = db.prepare(`
      SELECT
        COUNT(*)                          AS sessions,
        COALESCE(SUM(token_input),  0)    AS token_in,
        COALESCE(SUM(token_output), 0)    AS token_out,
        COALESCE(AVG(CASE WHEN duration_ms > 0 THEN duration_ms END), 0) AS avg_dur_ms
      FROM sessions
      WHERE started_at >= datetime('now', ?)
        AND ended_at IS NOT NULL
      ${projectFilter}
    `).get(`-${days} days`);

    // ── Output: file operations ──────────────────────────────────────────
    const toolRow = db.prepare(`
      SELECT
        SUM(CASE WHEN tool = 'Edit'  THEN 1 ELSE 0 END) AS edits,
        SUM(CASE WHEN tool = 'Write' THEN 1 ELSE 0 END) AS writes,
        SUM(CASE WHEN tool = 'Read'  THEN 1 ELSE 0 END) AS reads,
        SUM(CASE WHEN tool = 'Bash'  THEN 1 ELSE 0 END) AS bashes
      FROM observations
      WHERE created_at >= datetime('now', ?)
      ${projectFilter}
    `).get(`-${days} days`);

    // ── Per-project breakdown ────────────────────────────────────────────
    const perProject = db.prepare(`
      SELECT
        project,
        COUNT(DISTINCT session_id)                       AS sessions,
        SUM(CASE WHEN tool = 'Edit'  THEN 1 ELSE 0 END) AS edits,
        SUM(CASE WHEN tool = 'Write' THEN 1 ELSE 0 END) AS writes,
        SUM(CASE WHEN tool = 'Bash'  THEN 1 ELSE 0 END) AS bashes,
        COUNT(*)                                         AS total_obs
      FROM observations
      WHERE created_at >= datetime('now', ?)
      ${projectFilter}
      GROUP BY project
      ORDER BY (edits + writes + bashes) DESC
      LIMIT 8
    `).all(`-${days} days`);

    // ── Injection stats (RAG) ────────────────────────────────────────────
    const inj = getInjectionStats({ days, project: opts.project });

    // ── Render ───────────────────────────────────────────────────────────
    const fmtNum  = n => String(Math.round(n || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, '_');
    const fmtM    = n => n >= 1e9 ? (n/1e9).toFixed(1)+'B' : n >= 1e6 ? (n/1e6).toFixed(0)+'M' : fmtNum(n);
    const fmtHrs  = ms => ms < 3600000 ? (ms/60000).toFixed(0)+'m' : (ms/3600000).toFixed(1)+'h';
    const fmtKB   = b => b >= 1024 ? (b/1024).toFixed(1)+' KB' : b+' B';

    const dayLabel = opts.project ? `${days}d · ${shortPath(opts.project)}` : `${days}d`;

    console.log(chalk.bold(`\n📊  Claudeye — Activity Report  (${dayLabel})\n`));

    // ACTIVITY
    console.log(chalk.bold('  АКТИВНОСТЬ'));
    console.log(`    ${chalk.cyan(fmtNum(actRow.sessions))} сессий`
      + (actRow.avg_dur_ms ? `  ·  в среднем ${chalk.cyan(fmtHrs(actRow.avg_dur_ms))} на сессию` : '')
    );
    if (actRow.token_in || actRow.token_out) {
      console.log(`    Токены: ${chalk.yellow(fmtM(actRow.token_in))} входящих  /  ${chalk.yellow(fmtM(actRow.token_out))} исходящих`);
    }

    // OUTPUT
    console.log(chalk.bold('\n  РАБОТА С КОДОМ'));
    const edits  = toolRow.edits  || 0;
    const writes = toolRow.writes || 0;
    const reads  = toolRow.reads  || 0;
    const bashes = toolRow.bashes || 0;
    console.log(`    ${chalk.green(String(edits).padStart(5))}  Edit     — файлов изменено`);
    console.log(`    ${chalk.green(String(writes).padStart(5))}  Write    — файлов создано`);
    console.log(`    ${chalk.cyan(String(reads).padStart(5))}  Read     — файлов прочитано`);
    console.log(`    ${chalk.gray(String(bashes).padStart(5))}  Bash     — команд в терминале`);

    // MEMORY
    if (inj.totalPrompts) {
      console.log(chalk.bold('\n  ПАМЯТЬ (RAG-инъекции)'));
      const budgetPct = inj.totalPrompts ? Math.round(inj.budgetHits / inj.totalPrompts * 100) : 0;
      console.log(`    ${chalk.cyan(fmtNum(inj.totalPrompts))} промптов с контекстом  ·  avg ${fmtKB(inj.avgBytes)} на промпт`);
      if (inj.perSection.length) {
        const sectionMap = { decisions: 'решения', recent: 'сессия', searched: 'поиск', cross: 'cross-repo' };
        const parts = inj.perSection
          .filter(s => s.avgBytes > 50)
          .map(s => `${sectionMap[s.name] || s.name} ${fmtKB(s.avgBytes)}`);
        if (parts.length) console.log(`    Секции: ${chalk.gray(parts.join('  ·  '))}`);
      }
      if (budgetPct > 50) {
        console.log(`    ${chalk.yellow('⚠')}  Budget-gate срабатывает в ${budgetPct}% промптов — контекст обрезается`);
      }
    }

    // PER-PROJECT
    if (perProject.length > 1 || (perProject.length === 1 && !opts.project)) {
      console.log(chalk.bold('\n  ПРОЕКТЫ'));
      const maxName = Math.min(30, Math.max(...perProject.map(p => shortPath(p.project).length)));
      for (const p of perProject) {
        const name = shortPath(p.project).padEnd(maxName);
        const parts = [
          `${chalk.cyan(String(p.sessions).padStart(3))} сес`,
          `Edit ${chalk.green(String(p.edits).padStart(4))}`,
          `Write ${chalk.green(String(p.writes).padStart(3))}`,
          `Bash ${chalk.gray(String(p.bashes).padStart(4))}`,
        ];
        console.log(`    ${chalk.bold(name)}  ${parts.join('  ')}`);
      }
    }

    console.log('');
  });

// ─── health ──────────────────────────────────────────────────────────────

program.command('health')
  .description('Diagnostic check: DB, API keys, hooks, errors')
  .action(async () => {
    const { getDb, getStats, getErrorStats, getErrorHealthSnapshot, getInjectionStats } = await import('./src/db.js');
    const { isEmbeddingEnabled } = await import('./src/embeddings.js');
    const { existsSync, statSync } = await import('fs');
    const { join } = await import('path');
    const { homedir } = await import('os');

    const dbPath = join(homedir(), '.claudeye', 'mem.db');
    const checks = [];
    const db = getDb();

    // DB check
    try {
      const { getDbMetrics } = await import('./src/db.js');
      const stats = getStats();
      const metrics = getDbMetrics();
      // Thresholds: 150MB action (run archive), 250MB critical. Steady-state floor
      // after `claudeye archive` is ~100MB (recent + high-importance hot data) — alerting
      // on >100 caused noise immediately after a successful archive.
      const sizeWarn = metrics.fileSizeMB > 150;
      const sizeCrit = metrics.fileSizeMB > 250;
      const embCoverage = metrics.obsCount > 0 ? Math.round(metrics.embCount / metrics.obsCount * 100) : 0;
      const gitPct = metrics.obsCount > 0 ? Math.round(metrics.gitCommitCount / metrics.obsCount * 100) : 0;
      let sizeAdvice = '';
      if (sizeCrit) sizeAdvice = ` 🔴 >250MB — run ${chalk.red('claudeye archive')} to move old obs to archive.db`;
      else if (sizeWarn) sizeAdvice = ` ⚠️  >150MB — run ${chalk.yellow('claudeye archive --dry-run')} to see what can be archived`;
      const effCov = metrics.effectiveCoverage;
      const embCovWarn = effCov < 80;
      checks.push({
        name: 'Database',
        ok: !sizeWarn,
        detail: `${stats.totalObservations} obs, ${stats.totalSessions} sessions, ${metrics.fileSizeMB}MB`
          + sizeAdvice
          + ` | git-commit: ${metrics.gitCommitCount} (${gitPct}%)`
      });
      checks.push({
        name: 'Embedding coverage',
        ok: !embCovWarn,
        detail: `${metrics.embCount} total (${embCoverage}% raw) | `
          + `${chalk.bold(effCov + '%')} effective (${metrics.searchableWithEmb}/${metrics.searchableObs} searchable)`
          + (embCovWarn ? ` ⚠️  <80% — run ${chalk.yellow('claudeye reindex')}` : '')
      });
    } catch (e) {
      checks.push({ name: 'Database', ok: false, detail: e.message });
    }

    // Embeddings check
    const embOk = isEmbeddingEnabled();
    checks.push({ name: 'OpenAI Embeddings', ok: embOk, detail: embOk ? 'API key configured' : 'No API key — using FTS5 only' });

    // Hooks check — hooks live in ~/.claude/settings.json
    const claudeSettings = join(homedir(), '.claude', 'settings.json');
    let hooksOk = false, hooksDetail = 'Not configured';
    if (existsSync(claudeSettings)) {
      try {
        const { readFileSync } = await import('fs');
        const cs = JSON.parse(readFileSync(claudeSettings, 'utf8'));
        const hookCount = ['PostToolUse','UserPromptSubmit','Stop']
          .reduce((n, k) => n + ((cs.hooks?.[k] || []).filter(h =>
            (h.hooks || []).some(hh => (hh.command||'').includes('claudeye'))
          ).length > 0 ? 1 : 0), 0);
        hooksOk = hookCount >= 2;
        hooksDetail = `${hookCount}/3 hook types active`;
      } catch (e) { hooksDetail = 'Error reading: ' + e.message; }
    }
    checks.push({ name: 'Claude Code hooks', ok: hooksOk, detail: hooksDetail });

    // Orphaned sessions (#60)
    try {
      const totalSessions = db.prepare('SELECT COUNT(*) as n FROM sessions').get().n;
      const unclosed = db.prepare("SELECT COUNT(*) as n FROM sessions WHERE ended_at IS NULL AND id NOT LIKE 'import-git-%'").get().n;
      const unclosedPct = totalSessions > 0 ? Math.round(unclosed / totalSessions * 100) : 0;
      const sessOk = unclosedPct < 30;
      checks.push({ name: 'Session closure', ok: sessOk, detail: `${unclosed} unclosed of ${totalSessions} (${unclosedPct}%)` + (!sessOk ? ` — run ${chalk.yellow('claudeye cleanup')}` : '') });
    } catch {
      checks.push({ name: 'Session closure', ok: true, detail: 'check skipped' });
    }

    // Error budget (#89: focus on actionable 24h window, show 7d trend for context).
    // Stale spikes from already-fixed bugs used to keep this red forever — now
    // health follows the rolling rate, and `claudeye cleanup` expires rows >30d.
    try {
      const snap = getErrorHealthSnapshot();
      const errOk = snap.last24h < 20;  // 20 errs/day is the new threshold
      const trendGlyph = snap.trend === 'growing' ? '↑' : snap.trend === 'decaying' ? '↓' : '─';
      const trendColor = snap.trend === 'growing' ? chalk.red : snap.trend === 'decaying' ? chalk.green : chalk.gray;
      const hookBreakdown = snap.byHook.length
        ? ' — ' + snap.byHook.slice(0,3).map(e => `${e.hook}:${e.error_type}(${e.count})`).join(', ')
        : '';
      checks.push({
        name: 'Error budget (24h)',
        ok: errOk,
        detail: `${snap.last24h} errors ${trendColor(trendGlyph)} (7d: ${snap.last7d})${hookBreakdown}`,
      });
    } catch {
      checks.push({ name: 'Error budget', ok: true, detail: '0 errors' });
    }

    // Injection size (#90) — RAG tax on every prompt. Warn if p95 > 1500 tokens.
    try {
      const inj = getInjectionStats({ days: 7 });
      if (inj.totalPrompts > 0) {
        const injOk = inj.p95 <= 1500;
        checks.push({
          name: 'Injection size (7d)',
          ok: injOk,
          detail: `p50 ${inj.p50}tok · p95 ${inj.p95}tok · max ${inj.maxBytes}B · ${inj.totalPrompts} prompts`
            + (inj.budgetHits ? ` · budget hits: ${inj.budgetHits}` : '')
            + (!injOk ? ` — set ${chalk.yellow('inject_budget_tokens')} in settings.json` : ''),
        });
      }
    } catch { /* skip if table not yet migrated */ }

    // Search latency (#30 monitoring) — FTS + vector DB load.
    // Thresholds from issue #30: FTS > 200ms → Этап 3 trigger, vector > 500ms → Этап 4 trigger.
    try {
      const { ftsSearch, getObservationsWithEmbeddings } = await import('./src/db.js');
      const { bufToFloat32, cosineSimilarity } = await import('./src/embeddings.js');
      const BENCH_QUERY = 'recent work tool usage';

      // FTS latency
      const ftsT0 = Date.now();
      ftsSearch(BENCH_QUERY, null, 10);
      const ftsMs = Date.now() - ftsT0;

      // Vector DB load + cosine computation (CPU, no API call)
      const vecT0 = Date.now();
      const rows = getObservationsWithEmbeddings(null, 300);
      if (rows.length > 0) {
        // Simulate one cosine pass with a zero vector — measures DB I/O + JS CPU
        const zeroDim = rows[0].vector ? bufToFloat32(rows[0].vector).length : 1536;
        const fakeQ = new Float32Array(zeroDim); // all zeros, but exercises the loop
        rows.slice(0, 100).forEach(r => {
          if (r.vector) cosineSimilarity(fakeQ, bufToFloat32(r.vector));
        });
      }
      const vecMs = Date.now() - vecT0;

      const ftsWarn = ftsMs > 200;
      const vecWarn = vecMs > 500;
      const latencyOk = !ftsWarn && !vecWarn;

      checks.push({
        name: 'Search latency',
        ok: latencyOk,
        detail: `FTS ${ftsMs}ms · vector ${vecMs}ms (${rows.length} rows sampled)`
          + (ftsWarn ? ` ⚠️  FTS >200ms — Этап 3 trigger (#30)` : '')
          + (vecWarn ? ` 🔴 vector >500ms — Этап 4 trigger (#30)` : ''),
      });
    } catch {
      checks.push({ name: 'Search latency', ok: true, detail: 'check skipped' });
    }

    // Weekly digest freshness (#79)
    try {
      const latest = db.prepare('SELECT week_start, created_at FROM digests ORDER BY week_start DESC LIMIT 1').get();
      if (!latest) {
        checks.push({ name: 'Weekly digest', ok: false, detail: `No digests yet — run ${chalk.yellow('claudeye digest --generate')}` });
      } else {
        const now = new Date();
        const dayOfWeek = now.getDay();
        const monday = new Date(now);
        monday.setDate(now.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
        const currentWeekStart = monday.toISOString().slice(0, 10);
        // Previous week Monday
        const prevMonday = new Date(monday);
        prevMonday.setDate(monday.getDate() - 7);
        const prevWeekStart = prevMonday.toISOString().slice(0, 10);
        const isCurrent = latest.week_start >= prevWeekStart;
        checks.push({
          name: 'Weekly digest',
          ok: isCurrent,
          detail: `Last: ${latest.week_start}` + (!isCurrent ? ` ⚠️  stale — run ${chalk.yellow('claudeye digest --generate')}` : ' (up to date)')
        });
      }
    } catch {
      checks.push({ name: 'Weekly digest', ok: true, detail: 'check skipped (no digests table)' });
    }

    // Daily insights freshness (#82)
    try {
      const latestInsight = db.prepare('SELECT date, created_at FROM insights ORDER BY created_at DESC LIMIT 1').get();
      if (!latestInsight) {
        checks.push({ name: 'Daily insights', ok: false, detail: `No insights yet — run ${chalk.yellow('claudeye insights --schedule')}` });
      } else {
        const hoursSince = (Date.now() - new Date(latestInsight.created_at + 'Z').getTime()) / 3600000;
        const isStale = hoursSince > 36; // 1.5 days
        checks.push({
          name: 'Daily insights',
          ok: !isStale,
          detail: `Last: ${latestInsight.date} (${Math.round(hoursSince)}h ago)`
            + (isStale ? ` ⚠️  stale — run ${chalk.yellow('claudeye insights --schedule')}` : ' (fresh)')
        });
      }
    } catch {
      checks.push({ name: 'Daily insights', ok: true, detail: 'check skipped (no insights table)' });
    }

    // Disk space
    try {
      const { execSync } = await import('child_process');
      const df = execSync('df -h ~/.claudeye 2>/dev/null', { encoding: 'utf8' });
      const parts = df.split('\\n')[1]?.split(/\\s+/);
      const avail = parts?.[3] || '?';
      checks.push({ name: 'Disk space', ok: true, detail: `${avail} available` });
    } catch {
      checks.push({ name: 'Disk space', ok: true, detail: 'check skipped' });
    }

    console.log(chalk.bold('\\n  Claudeye Health Check\\n'));
    for (const c of checks) {
      const icon = c.ok ? chalk.green('✓') : chalk.red('✗');
      console.log(`  ${icon} ${chalk.white(c.name)}: ${chalk.gray(c.detail)}`);
    }

    const allOk = checks.every(c => c.ok);
    console.log(allOk
      ? chalk.green('\\n  All checks passed.\\n')
      : chalk.yellow('\\n  Some checks need attention.\\n'));
  });

// ─── setup ────────────────────────────────────────────────────────────────

program.command('setup')
  .description('Interactive first-time setup')
  .action(async () => {
    const { default: setup } = await import('./scripts/setup.js');
    await setup();
  });

// ─── init ────────────────────────────────────────────────────────────────

program.command('init')
  .description('One-command setup: configure, install hooks, import git history')
  .option('--skip-import', 'Skip git history import')
  .action(async () => {
    const { existsSync, readFileSync, writeFileSync, mkdirSync } = await import('fs');
    const { join } = await import('path');
    const { homedir } = await import('os');
    const { execSync } = await import('child_process');

    console.log(chalk.bold('\n  Claudeye Init\n'));

    // Step 1: Prerequisites
    console.log(chalk.gray('  Checking prerequisites...'));
    const nodeVer = parseInt(process.version.slice(1));
    if (nodeVer < 20) {
      console.log(chalk.red(`  ✗ Node ${process.version} — need >= 20`));
      process.exit(1);
    }
    console.log(chalk.green(`  ✓ Node ${process.version}`));

    try { execSync('git --version', { stdio: 'ignore' }); console.log(chalk.green('  ✓ git installed')); }
    catch { console.log(chalk.red('  ✗ git not found')); process.exit(1); }

    try { execSync('claude --version', { stdio: 'ignore' }); console.log(chalk.green('  ✓ Claude Code installed')); }
    catch { console.log(chalk.yellow('  ⚠ Claude Code not found — hooks will install but won\'t run until Claude Code is available')); }

    // Step 2: Ensure ~/.claudeye exists
    const dataDir = join(homedir(), '.claudeye');
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true, mode: 0o700 });

    // Step 3: Settings / API key
    const settingsPath = join(dataDir, 'settings.json');
    let settings = {};
    if (existsSync(settingsPath)) {
      try { settings = JSON.parse(readFileSync(settingsPath, 'utf8')); } catch {}
    }
    const hasKey = settings.openai_api_key || settings.openaiApiKey || process.env.OPENAI_API_KEY;
    if (hasKey) {
      console.log(chalk.green('  ✓ OpenAI API key configured'));
    } else {
      console.log(chalk.yellow('  ⚠ No OpenAI API key — search will use FTS5 only (still works!)'));
      console.log(chalk.gray('    To add later: add "openai_api_key" to ~/.claudeye/settings.json'));
    }

    // Step 4: Initialize DB
    console.log(chalk.gray('\\n  Initializing database...'));
    const { getDb, getStats } = await import('./src/db.js');
    getDb();
    console.log(chalk.green('  ✓ Database ready'));

    // Step 5: Install Claude Code hooks
    console.log(chalk.gray('\\n  Installing Claude Code hooks...'));
    try {
      const { default: installHooks } = await import('./scripts/install-hooks.js');
      await installHooks();
    } catch (e) {
      console.log(chalk.yellow('  ⚠ Hook install issue: ' + e.message));
    }

    // Step 6: Detect git repo and import
    const cwd = process.cwd();
    let isGitRepo = false;
    try { execSync('git rev-parse --git-dir', { cwd, stdio: 'ignore' }); isGitRepo = true; } catch {}

    if (isGitRepo && !program.opts().skipImport) {
      console.log(chalk.gray('\\n  Importing git history from ' + cwd + '...'));
      try {
        const { importGitCommits } = await import('./src/git-import.js');
        const count = await importGitCommits(cwd, { limit: 200, silent: true });
        console.log(chalk.green(`  ✓ Imported ${count} commits`));

        // Install git post-commit hook for this repo
        try {
          const { installGitHook } = await import('./scripts/install-git-hooks.js');
          installGitHook(cwd);
          console.log(chalk.green('  ✓ Git post-commit hook installed'));
        } catch (e) {
          console.log(chalk.yellow('  ⚠ Git hook: ' + e.message));
        }
      } catch (e) {
        console.log(chalk.yellow('  ⚠ Import: ' + e.message));
      }
    } else if (!isGitRepo) {
      console.log(chalk.gray('\\n  Not a git repo — skipping import'));
    } else {
      console.log(chalk.gray('\\n  Skipping git import (--skip-import)'));
    }

    // Step 7: Summary
    const stats = getStats();
    console.log(chalk.bold('\\n  Setup complete!'));
    console.log(chalk.gray(`  ${stats.totalObservations} observations, ${stats.totalSessions} sessions\\n`));
    console.log(chalk.cyan('  Next steps:'));
    console.log(chalk.gray('    claudeye health     — check everything works'));
    console.log(chalk.gray('    claudeye viewer     — open web dashboard'));
    console.log(chalk.gray('    claudeye search <q> — search your memory'));
    console.log(chalk.gray('    claudeye analytics  — view usage analytics\\n'));
  });

// ─── install-hooks ────────────────────────────────────────────────────────

program.command('install-hooks')
  .description('Install Claude Code hooks')
  .action(async () => {
    const { default: installHooks } = await import('./scripts/install-hooks.js');
    await installHooks();
  });

// ─── install-git-hooks ───────────────────────────────────────────────

program.command('install-git-hooks')
  .description('Install Claudeye post-commit hook in a git repo')
  .argument('[repo]', 'Repository path', process.cwd())
  .action(async (repo) => {
    const { installGitHooks } = await import('./scripts/install-git-hooks.js');
    console.log(chalk.bold('\n🔧 Installing git post-commit hook...\n'));
    await installGitHooks(repo);
    console.log(chalk.gray('\n  New commits will auto-import into mem.db\n'));
  });

// ─── uninstall-git-hooks ─────────────────────────────────────────────

program.command('uninstall-git-hooks')
  .description('Remove Claudeye post-commit hook from a git repo')
  .argument('[repo]', 'Repository path', process.cwd())
  .action(async (repo) => {
    const { uninstallGitHooks } = await import('./scripts/install-git-hooks.js');
    console.log(chalk.bold('\n🔧 Removing git post-commit hook...\n'));
    await uninstallGitHooks(repo);
    console.log('');
  });

// ─── cleanup (retention) ─────────────────────────────────────────────────

program.command('cleanup')
  .description('Tiered retention cleanup: remove old low-value observations, reclaim disk space')
  .option('--dry-run', 'Show what would be deleted/compacted without changes')
  .option('--no-vacuum', 'Skip VACUUM (faster, but does not reclaim disk space)')
  .option('--cowork-noise', 'Also drop Cowork noise + intra-session duplicates (#93)')
  .option('--system-sessions', 'Remove observations from Claudeye scheduled-task sessions (self-observation loop fix)')
  .action(async (opts) => {
    const { cleanup, compact, getDbMetrics, closeOrphanedSessions, cleanupCoworkNoise, cleanupSystemSessionObservations } = await import('./src/db.js');
    const { computeFrictionScore } = await import('./src/analytics.js');
    const ora = (await import('ora')).default;

    const metrics = getDbMetrics();
    console.log(chalk.bold('\n  Claudeye Cleanup\n'));
    console.log(`  DB size: ${chalk.cyan(metrics.fileSizeMB + 'MB')} | Observations: ${chalk.cyan(metrics.obsCount)} | Embeddings: ${chalk.cyan(metrics.embCount)} | git-commit: ${chalk.cyan(metrics.gitCommitCount)}\n`);

    // Step 0: Close orphaned sessions (#60)
    const orphanSpinner = ora(opts.dryRun ? 'Checking orphaned sessions...' : 'Closing orphaned sessions...').start();
    const orphanCounts = closeOrphanedSessions({ dryRun: opts.dryRun, computeFriction: computeFrictionScore });

    if (orphanCounts.total > 0) {
      if (opts.dryRun) {
        orphanSpinner.info(`Would close ${chalk.yellow(orphanCounts.total)} orphaned sessions:`);
      } else {
        orphanSpinner.succeed(`Closed ${chalk.green(orphanCounts.total)} orphaned sessions.`);
      }
      if (orphanCounts.importSessions) console.log(`    ${orphanCounts.importSessions} import-git sessions`);
      if (orphanCounts.realSessions) console.log(`    ${orphanCounts.realSessions} real sessions (>4h without Stop hook)`);
    } else {
      orphanSpinner.succeed('No orphaned sessions.');
    }

    // Step 0.5: Backfill friction_score for existing sessions (#68)
    const { getDb } = await import('./src/db.js');
    const db = getDb();
    const zeroFriction = db.prepare(`
      SELECT s.id FROM sessions s
      WHERE s.friction_score = 0
        AND EXISTS (SELECT 1 FROM observations o WHERE o.session_id = s.id)
    `).all();
    if (zeroFriction.length > 0 && !opts.dryRun) {
      const frictionSpinner = ora('Backfilling friction scores...').start();
      const upd = db.prepare('UPDATE sessions SET friction_score = ? WHERE id = ?');
      let updated = 0;
      for (const { id } of zeroFriction) {
        const score = computeFrictionScore(id);
        if (score > 0) { upd.run(score, id); updated++; }
      }
      frictionSpinner.succeed(`Backfilled friction_score for ${chalk.green(updated)}/${zeroFriction.length} sessions.`);
    } else if (zeroFriction.length > 0) {
      console.log(`  Would backfill friction_score for ${chalk.yellow(zeroFriction.length)} sessions.`);
    }

    // Step 1: Compact — strip raw_input/raw_output from old low-value observations
    const compactSpinner = ora(opts.dryRun ? 'Calculating compact...' : 'Compacting raw data...').start();
    const compactCounts = compact({ dryRun: opts.dryRun });

    if (compactCounts.total > 0) {
      if (opts.dryRun) {
        compactSpinner.info(`Would compact ${chalk.yellow(compactCounts.total)} items:`);
      } else {
        compactSpinner.succeed(`Compacted ${chalk.green(compactCounts.total)} items.`);
      }
      if (compactCounts.embGit) console.log(`    ${compactCounts.embGit} git-commit embeddings pruned (~${(compactCounts.embGit * 6 / 1024).toFixed(1)}MB)`);
      if (compactCounts.embLow) console.log(`    ${compactCounts.embLow} low-importance embeddings pruned (~${(compactCounts.embLow * 6 / 1024).toFixed(1)}MB)`);
      if (compactCounts.rawCompacted) console.log(`    ${compactCounts.rawCompacted} observations raw data stripped`);
    } else {
      compactSpinner.succeed('Nothing to compact.');
    }

    // Step 2: Retention — delete old observations by tiered importance
    const retSpinner = ora(opts.dryRun ? 'Calculating retention cleanup...' : 'Running retention cleanup...').start();
    const counts = cleanup({ dryRun: opts.dryRun, vacuum: false });

    if (counts.total > 0) {
      if (opts.dryRun) {
        retSpinner.info(`Would delete ${chalk.yellow(counts.total)} observations:`);
      } else {
        retSpinner.succeed(`Deleted ${chalk.green(counts.total)} observations.`);
      }
      if (counts.lowImportance) console.log(`    ${counts.lowImportance} low importance (<0.3, >60 days)`);
      if (counts.medImportance) console.log(`    ${counts.medImportance} medium importance (0.3–0.7, >180 days)`);
      if (counts.highImportance) console.log(`    ${counts.highImportance} high importance (≥0.7, >365 days)`);
      if (counts.gitCommit) console.log(`    ${counts.gitCommit} old git-commit (importance <0.5, >14 days, beyond top 50/project)`);
      if (counts.hookErrors) console.log(`    ${counts.hookErrors} hook_errors (>30 days — #89)`);
    } else {
      retSpinner.succeed('Nothing to delete — all data within retention policy.');
    }

    // Step 2.5: Cowork noise + duplicate sweep (#93) — opt-in because it's
    // destructive and scoped to already-imported Cowork observations.
    let coworkCounts = { total: 0, noise: 0, duplicates: 0 };
    if (opts.coworkNoise) {
      const cSpinner = ora(opts.dryRun ? 'Scanning Cowork noise/dupes...' : 'Deleting Cowork noise/dupes...').start();
      coworkCounts = cleanupCoworkNoise({ dryRun: opts.dryRun });
      if (coworkCounts.total > 0) {
        if (opts.dryRun) {
          cSpinner.info(`Would delete ${chalk.yellow(coworkCounts.total)} Cowork observations:`);
        } else {
          cSpinner.succeed(`Deleted ${chalk.green(coworkCounts.total)} Cowork observations.`);
        }
        if (coworkCounts.noise) console.log(`    ${coworkCounts.noise} noise (empty TodoWrite / screenshots / 'Да' / short assistant replies)`);
        if (coworkCounts.duplicates) console.log(`    ${coworkCounts.duplicates} intra-session duplicate tool calls`);
      } else {
        cSpinner.succeed('No Cowork noise found.');
      }
    }

    // Step 2.6: System session sweep — remove self-observations from scheduled tasks
    let sysCounts = { sessions: 0, observations: 0 };
    if (opts.systemSessions) {
      const sSpinner = ora(opts.dryRun ? 'Scanning system session observations...' : 'Removing system session observations...').start();
      sysCounts = cleanupSystemSessionObservations({ dryRun: opts.dryRun });
      if (sysCounts.observations > 0) {
        if (opts.dryRun) {
          sSpinner.info(`Would delete ${chalk.yellow(sysCounts.observations)} observations from ${sysCounts.sessions} system sessions (analyzer/dev-agent/insights):`);
        } else {
          sSpinner.succeed(`Deleted ${chalk.green(sysCounts.observations)} observations from ${sysCounts.sessions} system sessions.`);
        }
      } else {
        sSpinner.succeed('No system session observations found.');
      }
    }

    // Step 3: VACUUM to reclaim disk space
    if (opts.vacuum !== false && !opts.dryRun && (compactCounts.total > 0 || counts.total > 0 || coworkCounts.total > 0 || sysCounts.observations > 0)) {
      const vacSpinner = ora('Running VACUUM to reclaim disk space...').start();
      const { getDb } = await import('./src/db.js');
      getDb().exec('VACUUM');
      const after = getDbMetrics();
      vacSpinner.succeed(`VACUUM done. DB size: ${chalk.cyan(metrics.fileSizeMB + 'MB')} → ${chalk.green(after.fileSizeMB + 'MB')}`);
    }
    console.log('');
  });

// ─── compact (#76) ───────────────────────────────────────────────────────

program.command('compact')
  .description('Quick compaction: strip raw data & prune old embeddings (no retention delete)')
  .option('--dry-run', 'Show what would be compacted without changes')
  .option('--vacuum', 'Run VACUUM after compaction to reclaim disk space')
  .action(async (opts) => {
    const { compact, getDbMetrics } = await import('./src/db.js');
    const ora = (await import('ora')).default;

    const before = getDbMetrics();
    console.log(chalk.bold('\n  Claudeye Compact\n'));
    console.log(`  DB size: ${chalk.cyan(before.fileSizeMB + 'MB')} | Observations: ${chalk.cyan(before.obsCount)} | Embeddings: ${chalk.cyan(before.embCount)}\n`);

    const spinner = ora(opts.dryRun ? 'Calculating...' : 'Compacting...').start();
    const result = compact({ dryRun: opts.dryRun });

    if (result.total > 0) {
      if (opts.dryRun) {
        spinner.info(`Would compact ${chalk.yellow(result.total)} items:`);
      } else {
        spinner.succeed(`Compacted ${chalk.green(result.total)} items.`);
      }
      if (result.embGit) console.log(`    ${result.embGit} git-commit embeddings pruned (~${(result.embGit * 6 / 1024).toFixed(1)}MB)`);
      if (result.embLow) console.log(`    ${result.embLow} low-importance embeddings pruned (~${(result.embLow * 6 / 1024).toFixed(1)}MB)`);
      if (result.rawCompacted) console.log(`    ${result.rawCompacted} observations raw data stripped`);
    } else {
      spinner.succeed('Nothing to compact.');
    }

    if (opts.vacuum && !opts.dryRun && result.total > 0) {
      const vacSpinner = ora('Running VACUUM...').start();
      const { getDb } = await import('./src/db.js');
      getDb().exec('VACUUM');
      const after = getDbMetrics();
      vacSpinner.succeed(`VACUUM done. DB size: ${chalk.cyan(before.fileSizeMB + 'MB')} → ${chalk.green(after.fileSizeMB + 'MB')}`);
    }
    console.log('');
  });

// ─── archive (#30) ────────────────────────────────────────────────────────

program.command('archive')
  .description('Move old low/medium importance observations to archive.db (hot/cold split)')
  .option('--days <n>', 'Archive observations older than N days (default 14)', '14')
  .option('--keep-importance <n>', 'Keep observations with importance >= N in hot DB (default 0.7)', '0.7')
  .option('--dry-run', 'Show what would be archived without making changes')
  .option('--no-vacuum', 'Skip VACUUM after archiving (faster, does not reclaim disk space)')
  .action(async (opts) => {
    const { archiveObservations, getDbMetrics, ARCHIVE_PATH } = await import('./src/db.js');
    const ora = (await import('ora')).default;

    const olderThanDays  = parseInt(opts.days, 10);
    const keepImportance = parseFloat(opts.keepImportance);

    if (isNaN(olderThanDays) || olderThanDays < 1) {
      console.error(chalk.red('  --days must be a positive integer')); process.exit(1);
    }
    if (isNaN(keepImportance) || keepImportance < 0 || keepImportance > 1) {
      console.error(chalk.red('  --keep-importance must be 0.0–1.0')); process.exit(1);
    }

    const before = getDbMetrics();
    console.log(chalk.bold('\n  Claudeye Archive (hot/cold split)\n'));
    console.log(`  Hot DB: ${chalk.cyan(before.fileSizeMB + 'MB')} | ${chalk.cyan(before.obsCount)} observations`);
    console.log(`  Archive: ${chalk.gray(ARCHIVE_PATH)}\n`);
    console.log(`  Policy: observations older than ${chalk.yellow(olderThanDays + 'd')} with importance < ${chalk.yellow(keepImportance)} → archive.db`);
    console.log(`  Keeping: importance >= ${chalk.green(keepImportance)} and all observations < ${chalk.green(olderThanDays + 'd')} old in hot DB\n`);

    if (opts.dryRun) {
      const result = archiveObservations({ olderThanDays, keepImportance, dryRun: true });
      if (result.archived === 0) {
        console.log(chalk.green('  Nothing to archive — hot DB is within policy.\n'));
      } else {
        console.log(chalk.yellow(`  Would archive ${chalk.bold(result.archived)} observations to archive.db.\n`));
      }
      return;
    }

    const spinner = ora('Archiving observations...').start();
    const result = archiveObservations({ olderThanDays, keepImportance, vacuum: opts.vacuum !== false });

    if (result.archived === 0) {
      spinner.succeed('Nothing to archive — hot DB is within policy.');
    } else {
      const freedStr = result.freedMB != null ? chalk.green(` | Freed: ~${result.freedMB}MB`) : '';
      spinner.succeed(`Archived ${chalk.green(result.archived)} observations.${freedStr}`);
      const after = getDbMetrics();
      console.log(`\n  Hot DB: ${chalk.cyan(before.fileSizeMB + 'MB')} → ${chalk.green(after.fileSizeMB + 'MB')} | ${before.obsCount} → ${chalk.green(after.obsCount)} observations`);
      console.log(`  Archive: ${chalk.gray(result.archivePath)}`);
    }
    console.log('');
  });

// ─── clear ────────────────────────────────────────────────────────────────

program.command('clear')
  .description('Clear observations (all or by project)')
  .option('-p, --project <path>', 'Clear only this project')
  .option('--yes', 'Skip confirmation')
  .action(async (opts) => {
    if (!opts.yes) {
      const { createInterface } = await import('readline');
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise(res => rl.question(
        chalk.red(`\n⚠️  This will delete ${opts.project ? `observations for ${opts.project}` : 'ALL observations'}. Type "yes" to confirm: `),
        res
      ));
      rl.close();
      if (answer.trim().toLowerCase() !== 'yes') {
        console.log(chalk.gray('\nAborted.\n'));
        return;
      }
    }

    const { getDb } = await import('./src/db.js');
    const db = getDb();
    if (opts.project) {
      db.prepare('DELETE FROM observations WHERE project = ?').run(opts.project);
    } else {
      db.prepare('DELETE FROM observations').run();
      db.prepare('DELETE FROM sessions').run();
    }
    console.log(chalk.green('\n✓ Cleared.\n'));
  });



// ─── import ───────────────────────────────────────────────────────────────
program.command('import')
  .description('Import history from external sources')
  .argument('<source>', 'Source type: git | github | notion | jira | linear | slack | cowork')
  .option('-p, --path <path>', 'Repository path (git)', process.cwd())
  .option('--since <date>', 'Only import commits since date (git)')
  .option('-n, --limit <n>', 'Max items to import (git | jira | linear)')
  .option('--skip-ai', 'Skip AI compression (faster, less rich)')
  .option('--force', 'Re-import sessions already in import_sources (cowork)')
  .option('--token <token>', 'API token (github: GITHUB_TOKEN | notion: NOTION_API_KEY | jira: JIRA_API_TOKEN | linear: LINEAR_API_KEY | slack: SLACK_TOKEN)')
  .option('--repo <owner/name>', 'GitHub repository (github)')
  .option('--state <state>', 'Issue/PR state filter: open | closed | all (github, default: all)')
  .option('--database-only', 'Import only database rows (notion)')
  .option('--pages-only', 'Import only standalone pages (notion)')
  .option('--project <label>', 'Project label for imported observations')
  .option('--url <url>', 'Jira base URL (e.g. https://<workspace>.atlassian.net) — or set JIRA_URL')
  .option('--email <email>', 'Jira account email for API token auth — or set JIRA_EMAIL')
  .option('--jql <jql>', 'Custom JQL (jira)')
  .option('--project-key <key>', 'Restrict to Jira project key (jira)')
  .option('--sprints', 'Import sprint data instead of issues (jira)')
  .option('--board <id>', 'Restrict sprint import to a board id (jira)')
  .option('--team <key>', 'Restrict to Linear team key (linear)')
  .option('--channel <names>', 'Comma-separated channel names or C-ids (slack, default: all member channels)')
  .option('--days <n>', 'Lookback window in days (slack, default: 30)')
  .action(async (source, opts) => {
    const ora = (await import('ora')).default;

    // ── git ──────────────────────────────────────────────────────────
    if (source === 'git') {
      const { importGit } = await import('./src/import.js');
      const repoPath = opts.path;
      const spinner = ora(`Importing git history from ${repoPath}...`).start();
      try {
        const result = await importGit(repoPath, {
          since: opts.since || null,
          limit: opts.limit ? parseInt(opts.limit) : null,
          skipAi: opts.skipAi || false,
        });
        if (result.error) {
          spinner.warn(result.error);
        } else {
          spinner.succeed(`Imported ${result.imported} commits (${result.skipped} skipped) from ${result.total} total`);
        }
      } catch (err) {
        spinner.fail(err.message);
      }
      return;
    }

    // ── github (#23, read-first) ─────────────────────────────────────
    if (source === 'github') {
      const token = opts.token || process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
      const repo  = opts.repo;
      if (!repo || !token) {
        console.log(chalk.red(`
  GitHub requires: --repo <owner/name> --token <personal-access-token>
  (or set GITHUB_TOKEN / GH_TOKEN env var; gh users: --token "$(gh auth token)")

  Create a token: https://github.com/settings/tokens (repo read scope)
`));
        return;
      }

      const { importGitHub } = await import('./src/import-github.js');
      const spinner = ora(`Connecting to GitHub API (${repo})...`).start();
      let lastMsg = '';
      try {
        const result = await importGitHub({ repo, token }, {
          skipAi: opts.skipAi || false,
          state:  opts.state  || 'all',
          since:  opts.since  || null,
          limit:  opts.limit ? parseInt(opts.limit) : null,
          label:  opts.project || repo.split('/')[1],
          onProgress: ({ done, total }) => {
            const msg = `Importing GitHub issues/PRs... ${done}/${total}`;
            if (msg !== lastMsg) { spinner.text = msg; lastMsg = msg; }
          },
        });
        spinner.succeed(
          `GitHub import complete: ${result.imported} imported, ` +
          `${result.skipped} skipped, ${result.errors} errors (${result.total} seen)`
        );
      } catch (err) {
        spinner.fail(`GitHub import failed: ${err.message}`);
      }
      return;
    }

    // ── notion ───────────────────────────────────────────────────────
    if (source === 'notion') {
      const token = opts.token || process.env.NOTION_API_KEY;
      if (!token) {
        console.log(chalk.red(`
  Notion integration token required.
  Pass --token <token> or set NOTION_API_KEY environment variable.

  To create a token: https://www.notion.so/my-integrations
  Then share the pages/databases you want to import with your integration.
`));
        return;
      }

      const { importNotion } = await import('./src/import-notion.js');
      const spinner = ora('Connecting to Notion API...').start();
      let lastMsg = '';
      try {
        const result = await importNotion(token, {
          skipAi:       opts.skipAi       || false,
          databaseOnly: opts.databaseOnly || false,
          pagesOnly:    opts.pagesOnly    || false,
          project:      opts.project,
          onProgress: ({ done, total }) => {
            const msg = `Importing Notion content... ${done}/${total}`;
            if (msg !== lastMsg) { spinner.text = msg; lastMsg = msg; }
          },
        });
        spinner.succeed(
          `Notion import complete: ${result.imported} items imported, ` +
          `${result.skipped} skipped, ${result.errors} errors (${result.total} accessible total)`
        );
      } catch (err) {
        spinner.fail(`Notion import failed: ${err.message}`);
      }
      return;
    }

    // ── jira ────────────────────────────────────────────────────────
    if (source === 'jira') {
      const baseUrl = opts.url   || process.env.JIRA_URL;
      const email   = opts.email || process.env.JIRA_EMAIL;
      const token   = opts.token || process.env.JIRA_API_TOKEN;
      if (!baseUrl || !email || !token) {
        console.log(chalk.red(`
  Jira requires: --url <https://workspace.atlassian.net> --email <you@example.com> --token <api-token>
  (or set JIRA_URL, JIRA_EMAIL, JIRA_API_TOKEN env vars)

  Create an API token: https://id.atlassian.com/manage-profile/security/api-tokens
`));
        return;
      }

      const { importJira, importJiraSprints } = await import('./src/import-jira.js');
      const spinner = ora('Connecting to Jira API...').start();
      let lastMsg = '';

      // ── sprint data (#23) ──
      if (opts.sprints) {
        try {
          const result = await importJiraSprints({ baseUrl, email, token }, {
            project: opts.projectKey || null,
            board:   opts.board ? parseInt(opts.board) : null,
            limit:   opts.limit ? parseInt(opts.limit) : null,
            label:   opts.project || 'jira',
            onProgress: ({ done, current }) => {
              const msg = `Importing Jira sprints... ${done} (${current})`;
              if (msg !== lastMsg) { spinner.text = msg; lastMsg = msg; }
            },
          });
          spinner.succeed(
            `Jira sprint import complete: ${result.imported} imported, ` +
            `${result.skipped} skipped, ${result.errors} errors (${result.boards} boards)`
          );
        } catch (err) {
          spinner.fail(`Jira sprint import failed: ${err.message}`);
        }
        return;
      }

      try {
        const result = await importJira({ baseUrl, email, token }, {
          skipAi:  opts.skipAi  || false,
          jql:     opts.jql     || null,
          project: opts.projectKey || null,
          limit:   opts.limit ? parseInt(opts.limit) : null,
          label:   opts.project || 'jira',
          onProgress: ({ done, total }) => {
            const msg = `Importing Jira issues... ${done}/${total}`;
            if (msg !== lastMsg) { spinner.text = msg; lastMsg = msg; }
          },
        });
        spinner.succeed(
          `Jira import complete: ${result.imported} imported, ` +
          `${result.skipped} skipped, ${result.errors} errors (${result.total} total)`
        );
      } catch (err) {
        spinner.fail(`Jira import failed: ${err.message}`);
      }
      return;
    }

    // ── linear ──────────────────────────────────────────────────────
    if (source === 'linear') {
      const token = opts.token || process.env.LINEAR_API_KEY;
      if (!token) {
        console.log(chalk.red(`
  Linear API key required.
  Pass --token <api-key> or set LINEAR_API_KEY environment variable.

  Create an API key: https://linear.app/settings/api
`));
        return;
      }

      const { importLinear } = await import('./src/import-linear.js');
      const spinner = ora('Connecting to Linear API...').start();
      let lastMsg = '';
      try {
        const result = await importLinear(token, {
          skipAi: opts.skipAi || false,
          team:   opts.team   || null,
          limit:  opts.limit ? parseInt(opts.limit) : null,
          label:  opts.project || 'linear',
          onProgress: ({ done, total }) => {
            const msg = `Importing Linear issues... ${done}/${total}`;
            if (msg !== lastMsg) { spinner.text = msg; lastMsg = msg; }
          },
        });
        spinner.succeed(
          `Linear import complete: ${result.imported} imported, ` +
          `${result.skipped} skipped, ${result.errors} errors (${result.total} seen)`
        );
      } catch (err) {
        spinner.fail(`Linear import failed: ${err.message}`);
      }
      return;
    }

    // ── slack (#23, read-first) ──────────────────────────────────────
    if (source === 'slack') {
      const token = opts.token || process.env.SLACK_TOKEN || process.env.SLACK_BOT_TOKEN;
      if (!token) {
        console.log(chalk.red(`
  Slack token required (xoxb-/xoxp- with channels:read + channels:history).
  Pass --token <token> or set SLACK_TOKEN / SLACK_BOT_TOKEN env var.

  Create an app token: https://api.slack.com/apps → OAuth & Permissions
`));
        return;
      }

      const { importSlack } = await import('./src/import-slack.js');
      const spinner = ora('Connecting to Slack API...').start();
      let lastMsg = '';
      try {
        const result = await importSlack({ token }, {
          skipAi:  opts.skipAi || false,
          channel: opts.channel || null,
          days:    opts.days ? parseInt(opts.days) : 30,
          limit:   opts.limit ? parseInt(opts.limit) : null,
          label:   opts.project || 'slack',
          onProgress: ({ done, total }) => {
            const msg = `Importing Slack messages/threads... ${done}/${total}`;
            if (msg !== lastMsg) { spinner.text = msg; lastMsg = msg; }
          },
        });
        spinner.succeed(
          `Slack import complete: ${result.imported} imported, ` +
          `${result.skipped} skipped, ${result.errors} errors ` +
          `(${result.total} seen in ${result.channels} channels)`
        );
      } catch (err) {
        spinner.fail(`Slack import failed: ${err.message}`);
      }
      return;
    }

    // ── cowork (#88) ─────────────────────────────────────────────────
    if (source === 'cowork') {
      const { importAllCoworkSessions, listCoworkSessions } = await import('./src/import-cowork.js');
      const sessions = listCoworkSessions();
      if (!sessions.length) {
        console.log(chalk.yellow(`
  No Cowork sessions found.
  Looked in ~/Library/Application Support/Claude/local-agent-mode-sessions/
`));
        return;
      }
      const spinner = ora(`Importing ${sessions.length} Cowork sessions...`).start();
      try {
        const result = await importAllCoworkSessions({ force: opts.force || false });
        const dropped = (result.noiseDropped || 0) + (result.dedupDropped || 0);
        const embStr = result.embeddings ? `, ${result.embeddings} embeddings` : '';
        spinner.succeed(
          `Cowork import: ${result.imported} imported, ${result.skipped} skipped, ` +
          `${result.errors} errors — ${result.observations} observations${embStr} from ${result.total} sessions` +
          (dropped ? ` (filtered ${result.noiseDropped} noise + ${result.dedupDropped} dups from ${result.rawEvents} raw)` : '')
        );
        // Surface projects touched so user can validate what ended up where.
        const byProject = new Map();
        for (const d of result.details) {
          if (!d.project || !d.imported) continue;
          byProject.set(d.project, (byProject.get(d.project) || 0) + d.imported);
        }
        if (byProject.size) {
          console.log(chalk.bold('\n  Observations by project:'));
          for (const [p, n] of [...byProject.entries()].sort((a, b) => b[1] - a[1])) {
            const short = p.replace(process.env.HOME, '~');
            console.log(`    ${chalk.green(short.padEnd(60))} ${chalk.yellow(n)}`);
          }
        }
      } catch (err) {
        spinner.fail(`Cowork import failed: ${err.message}`);
      }
      return;
    }

    console.log(chalk.red(`
  Unknown source: ${source}. Supported: git | notion | jira | linear | cowork
`));
  });

// ─── reindex ─────────────────────────────────────────────────────────────

program.command('reindex')
  .description('Rebuild embeddings for observations (missing or degraded)')
  .option('--force', 'Re-embed ALL observations, even those with 1536-dim vectors')
  .option('-p, --project <path>', 'Scope to a specific project')
  .option('-b, --batch <n>', 'Batch size', '50')
  .option('--delay <ms>', 'Delay between batches in ms', '500')
  .action(async (opts) => {
    const { reindex } = await import('./src/reindex.js');
    const ora = (await import('ora')).default;

    const spinner = ora('Counting observations to reindex...').start();

    try {
      const result = await reindex({
        force: opts.force || false,
        project: opts.project || null,
        batchSize: parseInt(opts.batch),
        delayMs: parseInt(opts.delay),
        onProgress: ({ done, total }) => {
          spinner.text = `Reindexing embeddings... ${done}/${total}`;
        },
      });

      if (result.total === 0) {
        spinner.succeed('All observations already have 1536-dim embeddings. Nothing to do.');
      } else {
        spinner.succeed(
          `Done! ${chalk.green(result.reindexed)} reindexed, ${chalk.yellow(result.skipped)} skipped, ${chalk.red(result.errors)} errors (${result.total} total)`
        );
      }
    } catch (err) {
      spinner.fail(err.message);
    }
  });

// ─── decisions (#25) ─────────────────────────────────────────────────────

program.command('decisions')
  .description('List architectural decisions recorded in this project')
  .option('-p, --project <path>', 'Filter by project', process.cwd())
  .option('-n, --limit <n>', 'Max results', '20')
  .option('--all', 'Show decisions across all projects')
  .action(async (opts) => {
    const { getDb } = await import('./src/db.js');
    const db = getDb();
    const limit = parseInt(opts.limit);

    let rows;
    if (opts.all) {
      rows = db.prepare(`
        SELECT summary, decision_rationale, project, importance, created_at
        FROM observations
        WHERE decision_rationale IS NOT NULL
        ORDER BY importance DESC, created_at DESC
        LIMIT ?
      `).all(limit);
    } else {
      rows = db.prepare(`
        SELECT summary, decision_rationale, project, importance, created_at
        FROM observations
        WHERE decision_rationale IS NOT NULL AND project = ?
        ORDER BY importance DESC, created_at DESC
        LIMIT ?
      `).all(opts.project, limit);
    }

    if (!rows.length) {
      console.log(chalk.yellow('\n  No decisions recorded yet.'));
      console.log(chalk.gray('  Decisions are auto-extracted when Claude Code makes architectural choices.\n'));
      return;
    }

    console.log(chalk.bold(`\n  Decisions${opts.all ? ' (all projects)' : ''}\n`));
    for (const r of rows) {
      const proj = r.project.replace(process.env.HOME, '~').split('/').pop();
      const imp = r.importance >= 0.9 ? chalk.red('●') : chalk.yellow('●');
      console.log(`  ${imp} ${chalk.white(r.decision_rationale)}`);
      console.log(`    ${chalk.gray(r.summary.slice(0, 100))}`);
      console.log(`    ${chalk.gray(r.created_at)}  ${chalk.cyan(proj)}\n`);
    }
  });

// ─── handoff ─────────────────────────────────────────────────────────────

/**
 * Strip wrapped tool-result JSON noise from an error summary so the handoff
 * shows a meaningful reason instead of "→ ERROR: {"type":"text","file":..."
 */
function cleanErrorSummary(summary, rawOutput) {
  if (!summary) return '';
  let head = summary;
  let tail = '';
  const arrowIdx = summary.indexOf('→ ERROR:');
  if (arrowIdx !== -1) {
    head = summary.slice(0, arrowIdx).trim();
    tail = summary.slice(arrowIdx + '→ ERROR:'.length).trim();
  }
  // Try to extract a real message from raw_output JSON; fall back to tail.
  let msg = extractErrorMessage(rawOutput) || extractErrorMessage(tail) || tail;
  // Drop wrapper noise like {"type":"text","file":{...}}
  if (msg && /^\s*\{.*"type"\s*:\s*"text".*"filePath"/.test(msg)) {
    msg = msg.replace(/^.*"filePath"\s*:\s*"([^"]+)".*$/, 'file not accessible: $1');
  }
  msg = (msg || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  if (!msg) return head;
  return `${head} — ${msg}`;
}

function extractErrorMessage(text) {
  if (!text) return '';
  // Find JSON object and try to pull message/error/text fields.
  try {
    const m = String(text).match(/\{[\s\S]*\}/);
    if (m) {
      const o = JSON.parse(m[0]);
      const cand = o.message || o.error || o.text || (o.file && o.file.error);
      if (cand && typeof cand === 'string') return cand;
    }
  } catch {}
  // Look for "Error: ..." patterns.
  const errMatch = String(text).match(/(?:Error|ENOENT|EACCES)[^\n]{0,160}/);
  if (errMatch) return errMatch[0];
  return '';
}

// ─── graph (#26) ─────────────────────────────────────────────────────────

program.command('graph')
  .description('Show the Knowledge Graph for this project — top entities and relations')
  .option('-p, --project <path>', 'Project path', process.cwd())
  .option('--entity <name>', 'Show relations for a specific entity')
  .option('--type <type>', 'Filter entities by type: file|project|tool|decision|bug|person')
  .option('-n, --limit <n>', 'Max entities to show', '20')
  .option('--rebuild', 'Rebuild graph from existing observations before showing')
  .action(async (opts) => {
    const { getProjectGraph, getEntityRelations, getTopEntities, rebuildGraph } = await import('./src/graph.js');
    const ora = (await import('ora')).default;

    if (opts.rebuild) {
      const spinner = ora('Rebuilding Knowledge Graph from observations…').start();
      const { processed } = rebuildGraph({
        project: opts.project,
        onProgress: (done, total) => { spinner.text = `Rebuilding… ${done}/${total}`; },
      });
      spinner.succeed(`Rebuilt graph from ${processed} observations`);
    }

    if (opts.entity) {
      const { entity, relations } = getEntityRelations(opts.entity, opts.project);
      if (!entity) {
        console.log(chalk.yellow(`\n  Entity "${opts.entity}" not found.\n`));
        return;
      }
      console.log(chalk.bold(`\n🔗 Entity: ${chalk.cyan(entity.name)} (${entity.type})\n`));
      console.log(`  Mentioned ${chalk.yellow(entity.mention_count)} times`);
      console.log(`  First seen: ${chalk.gray(entity.first_seen.slice(0,10))}`);
      console.log(`  Last seen:  ${chalk.gray(entity.last_seen.slice(0,10))}\n`);

      if (!relations.length) {
        console.log(chalk.gray('  No relations found.\n'));
        return;
      }
      console.log(chalk.bold('  Relations:\n'));
      for (const r of relations) {
        const arrow = r.direction === 'outgoing' ? chalk.green('→') : chalk.blue('←');
        console.log(`  ${arrow} ${chalk.magenta(r.relation_type.padEnd(12))} ${chalk.cyan(r.other_name)} ${chalk.gray(`(${r.other_type}) ×${r.weight}`)}`);
      }
      console.log('');
      return;
    }

    const { entities, relations } = getProjectGraph(opts.project);
    const shortProject = opts.project.replace(process.env.HOME || '', '~');

    if (!entities.length) {
      console.log(chalk.yellow(`\n  No graph data for ${shortProject}.\n  Run: claudeye graph --rebuild\n`));
      return;
    }

    console.log(chalk.bold(`\n🕸  Knowledge Graph — ${chalk.cyan(shortProject)}\n`));
    console.log(`  Entities: ${chalk.yellow(entities.length)}   Relations: ${chalk.yellow(relations.length)}\n`);

    // Group by type
    const byType = {};
    for (const e of entities) {
      (byType[e.type] = byType[e.type] || []).push(e);
    }
    const typeOrder = ['file', 'decision', 'bug', 'tool', 'project', 'person'];
    const typeEmoji = { file: '📄', decision: '🏛', bug: '🐛', tool: '🔧', project: '📁', person: '👤' };

    const filterType = opts.type;
    const limit = parseInt(opts.limit);

    for (const t of typeOrder) {
      if (filterType && t !== filterType) continue;
      const list = byType[t];
      if (!list || !list.length) continue;
      const emoji = typeEmoji[t] || '•';
      console.log(chalk.bold(`  ${emoji}  ${t.toUpperCase()}S (${list.length})`));
      for (const e of list.slice(0, limit)) {
        const bar = '▪'.repeat(Math.min(20, e.mention_count));
        console.log(`    ${chalk.cyan(e.name.padEnd(45))} ${chalk.yellow(String(e.mention_count).padStart(4))}× ${chalk.gray(bar)}`);
      }
      if (list.length > limit) {
        console.log(chalk.gray(`    … and ${list.length - limit} more`));
      }
      console.log('');
    }

    // Top relations
    if (relations.length) {
      console.log(chalk.bold('  🔗 Top Relations\n'));
      for (const r of relations.slice(0, 15)) {
        console.log(`    ${chalk.cyan(r.source_name)} ${chalk.green('→')} ${chalk.magenta(r.relation_type)} ${chalk.green('→')} ${chalk.cyan(r.target_name)} ${chalk.gray(`×${r.weight}`)}`);
      }
      console.log('');
    }
  });

program.command('handoff')
  .description('Generate a session handoff summary — paste into a new session to continue seamlessly')
  .option('-p, --project <path>', 'Filter by project', process.cwd())
  .option('-s, --session <id>', 'Specific session ID (default: latest)')
  .action(async (opts) => {
    const { getDb } = await import('./src/db.js');
    const db = getDb();

    // Find the target session
    let session;
    if (opts.session) {
      session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(opts.session);
    } else {
      session = db.prepare(`
        SELECT * FROM sessions
        WHERE project = ? AND id NOT LIKE 'import-git-%'
        ORDER BY started_at DESC LIMIT 1
      `).get(opts.project);
    }

    if (!session) {
      console.log(chalk.yellow('\n  No session found for this project.\n'));
      return;
    }

    const proj = session.project.replace(process.env.HOME, '~').split('/').pop();

    // Gather session data — exclude errors from "what was done" so they only
    // appear in the dedicated "unresolved problems" section (no duplication).
    const recentObs = db.prepare(`
      SELECT summary, tool, importance, tags
      FROM observations
      WHERE session_id = ?
        AND importance >= 0.5
        AND (tags IS NULL OR tags NOT LIKE '%error%')
      ORDER BY importance DESC, created_at DESC
      LIMIT 10
    `).all(session.id);

    const decisions = db.prepare(`
      SELECT decision_rationale
      FROM observations
      WHERE session_id = ? AND decision_rationale IS NOT NULL
      ORDER BY importance DESC LIMIT 5
    `).all(session.id);

    const errors = db.prepare(`
      SELECT summary, raw_output FROM observations
      WHERE session_id = ? AND tags LIKE '%error%'
      ORDER BY created_at DESC LIMIT 5
    `).all(session.id);

    const fileRows = db.prepare(`
      SELECT raw_input, tool
      FROM observations
      WHERE session_id = ? AND tool IN ('Edit', 'Write') AND raw_input IS NOT NULL
      ORDER BY created_at DESC LIMIT 30
    `).all(session.id);

    // Extract clean absolute file paths from raw_input JSON, dedupe.
    const seenFiles = new Set();
    const files = [];
    for (const row of fileRows) {
      let p = null;
      try {
        const parsed = JSON.parse(row.raw_input);
        p = parsed?.file_path || parsed?.filePath || parsed?.path;
      } catch {}
      if (!p || typeof p !== 'string') continue;
      if (!p.startsWith('/')) continue;        // skip relative junk
      if (seenFiles.has(p)) continue;
      seenFiles.add(p);
      files.push(p);
      if (files.length >= 5) break;
    }

    const obsCount = db.prepare('SELECT COUNT(*) as n FROM observations WHERE session_id = ?').get(session.id).n;

    console.log(chalk.bold(`\n  Session Handoff — ${proj}\n`));
    console.log(chalk.gray(`  Session: ${session.id.slice(0, 8)}...`));
    console.log(chalk.gray(`  Started: ${session.started_at}  Prompts: ${session.prompt_count}  Observations: ${obsCount}\n`));

    // Build the handoff text
    const lines = [];
    lines.push(`Продолжаю работу над ${proj}.`);
    lines.push('');

    if (recentObs.length) {
      lines.push('Что было сделано:');
      for (const o of recentObs.slice(0, 7)) {
        lines.push(`- ${o.summary.slice(0, 150)}`);
      }
      lines.push('');
    }

    if (decisions.length) {
      lines.push('Ключевые решения:');
      for (const d of decisions) {
        lines.push(`- ${d.decision_rationale}`);
      }
      lines.push('');
    }

    if (errors.length) {
      lines.push('Нерешённые проблемы:');
      const seenErr = new Set();
      for (const e of errors) {
        const clean = cleanErrorSummary(e.summary, e.raw_output);
        if (!clean || seenErr.has(clean)) continue;
        seenErr.add(clean);
        lines.push(`- ${clean}`);
      }
      lines.push('');
    }

    if (files.length) {
      lines.push('Файлы:');
      for (const f of files) {
        lines.push(`- ${f}`);
      }
      lines.push('');
    }

    const handoff = lines.join('\n');

    // Output the handoff as a copyable block
    console.log(chalk.cyan('  ── Copy this into your new session ──────────────\n'));
    console.log(handoff);
    console.log(chalk.cyan('  ────────────────────────────────────────────────\n'));
  });

// ─── generate-claude-md (#57) ────────────────────────────────────────────

program.command('generate-claude-md')
  .description('Auto-generate CLAUDE.md hints from high-importance observations')
  .option('-p, --project <path>', 'Project path (default: current directory)')
  .option('--days <n>', 'Lookback period in days', '30')
  .option('--dry-run', 'Show suggestions without writing')
  .option('--all', 'Generate for all eligible projects')
  .action(async (opts) => {
    const { generateClaudeMd, getEligibleProjects } = await import('./scripts/generate-claude-md.js');
    const ora = (await import('ora')).default;
    const days = parseInt(opts.days) || 30;

    if (opts.all) {
      const projects = getEligibleProjects({ days });
      if (!projects.length) {
        console.log(chalk.yellow('\n  No projects with enough high-importance data.\n'));
        return;
      }
      console.log(chalk.bold(`\n  Generating CLAUDE.md for ${projects.length} projects...\n`));
      for (const p of projects) {
        const spinner = ora(`${p.project.split('/').pop()} (${p.high_imp_count} high-imp obs)`).start();
        try {
          const result = await generateClaudeMd(p.project, { days, dryRun: opts.dryRun });
          if (result) {
            spinner.succeed(`${p.project.split('/').pop()}: ${opts.dryRun ? 'preview' : 'updated'}`);
            if (opts.dryRun) console.log(chalk.gray(result.split('\n').map(l => '    ' + l).join('\n')));
          } else {
            spinner.info(`${p.project.split('/').pop()}: not enough data`);
          }
        } catch (err) {
          spinner.fail(`${p.project.split('/').pop()}: ${err.message}`);
        }
      }
      console.log('');
    } else {
      const project = opts.project || process.cwd();
      const spinner = ora('Analyzing observations...').start();
      try {
        spinner.stop();
        console.log(chalk.bold('\n  Generating CLAUDE.md hints...\n'));
        const result = await generateClaudeMd(project, { days, dryRun: opts.dryRun });
        if (result) {
          if (opts.dryRun) {
            console.log(chalk.cyan('  ── Suggested additions ──────────────────────\n'));
            console.log(result);
            console.log(chalk.cyan('\n  ────────────────────────────────────────────\n'));
          } else {
            console.log(chalk.green(`  ✓ Updated CLAUDE.md\n`));
          }
        } else {
          console.log(chalk.yellow('  Not enough high-importance observations for this project.\n'));
        }
      } catch (err) {
        console.log(chalk.red(`  Error: ${err.message}\n`));
      }
    }
  });

// ─── heatmap (#56) ───────────────────────────────────────────────────────

program.command('heatmap')
  .description('Cross-project friction heatmap: compare friction across projects')
  .option('--days <n>', 'Lookback period in days', '7')
  .option('--json', 'Output as JSON')
  .action(async (opts) => {
    const { generateProjectHeatmap, formatHeatmap } = await import('./scripts/weekly-project-report.js');
    const days = Math.max(1, Math.min(90, parseInt(opts.days) || 7));
    const data = generateProjectHeatmap({ days });

    if (opts.json) {
      console.log(JSON.stringify(data, null, 2));
    } else {
      console.log(chalk.bold(formatHeatmap(data)));
    }
  });

// ─── backfill-friction (#73) ─────────────────────────────────────────────

program.command('backfill-friction')
  .description('Recalculate friction_score for sessions with missing data')
  .option('--dry-run', 'Preview without writing changes')
  .action(async (opts) => {
    const { getDb } = await import('./src/db.js');
    const { computeFrictionScore } = await import('./src/analytics.js');
    const db = getDb();

    const sessions = db.prepare(`
      SELECT s.id, s.project, s.friction_score, COUNT(o.id) as obs_count
      FROM sessions s JOIN observations o ON o.session_id = s.id
      WHERE s.friction_score = 0 OR s.friction_score IS NULL
      GROUP BY s.id ORDER BY s.started_at DESC
    `).all();

    console.log(chalk.bold(`\n  Found ${sessions.length} sessions to backfill${opts.dryRun ? ' (DRY RUN)' : ''}\n`));
    if (!sessions.length) { console.log(chalk.green('  Nothing to backfill.\n')); return; }

    const update = db.prepare('UPDATE sessions SET friction_score = ? WHERE id = ?');
    let updated = 0;

    for (const s of sessions) {
      const score = computeFrictionScore(s.id);
      if (score === 0) continue;
      if (opts.dryRun) {
        const short = s.project.replace(process.env.HOME, '~');
        console.log(`  ${s.id.slice(0, 12)}  ${short.padEnd(45)}  ${s.obs_count} obs  → ${chalk.yellow(score.toFixed(3))}`);
      } else {
        update.run(score, s.id);
      }
      updated++;
    }

    console.log(chalk.bold(`\n  Updated: ${updated}\n`));
    if (opts.dryRun) console.log(chalk.yellow('  ⚠️  Dry run — no changes written.\n'));
  });

// ─── insights ────────────────────────────────────────────────────────────

program.command('insights')
  .description('Daily proactive insights: anomalies, quota alerts, friction patterns')
  .option('--days <n>', 'Lookback period in days', '1')
  .option('--no-notify', 'Skip macOS notification')
  .option('--json', 'Output as JSON')
  .option('--schedule',    'Install daily launchd automation (09:00)')
  .option('--unschedule',  'Remove daily launchd automation')
  .option('--status',      'Check if launchd automation is active')
  .action(async (opts) => {
    // ── Scheduler subcommands (#82) ─────────────────────────
    if (opts.schedule) {
      const { install } = await import('./scripts/insights-scheduler.js');
      const result = install();
      console.log(chalk.green('\n  ✅ Daily insights scheduled!'));
      console.log(chalk.gray(`  Schedule:   ${result.schedule}`));
      console.log(chalk.gray(`  Plist:      ${result.plist}`));
      console.log(chalk.gray(`  Wrapper:    ${result.wrapper}`));
      console.log(chalk.gray(`  Standalone: ${result.standalone}\n`));
      return;
    }
    if (opts.unschedule) {
      const { uninstall } = await import('./scripts/insights-scheduler.js');
      const result = uninstall();
      console.log(result.removed
        ? chalk.green('\n  ✅ Daily insights unscheduled.\n')
        : chalk.yellow(`\n  ${result.message}\n`));
      return;
    }
    if (opts.status) {
      const { status } = await import('./scripts/insights-scheduler.js');
      const s = status();
      if (!s.installed) {
        console.log(chalk.yellow('\n  Not scheduled. Run: claudeye insights --schedule\n'));
      } else {
        console.log(chalk.green('\n  ✅ Scheduled'));
        console.log(chalk.gray(`  Loaded: ${s.loaded}`));
        console.log(chalk.gray(`  Plist:  ${s.plist}\n`));
      }
      return;
    }

    // ── Normal run ─────────────────────────────────────────
    const { runInsights, formatReport } = await import('./scripts/daily-insights.js');

    console.log(chalk.bold('\n  Claudeye Daily Insights\n'));

    const result = await runInsights({
      days: parseInt(opts.days),
      notify: opts.notify !== false,
    });

    if (opts.json) {
      console.log(JSON.stringify(result.alerts, null, 2));
    } else {
      console.log(formatReport(result));
      const { critAlerts, warnAlerts, insightAlerts } = result;
      const total = critAlerts.length + warnAlerts.length + insightAlerts.length;
      console.log(chalk.gray(`  ${total} alerts: ${critAlerts.length} critical, ${warnAlerts.length} warnings, ${insightAlerts.length} insights\n`));
    }
  });

// ─── export (#11) ────────────────────────────────────────────────────────

program.command('export')
  .description('Export memory (sessions + observations) to a Markdown file')
  .option('--project <substring>', 'Filter by project path substring')
  .option('--since <date>',        'ISO date (YYYY-MM-DD), only sessions started on/after this date')
  .option('--output <path>',       'Output file path (default: ./claudeye-export-YYYY-MM-DD.md)')
  .option('--include-raw',         'Include raw_input / raw_output in each observation (verbose)')
  .option('--no-git',              'Skip git-commit observations')
  .action(async (opts) => {
    const { runExport } = await import('./src/export.js');

    console.log(chalk.bold('\n  Claudeye Export\n'));

    try {
      const result = runExport({
        project:     opts.project || null,
        since:       opts.since   || null,
        output:      opts.output  || null,
        includeGit:  opts.git !== false,
        includeRaw:  !!opts.includeRaw,
      });

      const sizeKB = (result.sizeBytes / 1024).toFixed(1);
      console.log(chalk.green(`  ✓ Exported ${result.sessions} sessions · ${result.observations} observations · ${result.projects} projects`));
      console.log(chalk.gray(`    File: ${result.outputPath} (${sizeKB} KB)\n`));
    } catch (e) {
      console.error(chalk.red(`  ✗ Export failed: ${e.message}\n`));
      process.exit(1);
    }
  });

// ─── share (#33) ─────────────────────────────────────────────────────────────

program.command('share')
  .description('Share your dashboard via a read-only link')
  .option('--project <path>',    'Scope share to a specific project path (default: all projects)')
  .option('--label <text>',      'Human-readable label shown in the shared view')
  .option('--ttl <days>',        'Link validity in days (default: 7)', '7')
  .option('--list',              'List all active share links')
  .option('--revoke <token>',    'Revoke a share link by token (or token prefix)')
  .option('--port <port>',       'Port the viewer is running on (default: 47777)', '47777')
  .action(async (opts) => {
    const { createShareToken, listShareTokens, revokeShareToken } = await import('./src/db.js');

    console.log(chalk.bold('\n  Claudeye Share\n'));

    // ── List ──
    if (opts.list) {
      const tokens = listShareTokens();
      if (!tokens.length) {
        console.log(chalk.gray('  No active share links.\n'));
        return;
      }
      for (const t of tokens) {
        const proj = t.project ? chalk.cyan(t.project.split('/').pop()) : chalk.gray('all projects');
        const label = t.label ? chalk.white(t.label) + ' ' : '';
        const exp = chalk.gray(`expires ${t.expires_at.slice(0, 10)}`);
        console.log(`  ${label}${chalk.dim(t.token.slice(0, 8)+'…')}  ${proj}  ${exp}`);
        console.log(chalk.gray(`    http://localhost:${opts.port}/shared/${t.token}`));
      }
      console.log();
      return;
    }

    // ── Revoke ──
    if (opts.revoke) {
      const ok = revokeShareToken(opts.revoke);
      if (ok) {
        console.log(chalk.green(`  ✓ Share link revoked.\n`));
      } else {
        console.log(chalk.yellow(`  ⚠ No matching share link found.\n`));
      }
      return;
    }

    // ── Create ──
    const ttlDays = Math.max(1, Math.min(365, parseInt(opts.ttl, 10) || 7));
    const { token, expiresAt } = createShareToken({
      project: opts.project || null,
      label:   opts.label   || (opts.project ? opts.project.split('/').pop() : ''),
      ttlDays,
    });
    const port = parseInt(opts.port, 10) || 47777;
    const url = `http://localhost:${port}/shared/${token}`;

    console.log(chalk.green('  ✓ Share link created!\n'));
    console.log(chalk.white(`  URL:     `) + chalk.cyan(url));
    console.log(chalk.white(`  Token:   `) + chalk.dim(token));
    console.log(chalk.white(`  Expires: `) + chalk.gray(expiresAt.slice(0, 10)));
    if (opts.project) {
      console.log(chalk.white(`  Scope:   `) + chalk.gray(opts.project));
    }
    console.log();
    console.log(chalk.gray('  To share with a colleague, expose port ' + port + ' and send them the URL.'));
    console.log(chalk.gray('  To revoke: claudeye share --revoke ' + token.slice(0, 8) + '\n'));
  });

// Register analytics commands (analytics, advise, rate, digest)
registerAnalyticsCommands(program);

// ─── invariants (#99) ────────────────────────────────────────────────────────

program.command('invariants')
  .description('Run invariant checks — structured stability verification')
  .option('--json', 'Output raw JSON')
  .option('--save', 'Persist result to invariant_checks table (default when run standalone)')
  .option('--no-save', 'Do not persist (default for interactive runs)')
  .action(async (opts) => {
    const { checkInvariants, saveInvariantRun, getStabilityStreak } = await import('./src/invariants.js');
    const { getDb } = await import('./src/db.js');
    const db = getDb();

    const ora = (await import('ora')).default;
    const spinner = opts.json ? null : ora('Checking invariants...').start();

    const result = await checkInvariants(db);
    if (spinner) spinner.stop();

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    // Human-readable output
    const greenChecks = result.checks.filter(c => c.status === 'green');
    const redChecks   = result.checks.filter(c => c.status === 'red');
    const skipped     = result.checks.filter(c => c.status === 'skipped');

    console.log(chalk.bold('\n  Claudeye Invariants\n'));
    for (const c of result.checks) {
      const icon = c.status === 'green'   ? chalk.green('✓')
                 : c.status === 'red'     ? chalk.red('✗')
                 : chalk.gray('~');
      const idStr = chalk.bold(c.id.padEnd(12));
      const detail = c.status === 'red' ? chalk.yellow(c.detail) : chalk.gray(c.detail);
      console.log(`  ${icon} ${idStr} ${detail}`);
    }

    console.log('');
    if (result.all_green) {
      console.log(chalk.green(`  ✅ All ${greenChecks.length} invariants green` + (skipped.length ? chalk.gray(` (${skipped.length} skipped)`) : '') + '\n'));
    } else {
      console.log(chalk.red(`  ❌ ${redChecks.length} violation${redChecks.length !== 1 ? 's' : ''}: ${result.violations.join(', ')}`));
      console.log(chalk.gray(`     ${greenChecks.length} green, ${skipped.length} skipped\n`));
    }

    // Stability streak
    const streak = getStabilityStreak(db);
    if (streak.streak > 0) {
      const mvp = streak.mvpGate ? chalk.green(' 🎉 MVP gate ready!') : chalk.gray(` (${14 - streak.streak} days to MVP gate)`);
      console.log(chalk.cyan(`  Stability streak: ${streak.streak} day${streak.streak !== 1 ? 's' : ''} all-green`) + mvp + '\n');
    }

    // Persist if --save flag
    if (opts.save) {
      db.prepare(`
        INSERT OR REPLACE INTO invariant_checks (run_date, all_green, green_count, red_count, violations, result_json)
        VALUES (date('now'), ?, ?, ?, ?, ?)
      `).run(
        result.all_green ? 1 : 0,
        greenChecks.length,
        redChecks.length,
        JSON.stringify(result.violations),
        JSON.stringify(result.checks),
      );
      console.log(chalk.gray('  Saved to invariant_checks.\n'));
    }
  });

// ─── stability (#99) ─────────────────────────────────────────────────────────

program.command('stability')
  .description('Show invariant stability streak — days of consecutive all-green runs')
  .option('--days <n>', 'History to show', '14')
  .action(async (opts) => {
    const { getStabilityStreak } = await import('./src/invariants.js');
    const { getDb } = await import('./src/db.js');
    const db = getDb();

    const streak = getStabilityStreak(db);
    const days   = parseInt(opts.days) || 14;

    const history = db.prepare(`
      SELECT run_date, all_green, green_count, red_count, violations
      FROM invariant_checks
      ORDER BY run_date DESC
      LIMIT ?
    `).all(days);

    console.log(chalk.bold('\n  Claudeye Stability\n'));

    if (!history.length) {
      console.log(chalk.yellow('  No invariant runs yet. Run: claudeye invariants --save\n'));
      return;
    }

    for (const row of history) {
      const icon = row.all_green ? chalk.green('✅') : chalk.red('❌');
      const viols = row.all_green ? '' : chalk.yellow(` — ${JSON.parse(row.violations).join(', ')}`);
      console.log(`  ${icon} ${row.run_date}  ${chalk.gray(`${row.green_count}✓ ${row.red_count}✗`)}${viols}`);
    }

    console.log('');
    if (streak.streak > 0) {
      const bar = '█'.repeat(Math.min(streak.streak, 30));
      console.log(`  Streak: ${chalk.green(bar)} ${chalk.bold(streak.streak)} day${streak.streak !== 1 ? 's' : ''}`);
      if (streak.mvpGate) {
        console.log(chalk.green('\n  🎉 MVP gate ready! 14+ consecutive days all-green.\n'));
      } else {
        console.log(chalk.gray(`\n  ${14 - streak.streak} more day${14 - streak.streak !== 1 ? 's' : ''} to MVP gate.\n`));
      }
    } else {
      console.log(chalk.red('  Streak: 0 — last run had violations.\n'));
    }
  });

// ─── agent (#20) ─────────────────────────────────────────────────────────────

const agentCmd = program.command('agent')
  .description('Agent v1 — automated tasks using Claudeye memory as context');

agentCmd
  .command('context <query>')
  .description('Cross-repo context: search across ALL projects for a query')
  .option('-p, --project <path>', 'Current project (for logging)', process.cwd())
  .option('-n, --limit <n>',      'Max results',                   '15')
  .option('--dry-run',            'Show results without logging',  false)
  .action(async (query, opts) => {
    const { crossRepoContext } = await import('./src/agent.js');
    const ora = (await import('ora')).default;

    const spinner = ora(`Searching across all projects for: "${query}"`).start();
    try {
      const { results, projects, totalResults } = await crossRepoContext(query, {
        project: opts.project,
        limit:   parseInt(opts.limit, 10),
        dryRun:  !!opts.dryRun,
      });
      spinner.stop();

      if (!totalResults) {
        console.log(chalk.yellow('\n  No results across any project.\n'));
        return;
      }

      const dryTag = opts.dryRun ? chalk.gray(' [dry-run]') : '';
      console.log(chalk.bold(`\n🤖 Cross-repo context: "${query}"${dryTag}\n`));

      for (const grp of projects) {
        console.log(chalk.cyan(`  📁 ${grp.shortProject}`) + chalk.gray(` (${grp.count} result${grp.count === 1 ? '' : 's'})`));
        const items = results
          .filter(o => o.project === grp.project)
          .slice(0, 3);
        for (const obs of items) {
          const score = (obs.hybridScore * 100).toFixed(1);
          const tags  = JSON.parse(obs.tags || '[]');
          const imp   = obs.importance >= 0.8 ? chalk.red('🔴') :
                        obs.importance >= 0.5 ? chalk.yellow('🟡') : chalk.green('🟢');
          console.log(`    ${imp} ${obs.summary.slice(0, 120)}`);
          if (tags.length) console.log(`       ${chalk.gray('#' + tags.slice(0, 4).join(' #'))}`);
          console.log(`       ${chalk.gray(obs.created_at.slice(0, 10))} ${chalk.yellow(`score: ${score}`)}`);
        }
        console.log('');
      }

      if (!opts.dryRun) {
        console.log(chalk.gray(`  Logged to agent_actions.\n`));
      }
    } catch (err) {
      spinner.fail(err.message);
      process.exit(1);
    }
  });

agentCmd
  .command('pr-review')
  .description('PR review: get git diff context from Claudeye memory')
  .option('-p, --project <path>', 'Git repo path', process.cwd())
  .option('--diff <text>',        'Pre-supplied diff (overrides git call)')
  .option('-n, --limit <n>',      'Max context observations', '10')
  .option('--dry-run',            'Show context without logging', false)
  .action(async (opts) => {
    const { prReview } = await import('./src/agent.js');
    const ora = (await import('ora')).default;

    const spinner = ora('Fetching git diff and searching Claudeye memory…').start();
    try {
      const { query, changedFiles, projectResults, crossResults, decisions } = await prReview({
        project: opts.project,
        diff:    opts.diff || null,
        limit:   parseInt(opts.limit, 10),
        dryRun:  !!opts.dryRun,
      });
      spinner.stop();

      const dryTag = opts.dryRun ? chalk.gray(' [dry-run]') : '';
      console.log(chalk.bold(`\n🤖 PR Review Context${dryTag}\n`));

      if (changedFiles.length) {
        console.log(chalk.bold('  Changed files:'));
        for (const f of changedFiles) console.log(`    ${chalk.cyan(f)}`);
        console.log('');
      }

      if (decisions.length) {
        console.log(chalk.bold('  ⚡ Relevant decisions in this project:'));
        for (const obs of decisions.slice(0, 5)) {
          const tags = JSON.parse(obs.tags || '[]');
          console.log(`    ${chalk.red('🔴')} ${obs.summary.slice(0, 120)}`);
          if (tags.length) console.log(`       ${chalk.gray('#' + tags.slice(0, 3).join(' #'))}`);
          console.log(`       ${chalk.gray(obs.created_at.slice(0, 10))}`);
        }
        console.log('');
      }

      const otherResults = projectResults.filter(o => {
        const tags = JSON.parse(o.tags || '[]');
        return !tags.includes('decision') && o.importance < 0.8;
      });
      if (otherResults.length) {
        console.log(chalk.bold('  📋 Project context:'));
        for (const obs of otherResults.slice(0, 5)) {
          const score = (obs.hybridScore * 100).toFixed(1);
          console.log(`    ${chalk.yellow('●')} ${obs.summary.slice(0, 120)}`);
          console.log(`       ${chalk.gray(obs.created_at.slice(0, 10))} ${chalk.gray(`score: ${score}`)}`);
        }
        console.log('');
      }

      if (crossResults.length) {
        console.log(chalk.bold('  🌐 Cross-project experience:'));
        for (const obs of crossResults) {
          const proj = (obs.project || '').replace(process.env.HOME || '', '~');
          console.log(`    ${chalk.cyan('●')} [${proj.split('/').pop()}] ${obs.summary.slice(0, 100)}`);
        }
        console.log('');
      }

      if (!projectResults.length && !crossResults.length) {
        console.log(chalk.yellow('  No relevant context found in memory.\n'));
      }

      if (!opts.dryRun) {
        console.log(chalk.gray(`  Logged to agent_actions.\n`));
      }
    } catch (err) {
      spinner.fail(err.message);
      process.exit(1);
    }
  });

agentCmd
  .command('history')
  .description('Show recent agent action log')
  .option('--agent <name>', 'Filter by agent name')
  .option('-n, --limit <n>', 'Max rows', '20')
  .action(async (opts) => {
    const { getAgentHistory } = await import('./src/agent.js');
    const rows = getAgentHistory({ agent: opts.agent, limit: parseInt(opts.limit, 10) });

    if (!rows.length) {
      console.log(chalk.yellow('\n  No agent actions yet. Run `claudeye agent context <query>` or `claudeye agent pr-review`.\n'));
      return;
    }

    console.log(chalk.bold('\n🤖 Agent Action History\n'));
    for (const row of rows) {
      const dryTag  = row.dry_run ? chalk.gray(' [dry]') : '';
      const result  = row.result ? JSON.parse(row.result) : {};
      const summary = Object.entries(result).map(([k, v]) =>
        typeof v === 'object' ? null : `${k}=${v}`
      ).filter(Boolean).join(', ');
      console.log(`  ${chalk.cyan(row.created_at.slice(0, 16))}  ${chalk.bold(row.agent)}${dryTag}`);
      if (row.query) console.log(`    Query: ${chalk.gray(row.query.slice(0, 80))}`);
      if (row.project) console.log(`    Project: ${chalk.gray(row.project.replace(process.env.HOME || '', '~'))}`);
      if (summary) console.log(`    ${chalk.gray(summary)}`);
      console.log('');
    }
  });

// ─── agent feedback loop (#21): pending / accept / reject / effectiveness ─────

agentCmd
  .command('pending')
  .description('Show agent actions awaiting accept/reject feedback (#21)')
  .option('--agent <name>', 'Filter by agent name')
  .option('-n, --limit <n>', 'Max rows', '20')
  .action(async (opts) => {
    const { getPendingActions } = await import('./src/agent.js');
    const rows = getPendingActions({ agent: opts.agent, limit: parseInt(opts.limit, 10) });

    if (!rows.length) {
      console.log(chalk.green('\n  ✅ No pending agent actions — feedback queue is empty.\n'));
      return;
    }

    console.log(chalk.bold(`\n📋 Pending Agent Actions (${rows.length}) — review & give feedback\n`));
    for (const row of rows) {
      const action  = row.project || row.agent;
      const result  = row.result ? JSON.parse(row.result) : {};
      const summary = Object.entries(result).map(([k, v]) =>
        typeof v === 'object' ? null : `${k}=${v}`
      ).filter(Boolean).join(', ');
      console.log(`  ${chalk.yellow('#' + row.id)}  ${chalk.cyan(row.created_at.slice(0, 16))}  ${chalk.bold(action)}`);
      if (row.query) console.log(`       ${chalk.gray(row.query.slice(0, 90))}`);
      if (summary)   console.log(`       ${chalk.gray(summary)}`);
    }
    console.log(chalk.gray('\n  Accept: claudeye agent accept <id>   Reject: claudeye agent reject <id> [reason]\n'));
  });

agentCmd
  .command('accept <id> [note...]')
  .description('Mark an agent action as accepted/useful (#21 feedback loop)')
  .action(async (id, note) => {
    const { setActionFeedback } = await import('./src/agent.js');
    const res = setActionFeedback(parseInt(id, 10), 'accepted', note?.length ? note.join(' ') : null);
    if (res.ok) console.log(chalk.green(`\n  ✅ Action #${res.id} marked accepted.\n`));
    else { console.log(chalk.red(`\n  ✗ ${res.error}\n`)); process.exit(1); }
  });

agentCmd
  .command('reject <id> [note...]')
  .description('Mark an agent action as rejected/noise (#21 feedback loop)')
  .action(async (id, note) => {
    const { setActionFeedback } = await import('./src/agent.js');
    const res = setActionFeedback(parseInt(id, 10), 'rejected', note?.length ? note.join(' ') : null);
    if (res.ok) console.log(chalk.yellow(`\n  ⊘ Action #${res.id} marked rejected.\n`));
    else { console.log(chalk.red(`\n  ✗ ${res.error}\n`)); process.exit(1); }
  });

agentCmd
  .command('effectiveness')
  .description('Agent effectiveness: accepted vs rejected, rejection rate (#21)')
  .option('--since <days>', 'Window in days (default: all-time)')
  .action(async (opts) => {
    const { getAgentEffectiveness } = await import('./src/agent.js');
    const since = opts.since ? parseInt(opts.since, 10) : null;
    const s = getAgentEffectiveness({ sinceDays: since });

    const windowLabel = since ? `last ${since}d` : 'all-time';
    console.log(chalk.bold(`\n📊 Agent Effectiveness (${windowLabel})\n`));
    console.log(`  Total actions:  ${chalk.bold(s.total)}`);
    console.log(`  Reviewed:       ${chalk.bold(s.reviewed)}  (${chalk.green(s.accepted + ' accepted')}, ${chalk.yellow(s.rejected + ' rejected')})`);
    console.log(`  Pending:        ${chalk.gray(s.pending)}`);
    if (s.rejectionRate != null) {
      const pct = (s.rejectionRate * 100).toFixed(0);
      const tag = s.rejectionRate > 0.5 ? chalk.red(`${pct}% ⚠ reduce aggressiveness`) : chalk.green(`${pct}%`);
      console.log(`  Rejection rate: ${tag}`);
    } else {
      console.log(`  Rejection rate: ${chalk.gray('n/a (no feedback yet)')}`);
    }
    if (s.byAgent.length) {
      console.log(chalk.bold('\n  By agent:'));
      for (const a of s.byAgent) {
        const rr = a.rejectionRate != null ? `${(a.rejectionRate * 100).toFixed(0)}% rej` : 'no fb';
        console.log(`    ${chalk.cyan(a.agent.padEnd(20))} ${a.total} total, ${chalk.green(a.accepted + '✓')} ${chalk.yellow(a.rejected + '✗')} ${chalk.gray(a.pending + ' pending')} — ${rr}`);
      }
    }
    console.log('');
  });

agentCmd
  .command('digest')
  .description('Weekly agent digest: what the agent did, what was useful, what was not (#21)')
  .option('--days <n>', 'Window in days', '7')
  .action(async (opts) => {
    const { getAgentDigest } = await import('./src/agent.js');
    const days = parseInt(opts.days, 10) || 7;
    const d = getAgentDigest({ days });

    console.log(chalk.bold(`\n🤖 Agent Digest — last ${d.days}d\n`));
    if (d.total === 0) {
      console.log(chalk.gray('  No agent actions in this window.\n'));
      return;
    }

    console.log(`  Actions:        ${chalk.bold(d.total)}  (${chalk.green(d.accepted + ' accepted')}, ${chalk.yellow(d.rejected + ' rejected')}, ${chalk.gray(d.pending + ' pending')})`);
    if (d.rejectionRate != null) {
      const pct = (d.rejectionRate * 100).toFixed(0);
      const tag = d.rejectionRate > 0.5 ? chalk.red(`${pct}% ⚠`) : chalk.green(`${pct}%`);
      console.log(`  Rejection rate: ${tag}`);
    } else {
      console.log(`  Rejection rate: ${chalk.gray('n/a (no feedback yet)')}`);
    }

    if (d.byAgent.length) {
      console.log(chalk.bold('\n  By agent:'));
      for (const a of d.byAgent) {
        console.log(`    ${chalk.cyan(a.agent.padEnd(20))} ${a.total} total, ${chalk.green(a.accepted + '✓')} ${chalk.yellow(a.rejected + '✗')} ${chalk.gray(a.pending + ' pending')}`);
      }
    }

    if (d.byDay.length) {
      console.log(chalk.bold('\n  Daily volume:'));
      for (const day of d.byDay) {
        console.log(`    ${chalk.gray(day.day)}  ${chalk.cyan('▇'.repeat(Math.min(day.count, 40)))} ${day.count}`);
      }
    }

    if (d.rejectedNotes.length) {
      console.log(chalk.bold("\n  Recently rejected (what wasn't useful):"));
      for (const r of d.rejectedNotes) {
        const note = r.feedback_note ? `— ${r.feedback_note}` : '';
        console.log(`    ${chalk.yellow('#' + r.id)} ${chalk.cyan(r.agent)} ${chalk.gray(note)}`);
      }
    }

    if (d.timeSavings && d.timeSavings.reviewed > 0) {
      const t = d.timeSavings;
      const netTag = t.netMinutesSaved >= 0
        ? chalk.green(`+${t.netMinutesSaved} min net`)
        : chalk.red(`${t.netMinutesSaved} min net`);
      console.log(chalk.bold('\n  Time saved vs review:'));
      console.log(`    ${chalk.green(t.estMinutesSaved + ' min saved')} − ${chalk.yellow(t.estReviewMinutes + ' min reviewing')} = ${netTag}`);
    }

    if (d.recommendations.length) {
      console.log(chalk.bold('\n  Recommendations:'));
      for (const rec of d.recommendations) console.log(`    ${chalk.magenta('→')} ${rec}`);
    }
    console.log('');
  });

agentCmd
  .command('savings')
  .description('Time saved by the agent vs time spent reviewing its output (#21)')
  .option('--since <days>', 'Window in days (default: all-time)')
  .action(async (opts) => {
    const { getAgentTimeSavings } = await import('./src/agent.js');
    const since = opts.since ? parseInt(opts.since, 10) : null;
    const s = getAgentTimeSavings({ sinceDays: since });

    const windowLabel = since ? `last ${since}d` : 'all-time';
    console.log(chalk.bold(`\n⏱  Agent Time Savings (${windowLabel})\n`));
    if (s.reviewed === 0) {
      console.log(chalk.gray('  No reviewed actions yet — accept/reject some first (claudeye agent pending).\n'));
      return;
    }
    const netTag = s.netMinutesSaved >= 0
      ? chalk.green(`+${s.netMinutesSaved} min`)
      : chalk.red(`${s.netMinutesSaved} min`);
    console.log(`  Accepted actions: ${chalk.bold(s.accepted)}  (saved ~${chalk.green(s.estMinutesSaved + ' min')})`);
    console.log(`  Reviewed actions: ${chalk.bold(s.reviewed)}  (cost ~${chalk.yellow(s.estReviewMinutes + ' min')} @ ${s.reviewMinutesPerAction} min/action)`);
    console.log(`  Net time saved:   ${netTag}`);
    if (s.byAgent.length) {
      console.log(chalk.bold('\n  By agent:'));
      for (const a of s.byAgent) {
        const net = a.netMinutesSaved >= 0 ? chalk.green(`+${a.netMinutesSaved}m`) : chalk.red(`${a.netMinutesSaved}m`);
        console.log(`    ${chalk.cyan(a.agent.padEnd(20))} ${a.accepted}✓ × ${a.minutesSavedPerAction}m − ${a.reviewed} reviewed = ${net}`);
      }
    }
    console.log('');
  });

agentCmd
  .command('learn')
  .description('Advisor analyzes agent actions and recommends improvements (#21)')
  .option('--days <n>', 'Lookback window in days', '30')
  .option('--json', 'Output structured JSON instead of markdown')
  .action(async (opts) => {
    const { analyzeAgentActions } = await import('./src/advisor.js');
    const days = parseInt(opts.days, 10) || 30;
    if (opts.json) {
      const out = await analyzeAgentActions({ days, stream: false, format: 'json' });
      console.log(JSON.stringify(out, null, 2));
      return;
    }
    console.log(chalk.bold(`\n🧠 Agent Learning — analyzing last ${days}d of actions…\n`));
    const md = await analyzeAgentActions({ days, stream: true, format: 'markdown' });
    if (md) console.log(md);
    console.log('');
  });

// ─── agent daemon: start / stop / status / config (#18) ──────────────────────

agentCmd
  .command('start')
  .description('Install and start the local agent daemon (launchd, runs every hour)')
  .option('--interval <seconds>', 'Run interval in seconds', '3600')
  .action(async (opts) => {
    const { install } = await import('./scripts/agent-daemon-scheduler.js');
    const ora = (await import('ora')).default;
    const spinner = ora('Installing agent daemon…').start();
    try {
      const result = install({ intervalSeconds: parseInt(opts.interval, 10) });
      spinner.succeed('Agent daemon installed and loaded');
      console.log(chalk.gray(`  Plist:      ${result.plist}`));
      console.log(chalk.gray(`  Standalone: ${result.standalone}`));
      console.log(chalk.gray(`  Interval:   ${result.intervalSeconds}s (every ${Math.round(result.intervalSeconds / 60)} min)`));
      console.log(chalk.green('\n  ✅ Daemon will run automatically in the background.\n'));
      console.log(chalk.gray('  Check status: claudeye agent status'));
      console.log(chalk.gray('  View logs:    cat ~/.claudeye/logs/daemon-heartbeat.log\n'));
    } catch (err) {
      spinner.fail(`Failed to install daemon: ${err.message}`);
      process.exit(1);
    }
  });

agentCmd
  .command('stop')
  .description('Stop and uninstall the local agent daemon')
  .action(async () => {
    const { uninstall } = await import('./scripts/agent-daemon-scheduler.js');
    const ora = (await import('ora')).default;
    const spinner = ora('Stopping agent daemon…').start();
    try {
      const result = uninstall();
      if (result.removed) {
        spinner.succeed('Agent daemon stopped and uninstalled');
        console.log(chalk.gray(`  Removed: ${result.plist}\n`));
      } else {
        spinner.info('Agent daemon was not installed');
        console.log(chalk.gray(`  ${result.reason}\n`));
      }
    } catch (err) {
      spinner.fail(`Failed to stop daemon: ${err.message}`);
      process.exit(1);
    }
  });

agentCmd
  .command('status')
  .description('Show local agent daemon status and recent actions')
  .action(async () => {
    const { status: daemonStatus } = await import('./scripts/agent-daemon-scheduler.js');
    const { getDaemonStatus, getDaemonConfig } = await import('./src/agent-daemon.js');

    const launchd = daemonStatus();
    const runtime = getDaemonStatus();
    const config  = getDaemonConfig();

    console.log(chalk.bold('\n🤖 Local Agent Daemon Status\n'));

    // Launchd state
    const installedIcon = launchd.installed ? chalk.green('✅') : chalk.red('✗');
    const loadedIcon    = launchd.loaded    ? chalk.green('running') : chalk.yellow('not loaded');
    console.log(`  Installed:   ${installedIcon} ${launchd.installed ? chalk.gray(launchd.plist) : 'no'}`);
    console.log(`  Launchd:     ${loadedIcon}`);
    console.log('');

    // Config
    const modeColor = config.mode === 'auto' ? chalk.green : config.mode === 'confirm' ? chalk.yellow : chalk.red;
    console.log(`  Mode:        ${modeColor(config.mode)}`);
    console.log(`  Interval:    ${config.intervalHours}h`);
    console.log(`  Actions:     ${config.actions.join(', ')}`);
    console.log('');

    // Lock state
    const { lock } = runtime;
    if (lock.locked && !lock.stale) {
      console.log(`  ${chalk.yellow('⚠')} Lock held by PID ${lock.pid} since ${lock.ts}`);
    }

    // Last run
    if (runtime.lastRunAt) {
      console.log(`  Last run:    ${chalk.cyan(runtime.lastRunAt)}`);
    } else {
      console.log(`  Last run:    ${chalk.gray('never')}`);
    }
    console.log('');

    // Recent actions
    if (runtime.recentActions.length) {
      console.log(chalk.bold('  Recent daemon actions:\n'));
      for (const row of runtime.recentActions) {
        const dryTag  = row.dry_run ? chalk.gray(' [confirm]') : '';
        const action  = row.project || row.agent;
        let summary   = '';
        try {
          const r = JSON.parse(row.result || '{}');
          if (action === 'session-analysis') {
            summary = `${r.new_sessions} sessions, ${r.new_observations} obs`;
          } else if (action === 'db-growth-alert') {
            const growth = r.growth_mb_per_hour != null ? ` (+${r.growth_mb_per_hour.toFixed(2)} MB/h)` : '';
            const flag   = r.anomaly ? chalk.red(' ⚠ anomaly') : '';
            summary = `${r.size_mb} MB${growth}${flag}`;
          }
        } catch {}
        console.log(`    ${chalk.cyan(row.created_at.slice(0, 16))}  ${chalk.bold(action)}${dryTag}  ${chalk.gray(summary)}`);
      }
      console.log('');
    } else {
      console.log(chalk.gray('  No daemon actions yet. Start with: claudeye agent start\n'));
    }

    if (!launchd.installed) {
      console.log(chalk.gray('  Run `claudeye agent start` to install the daemon.\n'));
    }
  });

agentCmd
  .command('config')
  .description('Show or set daemon configuration')
  .option('--mode <mode>',          'Set mode: auto | confirm | off')
  .option('--interval <h>',         'Set run interval in hours (e.g. 1, 2, 6)')
  .option('--actions <list>',       'Comma-separated action list (e.g. session-analysis,db-growth-alert)')
  .option('--max-actions <n>',      'Max real actions per hour in auto mode (default 20)')
  .action(async (opts) => {
    const { getDaemonConfig, setDaemonConfig, listAvailableActions } = await import('./src/agent-daemon.js');

    const hasUpdate = opts.mode || opts.interval || opts.actions || opts.maxActions;

    if (hasUpdate) {
      const updates = {};
      if (opts.mode) {
        if (!['auto', 'confirm', 'off'].includes(opts.mode)) {
          console.error(chalk.red(`  Invalid mode: ${opts.mode}. Use: auto | confirm | off`));
          process.exit(1);
        }
        updates.mode = opts.mode;
      }
      if (opts.interval)   updates.intervalHours     = parseFloat(opts.interval);
      if (opts.actions)    updates.actions            = opts.actions.split(',').map(a => a.trim());
      if (opts.maxActions) updates.maxActionsPerHour  = parseInt(opts.maxActions, 10);

      const next = setDaemonConfig(updates);
      console.log(chalk.green('\n  ✅ Config updated:\n'));
      console.log(`  mode:              ${chalk.bold(next.mode)}`);
      console.log(`  interval:          ${next.intervalHours}h`);
      console.log(`  actions:           ${next.actions.join(', ')}`);
      console.log(`  maxActionsPerHour: ${next.maxActionsPerHour}\n`);
    } else {
      const config = getDaemonConfig();
      const available = listAvailableActions();
      console.log(chalk.bold('\n⚙️  Agent Daemon Config\n'));
      console.log(`  mode:              ${chalk.bold(config.mode)}`);
      console.log(`  intervalHours:     ${config.intervalHours}`);
      console.log(`  actions:           ${config.actions.join(', ')}`);
      console.log(`  maxActionsPerHour: ${config.maxActionsPerHour}`);
      console.log(`  available:         ${available.join(', ')}`);
      console.log('');
      console.log(chalk.gray('  Edit: claudeye agent config --mode auto --interval 1 --max-actions 20\n'));
    }
  });

// ─── agent route (#22) ────────────────────────────────────────────────────────

agentCmd
  .command('route <description>')
  .description('Route a task to the right agent command (Routing + Control)')
  .option('--project <path>', 'Current project (for context scoping)', process.cwd())
  .action(async (description, opts) => {
    const { routeTask, scopeToQueryOpts } = await import('./src/agent-router.js');

    const decision = routeTask(description);
    const ctxOpts  = scopeToQueryOpts(decision.contextScope, opts.project);

    const confColor = decision.confidence >= 0.8 ? chalk.green
                    : decision.confidence >= 0.6 ? chalk.yellow
                    : chalk.red;

    console.log(chalk.bold('\n🧭  Task Router\n'));
    console.log(`  Query:        ${chalk.cyan(description)}`);
    console.log(`  Agent:        ${chalk.bold(decision.agent)}`);
    console.log(`  Command:      ${chalk.magenta(decision.cliHint)}`);
    console.log(`  Confidence:   ${confColor(decision.confidence.toFixed(2))}`);
    console.log(`  Reason:       ${chalk.gray(decision.reason)}`);
    console.log(`  Context:      ${chalk.gray(ctxOpts.note)} (limit ${ctxOpts.limit})`);
    console.log(`  Description:  ${decision.description}`);
    if (decision.action) {
      console.log(`  Action:       ${chalk.gray(decision.action)}`);
    }
    console.log('');

    if (decision.confidence < 0.5) {
      console.log(chalk.yellow('  ⚠️  Low confidence — falling back to search. Try a more specific description.\n'));
    }
  });

program.parse();
