#!/usr/bin/env node
/**
 * cli.js — cmem CLI
 *
 * Usage:
 *   cmem stats              — show database stats
 *   cmem search <query>     — search observations
 *   cmem recent [n]         — show recent observations
 *   cmem sessions           — list recent sessions
 *   cmem viewer             — open web viewer
 *   cmem setup              — first-time setup
 *   cmem clear [--project]  — clear data
 */

import { program } from 'commander';
import chalk from 'chalk';

program
  .name('cmem')
  .description('Personal Claude Code memory')
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

// ─── setup ────────────────────────────────────────────────────────────────

program.command('setup')
  .description('Interactive first-time setup')
  .action(async () => {
    const { default: setup } = await import('./scripts/setup.js');
    await setup();
  });

// ─── install-hooks ────────────────────────────────────────────────────────

program.command('install-hooks')
  .description('Install Claude Code hooks')
  .action(async () => {
    const { default: installHooks } = await import('./scripts/install-hooks.js');
    await installHooks();
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

program.parse();
