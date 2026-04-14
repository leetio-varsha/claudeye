#!/usr/bin/env node
/**
 * Friction analysis script for #78
 * Run: node scripts/friction-analysis.js
 */
import { getDb } from '../src/db.js';
const db = getDb();

console.log('=== TOP 15 HIGH-FRICTION SESSIONS ===\n');
const topFriction = db.prepare(`
  SELECT s.id, s.project, s.friction_score, s.started_at, s.prompt_count,
    s.duration_ms, s.summary,
    (SELECT COUNT(*) FROM observations o WHERE o.session_id = s.id) as obs_count,
    (SELECT COUNT(*) FROM observations o WHERE o.session_id = s.id AND o.tags LIKE '%error%') as error_obs
  FROM sessions s
  WHERE s.friction_score > 0
  ORDER BY s.friction_score DESC
  LIMIT 15
`).all();

topFriction.forEach((s, i) => {
  const proj = s.project?.split('/').pop() || '?';
  const dur = s.duration_ms ? (s.duration_ms / 60000).toFixed(0) + 'min' : '?';
  console.log(`${i+1}. friction=${s.friction_score?.toFixed(3)} | ${proj} | ${dur} | obs=${s.obs_count} err=${s.error_obs} | prompts=${s.prompt_count||'?'}`);
  console.log(`   ${(s.summary || '').substring(0, 150)}`);
  console.log(`   ${s.started_at}\n`);
});

console.log('\n=== FRICTION BY PROJECT (avg, sessions) ===\n');
const byProject = db.prepare(`
  SELECT
    REPLACE(REPLACE(project, '/Users/lord/Sites/', ''), '/Users/lord/Documents/Claude/Projects/', '') as proj,
    AVG(friction_score) as avg_f,
    COUNT(*) as sessions,
    SUM(CASE WHEN friction_score > 0.2 THEN 1 ELSE 0 END) as high_friction_sessions
  FROM sessions
  WHERE friction_score > 0
  GROUP BY project
  ORDER BY avg_f DESC
  LIMIT 15
`).all();

byProject.forEach(p => {
  console.log(`  ${p.proj}: avg=${p.avg_f?.toFixed(3)} | sessions=${p.sessions} | high_friction=${p.high_friction_sessions}`);
});

console.log('\n\n=== FRICTION BY WEEK ===\n');
const byWeek = db.prepare(`
  SELECT
    strftime('%Y-W%W', started_at) as week,
    AVG(friction_score) as avg_f,
    COUNT(*) as sessions,
    MIN(friction_score) as min_f,
    MAX(friction_score) as max_f
  FROM sessions
  WHERE friction_score > 0
  GROUP BY week
  ORDER BY week
`).all();

byWeek.forEach(w => {
  const bar = '█'.repeat(Math.round(w.avg_f * 50));
  console.log(`  ${w.week}: avg=${w.avg_f?.toFixed(3)} (${w.sessions} sessions) min=${w.min_f?.toFixed(3)} max=${w.max_f?.toFixed(3)} ${bar}`);
});

console.log('\n\n=== ERROR OBSERVATIONS RATE BY WEEK ===\n');
const errorsByWeek = db.prepare(`
  SELECT
    strftime('%Y-W%W', o.created_at) as week,
    COUNT(*) as total_obs,
    SUM(CASE WHEN o.tags LIKE '%error%' OR o.summary LIKE '%error%' OR o.summary LIKE '%Error%' OR o.summary LIKE '%fail%' THEN 1 ELSE 0 END) as error_obs
  FROM observations o
  WHERE o.tool != 'git-commit'
  GROUP BY week
  ORDER BY week
`).all();

errorsByWeek.forEach(w => {
  const rate = w.total_obs > 0 ? (w.error_obs / w.total_obs * 100).toFixed(1) : 0;
  console.log(`  ${w.week}: ${w.error_obs}/${w.total_obs} errors (${rate}%)`);
});

console.log('\n\n=== FRICTION vs SESSION CHARACTERISTICS ===\n');

// Correlation: session length vs friction
const lenCorr = db.prepare(`
  SELECT
    CASE
      WHEN prompt_count <= 5 THEN '1-5 prompts'
      WHEN prompt_count <= 15 THEN '6-15 prompts'
      WHEN prompt_count <= 30 THEN '16-30 prompts'
      ELSE '30+ prompts'
    END as bucket,
    AVG(friction_score) as avg_f,
    COUNT(*) as sessions
  FROM sessions
  WHERE friction_score > 0 AND prompt_count > 0
  GROUP BY bucket
  ORDER BY MIN(prompt_count)
`).all();

console.log('Friction by session length:');
lenCorr.forEach(r => console.log(`  ${r.bucket}: avg_friction=${r.avg_f?.toFixed(3)} (${r.sessions} sessions)`));

// Correlation: time of day vs friction
console.log('\nFriction by time of day:');
const todCorr = db.prepare(`
  SELECT
    CASE
      WHEN CAST(strftime('%H', started_at) AS INT) < 10 THEN 'morning (before 10)'
      WHEN CAST(strftime('%H', started_at) AS INT) < 14 THEN 'midday (10-14)'
      WHEN CAST(strftime('%H', started_at) AS INT) < 18 THEN 'afternoon (14-18)'
      ELSE 'evening (18+)'
    END as tod,
    AVG(friction_score) as avg_f,
    COUNT(*) as sessions
  FROM sessions
  WHERE friction_score > 0
  GROUP BY tod
  ORDER BY MIN(CAST(strftime('%H', started_at) AS INT))
`).all();

todCorr.forEach(r => console.log(`  ${r.tod}: avg_friction=${r.avg_f?.toFixed(3)} (${r.sessions} sessions)`));

// Top error-producing tools in high-friction sessions
console.log('\n\nTool error rates in high-friction sessions (friction > 0.2):');
const toolErrors = db.prepare(`
  SELECT o.tool, COUNT(*) as total,
    SUM(CASE WHEN o.tags LIKE '%error%' OR o.summary LIKE '%error%' OR o.summary LIKE '%Error%' OR o.summary LIKE '%fail%' THEN 1 ELSE 0 END) as errors
  FROM observations o
  JOIN sessions s ON s.id = o.session_id
  WHERE s.friction_score > 0.2 AND o.tool != 'git-commit'
  GROUP BY o.tool
  HAVING total >= 5
  ORDER BY CAST(errors AS FLOAT) / total DESC
  LIMIT 10
`).all();

toolErrors.forEach(t => {
  const rate = (t.errors / t.total * 100).toFixed(1);
  console.log(`  ${t.tool}: ${t.errors}/${t.total} (${rate}%)`);
});
