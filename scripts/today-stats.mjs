#!/usr/bin/env node
import { getDb } from '../src/db.js';
const db = getDb();
// Start of the current day (UTC), matching the created_at format in mem.db.
const since = new Date().toISOString().slice(0, 10);

const today = db.prepare(`SELECT COUNT(*) as n FROM observations WHERE created_at >= '${since}'`).get();
console.log('Observations today:', today.n);

const sessions = db.prepare(`
  SELECT s.id, s.project, COUNT(o.id) as obs, MIN(o.created_at) as first_at, MAX(o.created_at) as last_at
  FROM sessions s JOIN observations o ON o.session_id = s.id
  WHERE o.created_at >= '${since}'
  GROUP BY s.id ORDER BY obs DESC
`).all();
console.log('\nSessions today:', sessions.length);
for (const s of sessions) {
  const proj = s.project.split('/').pop();
  console.log(`  [${proj}] ${s.obs} obs (${s.first_at?.slice(11,16)} - ${s.last_at?.slice(11,16)})`);
}

const tools = db.prepare(`
  SELECT tool, COUNT(*) as n FROM observations
  WHERE created_at >= '${since}' AND tool != 'git-commit'
  GROUP BY tool ORDER BY n DESC LIMIT 15
`).all();
console.log('\nTools today (non-git):');
for (const t of tools) console.log(`  ${t.tool}: ${t.n}`);

const git = db.prepare(`SELECT COUNT(*) as n FROM observations WHERE created_at >= '${since}' AND tool = 'git-commit'`).get();
console.log('\nGit commits today:', git.n);

// Estimate hook overhead: how much context does inject-hook add?
const { buildContext } = await import('../src/search.js');
const project = process.argv[2] || process.cwd();
const ctx = await buildContext('test query', project);
const ctxTokens = ctx ? Math.round(ctx.length / 4) : 0;
console.log('\nInject-hook context size:', ctx?.length || 0, 'chars (~' + ctxTokens + ' tokens per message)');
