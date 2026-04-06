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
    const { getStats } = await import('./src/db.js');
    const stats = getStats();

    console.log(chalk.bold('\n📊 Claude Mem Stats\n'));
    console.log(`  Total observations: ${chalk.cyan(stats.totalObservations)}`);
    console.log(`  Total sessions:     ${chalk.cyan(stats.totalSessions)}`);

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
  .action(async (query, opts) => {
    const { hybridSearch } = await import('./src/search.js');
    const ora = (await import('ora')).default;

    const spinner = ora('Searching...').start();
    try {
      const results = await hybridSearch(query, opts.project, { limit: parseInt(opts.limit) });
      spinner.stop();

      if (!results.length) {
        console.log(chalk.yellow('\n  No results found.\n'));
        return;
      }

      console.log(chalk.bold(`\n🔍 Results for "${query}"\n`));
      for (const obs of results) {
        const score = (obs.hybridScore * 100).toFixed(1);
        const tags  = JSON.parse(obs.tags || '[]');
        console.log(`  ${chalk.cyan('●')} ${obs.summary}`);
        if (tags.length) console.log(`    ${chalk.gray(tags.map(t => `#${t}`).join(' '))}`);
        console.log(`    ${chalk.gray(obs.created_at)} ${chalk.yellow(`score: ${score}`)}\n`);
      }
    } catch (err) {
      spinner.fail(err.message);
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

// ─── health ──────────────────────────────────────────────────────────────

program.command('health')
  .description('Diagnostic check: DB, API keys, hooks, errors')
  .action(async () => {
    const { getDb, getStats, getErrorStats } = await import('./src/db.js');
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
      const sizeWarn = metrics.fileSizeMB > 100;
      checks.push({
        name: 'Database',
        ok: !sizeWarn,
        detail: `${stats.totalObservations} obs, ${stats.totalSessions} sessions, ${metrics.fileSizeMB}MB`
          + (sizeWarn ? ` ⚠️  >100MB — run ${chalk.yellow('claudeye cleanup')}` : '')
          + ` | git-commit: ${metrics.gitCommitCount}`
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

    // Error budget
    try {
      const errors = getErrorStats(7);
      const errOk = errors.total < 50;
      checks.push({ name: 'Error budget (7d)', ok: errOk, detail: `${errors.total} errors` + (errors.byHook.length ? ' — ' + errors.byHook.slice(0,3).map(e => `${e.hook}:${e.error_type}(${e.count})`).join(', ') : '') });
    } catch {
      checks.push({ name: 'Error budget', ok: true, detail: '0 errors' });
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
  .action(async (opts) => {
    const { cleanup, compact, getDbMetrics, closeOrphanedSessions } = await import('./src/db.js');
    const ora = (await import('ora')).default;

    const metrics = getDbMetrics();
    console.log(chalk.bold('\n  Claudeye Cleanup\n'));
    console.log(`  DB size: ${chalk.cyan(metrics.fileSizeMB + 'MB')} | Observations: ${chalk.cyan(metrics.obsCount)} | Embeddings: ${chalk.cyan(metrics.embCount)} | git-commit: ${chalk.cyan(metrics.gitCommitCount)}\n`);

    // Step 0: Close orphaned sessions (#60)
    const orphanSpinner = ora(opts.dryRun ? 'Checking orphaned sessions...' : 'Closing orphaned sessions...').start();
    const orphanCounts = closeOrphanedSessions({ dryRun: opts.dryRun });

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
      if (counts.gitCommit) console.log(`    ${counts.gitCommit} old git-commit (importance <0.5, >30 days, beyond top 200/project)`);
    } else {
      retSpinner.succeed('Nothing to delete — all data within retention policy.');
    }

    // Step 3: VACUUM to reclaim disk space
    if (opts.vacuum !== false && !opts.dryRun && (compactCounts.total > 0 || counts.total > 0)) {
      const vacSpinner = ora('Running VACUUM to reclaim disk space...').start();
      const { getDb } = await import('./src/db.js');
      getDb().exec('VACUUM');
      const after = getDbMetrics();
      vacSpinner.succeed(`VACUUM done. DB size: ${chalk.cyan(metrics.fileSizeMB + 'MB')} → ${chalk.green(after.fileSizeMB + 'MB')}`);
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
  .argument('<source>', 'Source type: git')
  .option('-p, --path <path>', 'Repository path', process.cwd())
  .option('--since <date>', 'Only import commits since date')
  .option('-n, --limit <n>', 'Max commits to import')
  .option('--skip-ai', 'Skip AI compression (faster, less rich)')
  .action(async (source, opts) => {
    if (source !== 'git') {
      console.log(chalk.red(`
  Unknown source: ${source}. Supported: git
`));
      return;
    }
    const { importGit } = await import('./src/import.js');
    const ora = (await import('ora')).default;
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

    // Gather session data
    const recentObs = db.prepare(`
      SELECT summary, tool, importance, tags
      FROM observations
      WHERE session_id = ? AND importance >= 0.5
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
      SELECT summary FROM observations
      WHERE session_id = ? AND tags LIKE '%error%'
      ORDER BY created_at DESC LIMIT 5
    `).all(session.id);

    const files = db.prepare(`
      SELECT DISTINCT
        CASE WHEN raw_input LIKE '%/%' THEN raw_input ELSE NULL END as file_hint
      FROM observations
      WHERE session_id = ? AND tool IN ('Edit', 'Write') AND raw_input IS NOT NULL
      ORDER BY created_at DESC LIMIT 10
    `).all(session.id).filter(f => f.file_hint);

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
      for (const e of errors) {
        lines.push(`- ${e.summary.slice(0, 150)}`);
      }
      lines.push('');
    }

    if (files.length) {
      lines.push('Файлы:');
      for (const f of files.slice(0, 5)) {
        const pathMatch = f.file_hint.match(/[\/\w.-]+\.\w+/);
        if (pathMatch) lines.push(`- ${pathMatch[0]}`);
      }
      lines.push('');
    }

    const handoff = lines.join('\n');

    // Output the handoff as a copyable block
    console.log(chalk.cyan('  ── Copy this into your new session ──────────────\n'));
    console.log(handoff);
    console.log(chalk.cyan('  ────────────────────────────────────────────────\n'));
  });

// ─── insights ────────────────────────────────────────────────────────────

program.command('insights')
  .description('Daily proactive insights: anomalies, quota alerts, friction patterns')
  .option('--days <n>', 'Lookback period in days', '1')
  .option('--no-notify', 'Skip macOS notification')
  .option('--json', 'Output as JSON')
  .action(async (opts) => {
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

// Register analytics commands (analytics, advise, rate, digest)
registerAnalyticsCommands(program);

program.parse();
