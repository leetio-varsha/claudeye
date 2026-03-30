/**
 * CLI additions for analytics — paste these commands into cli.js
 * or import and register them.
 *
 * New commands:
 *   claudeye analytics [--project] [--plugins] [--models] [--issues] [--hotspots]
 *   claudeye advise [--focus] [--days]
 *   claudeye rate [session-id]
 *   claudeye digest [--generate] [--force]
 */

import chalk from 'chalk';

/**
 * Register analytics commands on the given Commander program instance.
 */
export function registerAnalyticsCommands(program) {

program.command('analytics')
  .description('Usage analytics')
  .option('-p, --project <path>', 'Scope to a specific project')
  .option('--plugins',  'Show plugin effectiveness matrix')
  .option('--models',   'Show model comparison')
  .option('--issues',   'Show issue resolution metrics')
  .option('--hotspots', 'Show complexity hotspots')
  .action(async (opts) => {
    const {
      getGlobalStats, getProjectStats, getPluginMatrix,
      getModelComparison, getIssueMetrics, getComplexityHotspots,
    } = await import('./src/analytics.js');

    if (opts.plugins) {
      const { plugins, baseline } = getPluginMatrix();
      console.log(chalk.bold('\n🔌 Plugin Effectiveness\n'));
      console.log(chalk.gray(`  Baseline (no plugin): friction=${baseline.avg_friction?.toFixed(2)} duration=${baseline.avg_duration_min?.toFixed(1)}min rating=${baseline.avg_rating?.toFixed(1) ?? 'n/a'}\n`));

      for (const p of plugins) {
        const fd = p.friction_delta;
        const frictionSign = fd > 0.05  ? chalk.red(`+${fd.toFixed(2)} ↑ worse`) :
                             fd < -0.05 ? chalk.green(`${fd.toFixed(2)} ↓ better`) :
                             chalk.gray('~neutral');
        const dd = p.duration_delta;
        const durSign = dd > 5  ? chalk.red(`+${dd.toFixed(0)}min slower`) :
                        dd < -5 ? chalk.green(`${dd.toFixed(0)}min faster`) :
                        chalk.gray('~same speed');

        console.log(`  ${chalk.bold(p.plugin.padEnd(20))} ${p.sessions} sessions`);
        console.log(`    Friction:  ${frictionSign}`);
        console.log(`    Duration:  ${durSign}`);
        if (p.avg_rating) console.log(`    Rating:    ${chalk.cyan(p.avg_rating.toFixed(1))}/5`);
        console.log('');
      }
      return;
    }

    if (opts.models) {
      const models = getModelComparison();
      console.log(chalk.bold('\n🤖 Model Comparison\n'));
      for (const m of models) {
        console.log(`  ${chalk.bold((m.model || 'unknown').padEnd(30))} ${chalk.yellow(m.sessions)} sessions`);
        console.log(`    Friction: ${(m.avg_friction || 0).toFixed(2)}  Duration: ${(m.avg_duration_min || 0).toFixed(1)}min  Rating: ${m.avg_rating?.toFixed(1) ?? 'n/a'}`);
        console.log('');
      }
      return;
    }

    if (opts.issues) {
      const { summary, byProject, slowest } = getIssueMetrics();
      console.log(chalk.bold('\n🐛 Issue Metrics\n'));
      console.log(`  Total: ${chalk.cyan(summary.total || 0)}  Resolved: ${chalk.green(summary.resolved || 0)}  Open: ${chalk.yellow(summary.open || 0)}`);
      console.log(`  Avg resolution: ${chalk.cyan((summary.avg_resolution_hrs || 0).toFixed(1))} hrs`);

      if (slowest.length) {
        console.log(chalk.bold('\n  Slowest to resolve:'));
        for (const i of slowest) {
          console.log(`    ${chalk.red(i.hrs.toFixed(1) + 'h')}  ${i.title.slice(0, 60)}`);
        }
      }
      console.log('');
      return;
    }

    if (opts.hotspots) {
      const { hotFiles, retryByTool } = getComplexityHotspots();
      console.log(chalk.bold('\n🔥 Complexity Hotspots\n'));
      if (hotFiles.length) {
        console.log(chalk.gray('  Most frequently edited (high-importance):'));
        for (const f of hotFiles.slice(0, 10)) {
          const proj = (f.project || '').split('/').pop();
          console.log(`    ${chalk.yellow(f.occurrences + 'x')}  ${f.file_hint?.slice(0, 50)}  ${chalk.gray(proj)}`);
        }
      }
      if (retryByTool.length) {
        console.log(chalk.bold('\n  Tools with most retries:'));
        for (const t of retryByTool) {
          console.log(`    ${chalk.red(t.avg_retries.toFixed(1))} avg retries  ${t.tool}`);
        }
      }
      console.log('');
      return;
    }

    if (opts.project) {
      const stats = getProjectStats(opts.project);
      const proj  = opts.project.replace(process.env.HOME, '~');
      console.log(chalk.bold(`\n📊 ${proj}\n`));
      const o = stats.overview;
      console.log(`  Sessions:    ${chalk.cyan(o.sessions)}`);
      console.log(`  Observations: ${chalk.cyan(o.observations)}`);
      console.log(`  Avg friction: ${chalk.yellow((o.avg_friction || 0).toFixed(2))}`);
      console.log(`  Avg session:  ${chalk.cyan((o.avg_session_min || 0).toFixed(1))} min`);
      console.log(`  Active since: ${o.first_session?.slice(0, 10) ?? 'n/a'}`);

      if (stats.highImportance.length) {
        console.log(chalk.bold('\n  🔴 High-importance observations:'));
        for (const o of stats.highImportance.slice(0, 5)) {
          console.log(`    ${chalk.red(o.importance.toFixed(1))}  ${o.summary.slice(0, 80)}`);
        }
      }
      console.log('');
      return;
    }

    // Global overview
    const stats = getGlobalStats();
    const o     = stats.overview;
    console.log(chalk.bold('\n📊 Global Analytics\n'));
    console.log(`  Sessions:      ${chalk.cyan(o.total_sessions || 0)}`);
    console.log(`  Observations:  ${chalk.cyan(o.total_observations || 0)}`);
    console.log(`  Projects:      ${chalk.cyan(o.total_projects || 0)}`);
    console.log(`  Avg friction:  ${chalk.yellow((o.avg_friction || 0).toFixed(2))}`);
    console.log(`  Avg session:   ${chalk.cyan((o.avg_session_min || 0).toFixed(1))} min`);
    if (o.total_tokens) console.log(`  Total tokens:  ${chalk.gray(o.total_tokens.toLocaleString())}`);

    if (stats.byProject.length) {
      console.log(chalk.bold('\n  By project:'));
      for (const p of stats.byProject) {
        const proj = p.project.replace(process.env.HOME, '~').split('/').pop();
        const bar  = '▓'.repeat(Math.min(20, Math.round(p.sessions / 2)));
        console.log(`    ${proj.padEnd(20)} ${chalk.blue(bar)} ${chalk.yellow(p.sessions)} sessions  friction: ${(p.avg_friction || 0).toFixed(2)}`);
      }
    }

    if (stats.weeklyTrend.length) {
      console.log(chalk.bold('\n  Weekly trend:'));
      for (const w of stats.weeklyTrend.slice(-6)) {
        const bar = '█'.repeat(Math.min(20, w.sessions));
        console.log(`    ${w.week}  ${chalk.blue(bar)} ${w.sessions}`);
      }
    }
    console.log('');
  });

// ─── advise ───────────────────────────────────────────────────────────────

program.command('advise')
  .description('Get AI-powered workflow recommendations')
  .option('--focus <area>', 'Focus area: plugins|workflow|issues|models')
  .option('--days <n>', 'Lookback period in days', '30')
  .action(async (opts) => {
    const { generateAdvice } = await import('./src/advisor.js');
    const ora = (await import('ora')).default;

    console.log(chalk.bold('\n🧠 Analyzing your Claude Code usage...\n'));
    const spinner = ora('Running analysis').start();

    try {
      spinner.stop();
      await generateAdvice({
        focus:  opts.focus || null,
        days:   parseInt(opts.days),
        stream: true,
      });
      console.log('');
    } catch (err) {
      spinner.fail(err.message);
      if (err.message.includes('claude')) {
        console.log(chalk.yellow('\n  Make sure Claude Code CLI is installed and you\'re logged in.\n'));
      }
    }
  });

// ─── rate ─────────────────────────────────────────────────────────────────

program.command('rate [session-id]')
  .description('Rate a session 1-5 (improves advisor accuracy)')
  .option('-n, --note <text>', 'Optional note')
  .action(async (sessionId, opts) => {
    const { getDb }      = await import('./src/db.js');
    const { rateSession } = await import('./src/analytics.js');
    const { createInterface } = await import('readline');

    const db = getDb();

    // If no session ID, show recent sessions to pick from
    if (!sessionId) {
      const recent = db.prepare(`
        SELECT s.id, s.project, s.started_at, COUNT(o.id) as obs
        FROM sessions s
        LEFT JOIN observations o ON o.session_id = s.id
        WHERE s.id NOT IN (SELECT session_id FROM session_ratings)
        GROUP BY s.id
        ORDER BY s.started_at DESC
        LIMIT 5
      `).all();

      if (!recent.length) {
        console.log(chalk.yellow('\n  No unrated sessions found.\n'));
        return;
      }

      console.log(chalk.bold('\n  Recent unrated sessions:\n'));
      recent.forEach((s, i) => {
        const proj = s.project.replace(process.env.HOME, '~');
        console.log(`  ${chalk.cyan(i + 1)}. ${s.started_at.slice(0, 16)}  ${proj}  (${s.obs} obs)`);
      });

      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const choice = await new Promise(res => rl.question('\n  Pick session (1-5): ', res));
      rl.close();
      const idx = parseInt(choice) - 1;
      if (idx < 0 || idx >= recent.length) return;
      sessionId = recent[idx].id;
    }

    const rl2 = createInterface({ input: process.stdin, output: process.stdout });
    const ratingStr = await new Promise(res => rl2.question(`  Rating for session (1-5): `, res));
    rl2.close();

    const rating = parseInt(ratingStr);
    if (isNaN(rating) || rating < 1 || rating > 5) {
      console.log(chalk.red('\n  Invalid rating. Use 1-5.\n'));
      return;
    }

    rateSession(sessionId, rating, opts.note || null);
    console.log(chalk.green(`\n  ✓ Rated ${rating}/5\n`));
  });

// ─── digest ───────────────────────────────────────────────────────────────

program.command('digest')
  .description('Show or generate weekly digest')
  .option('--generate', 'Generate digest now')
  .option('--force',    'Force regenerate even if exists')
  .option('--list',     'List all past digests')
  .action(async (opts) => {
    const { generateWeeklyDigest, getLatestDigest, listDigests } = await import('./src/advisor.js');

    if (opts.list) {
      const digests = listDigests();
      console.log(chalk.bold('\n📋 Past Digests\n'));
      for (const d of digests) {
        console.log(`  ${chalk.cyan(d.week_start)}  ${chalk.gray(d.preview.slice(0, 80))}...`);
      }
      console.log('');
      return;
    }

    if (opts.generate) {
      await generateWeeklyDigest({ force: opts.force });
    }

    const digest = getLatestDigest();
    if (!digest) {
      console.log(chalk.yellow('\n  No digest yet. Run: claudeye digest --generate\n'));
      return;
    }

    console.log(chalk.bold(`\n📊 Weekly Digest — ${digest.week_start}\n`));
    console.log(digest.report);
    console.log('');
  });

} // end registerAnalyticsCommands
