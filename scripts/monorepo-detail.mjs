#!/usr/bin/env node
import { getDb } from '../src/db.js';
const db = getDb();

// Monorepo session details
const sessions = db.prepare(`
  SELECT s.id, s.project, COUNT(o.id) as obs, MIN(o.created_at) as first_at, MAX(o.created_at) as last_at
  FROM sessions s JOIN observations o ON o.session_id = s.id
  WHERE o.created_at >= '2026-03-30' AND s.project LIKE '%monorepo%'
  GROUP BY s.id ORDER BY obs DESC
`).all();

console.log('=== MONOREPO SESSIONS TODAY ===');
for (const s of sessions) {
  console.log(`  ${s.id.slice(0,12)}... ${s.obs} obs (${s.first_at?.slice(11,16)} - ${s.last_at?.slice(11,16)})`);
}

// Tools breakdown
const tools = db.prepare(`
  SELECT o.tool, COUNT(*) as n
  FROM observations o JOIN sessions s ON o.session_id = s.id
  WHERE o.created_at >= '2026-03-30' AND s.project LIKE '%monorepo%'
  GROUP BY o.tool ORDER BY n DESC
`).all();
console.log('\n=== TOOLS ===');
for (const t of tools) console.log(`  ${t.tool}: ${t.n}`);

// Heavy Read operations (files read)
const reads = db.prepare(`
  SELECT o.raw_input, o.importance
  FROM observations o JOIN sessions s ON o.session_id = s.id
  WHERE o.created_at >= '2026-03-30' AND s.project LIKE '%monorepo%' AND o.tool = 'Read'
  ORDER BY o.created_at ASC
`).all();
const fileReads = {};
for (const r of reads) {
  try {
    const inp = JSON.parse(r.raw_input || '{}');
    const fp = inp.file_path || r.raw_input || '?';
    const short = fp.split('/').slice(-3).join('/');
    fileReads[short] = (fileReads[short] || 0) + 1;
  } catch {
    fileReads['?'] = (fileReads['?'] || 0) + 1;
  }
}
const sortedFiles = Object.entries(fileReads).sort((a,b) => b[1] - a[1]).slice(0, 15);
console.log('\n=== MOST READ FILES ===');
for (const [f, n] of sortedFiles) console.log(`  ${n}x ${f}`);

// Heavy Bash commands
const bashes = db.prepare(`
  SELECT o.raw_input
  FROM observations o JOIN sessions s ON o.session_id = s.id
  WHERE o.created_at >= '2026-03-30' AND s.project LIKE '%monorepo%' AND o.tool = 'Bash'
  ORDER BY o.created_at ASC
`).all();
const cmdTypes = {};
for (const b of bashes) {
  try {
    const inp = JSON.parse(b.raw_input || '{}');
    const cmd = (inp.command || b.raw_input || '?').split(' ')[0].split('/').pop();
    cmdTypes[cmd] = (cmdTypes[cmd] || 0) + 1;
  } catch {
    cmdTypes['?'] = (cmdTypes['?'] || 0) + 1;
  }
}
const sortedCmds = Object.entries(cmdTypes).sort((a,b) => b[1] - a[1]).slice(0, 10);
console.log('\n=== BASH COMMAND TYPES ===');
for (const [c, n] of sortedCmds) console.log(`  ${n}x ${c}`);

// High importance observations (what was the actual work?)
const important = db.prepare(`
  SELECT o.summary, o.tool, o.importance, o.created_at
  FROM observations o JOIN sessions s ON o.session_id = s.id
  WHERE o.created_at >= '2026-03-30' AND s.project LIKE '%monorepo%' AND o.importance >= 0.6
  ORDER BY o.importance DESC LIMIT 15
`).all();
console.log('\n=== HIGH IMPORTANCE WORK ===');
for (const o of important) {
  console.log(`  ${o.importance.toFixed(1)} [${o.tool}] ${o.summary.slice(0, 120)}`);
}

// Timeline: obs per 30 min
const timeline = db.prepare(`
  SELECT
    substr(o.created_at, 12, 2) || ':' ||
    CASE WHEN CAST(substr(o.created_at, 15, 2) AS INTEGER) < 30 THEN '00' ELSE '30' END as slot,
    COUNT(*) as n
  FROM observations o JOIN sessions s ON o.session_id = s.id
  WHERE o.created_at >= '2026-03-30' AND s.project LIKE '%monorepo%'
  GROUP BY slot ORDER BY slot
`).all();
console.log('\n=== TIMELINE (30min slots) ===');
for (const t of timeline) {
  const bar = '#'.repeat(Math.min(40, t.n));
  console.log(`  ${t.slot} ${bar} ${t.n}`);
}
