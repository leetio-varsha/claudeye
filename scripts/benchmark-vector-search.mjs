#!/usr/bin/env node
/**
 * benchmark-vector-search.mjs — baseline benchmark для #96
 *
 * Измеряет текущую производительность vector search:
 *   - время загрузки embeddings из DB (getObservationsWithEmbeddings)
 *   - время cosine similarity loop
 *   - итоговое время runVectorSearch (без embed API)
 *
 * Запуск: node benchmark-vector-search.mjs
 */

import { createRequire } from 'module';
import { join } from 'path';
import { homedir } from 'os';

const _require = createRequire(join(homedir(), '.claudeye', 'package.json'));
const Database = _require('better-sqlite3');
const db = new Database(join(homedir(), '.claudeye', 'mem.db'), { readonly: true });

// --- helpers ---
function bufToFloat32(buf) {
  if (!buf) return new Float32Array(0);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Float32Array(ab);
}

function cosineSimilarity(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-10);
}

function getObservationsWithEmbeddings(project, limit = 300) {
  const GIT_CAP = 50;
  if (project) {
    return db.prepare(`
      SELECT * FROM (
        SELECT o.id, o.tool, o.importance, e.vector
        FROM observations o JOIN embeddings e ON e.observation_id = o.id
        WHERE o.project = ? AND o.tool != 'git-commit'
        ORDER BY o.created_at DESC LIMIT ?
      ) UNION ALL
      SELECT * FROM (
        SELECT o.id, o.tool, o.importance, e.vector
        FROM observations o JOIN embeddings e ON e.observation_id = o.id
        WHERE o.project = ? AND o.tool = 'git-commit'
        ORDER BY o.created_at DESC LIMIT ?
      )
    `).all(project, limit, project, GIT_CAP);
  }
  return db.prepare(`
    SELECT * FROM (
      SELECT o.id, o.tool, o.importance, e.vector
      FROM observations o JOIN embeddings e ON e.observation_id = o.id
      WHERE o.tool != 'git-commit'
      ORDER BY o.created_at DESC LIMIT ?
    ) UNION ALL
    SELECT * FROM (
      SELECT o.id, o.tool, o.importance, e.vector
      FROM observations o JOIN embeddings e ON e.observation_id = o.id
      WHERE o.tool = 'git-commit'
      ORDER BY o.created_at DESC LIMIT ?
    )
  `).all(limit, GIT_CAP);
}

// --- stats ---
const totalEmb = db.prepare('SELECT COUNT(*) as c FROM embeddings').get().c;
const totalObs = db.prepare('SELECT COUNT(*) as c FROM observations').get().c;
console.log(`DB: ${totalObs} observations, ${totalEmb} embeddings`);

// top projects by observation count
const topProjects = db.prepare(`
  SELECT project, COUNT(*) as cnt
  FROM observations WHERE project IS NOT NULL
  GROUP BY project ORDER BY cnt DESC LIMIT 3
`).all();

console.log('\nTop projects:');
topProjects.forEach(p => console.log(`  ${p.project} (${p.cnt} obs)`));

// --- benchmark function ---
function benchmarkVectorSearch(label, project, RUNS = 5) {
  // fake query vector: 1536 dims (same as text-embedding-3-small)
  const queryVec = new Float32Array(1536).fill(0);
  queryVec[0] = 1; // unit vector

  const times = [];
  let rowCount = 0;

  for (let i = 0; i < RUNS; i++) {
    // 1. load phase
    const t0 = performance.now();
    const rows = getObservationsWithEmbeddings(project, 300);
    const tLoad = performance.now() - t0;

    // 2. cosine loop phase
    const t1 = performance.now();
    rows.forEach(row => {
      const vec = bufToFloat32(row.vector);
      if (vec.length === queryVec.length) cosineSimilarity(queryVec, vec);
    });
    const tCosine = performance.now() - t1;

    times.push({ total: tLoad + tCosine, load: tLoad, cosine: tCosine, rows: rows.length });
    if (i === 0) rowCount = rows.length;
  }

  const avg = arr => arr.reduce((s, x) => s + x, 0) / arr.length;
  const p50 = arr => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

  console.log(`\n[${label}] rows=${rowCount}`);
  console.log(`  load    avg=${avg(times.map(t => t.load)).toFixed(1)}ms  p50=${p50(times.map(t => t.load)).toFixed(1)}ms`);
  console.log(`  cosine  avg=${avg(times.map(t => t.cosine)).toFixed(1)}ms  p50=${p50(times.map(t => t.cosine)).toFixed(1)}ms`);
  console.log(`  TOTAL   avg=${avg(times.map(t => t.total)).toFixed(1)}ms  p50=${p50(times.map(t => t.total)).toFixed(1)}ms`);

  return {
    label, rows: rowCount,
    loadAvg: avg(times.map(t => t.load)),
    cosineAvg: avg(times.map(t => t.cosine)),
    totalAvg: avg(times.map(t => t.total)),
  };
}

console.log('\n=== Vector Search Baseline Benchmark ===');
const results = [];

// 1. Global (no project filter) — worst case
results.push(benchmarkVectorSearch('global (no project filter)', null));

// 2. Top project — typical case
if (topProjects[0]) {
  results.push(benchmarkVectorSearch(`project-scoped (${topProjects[0].cnt} obs)`, topProjects[0].project));
}

// 3. Second project — for comparison
if (topProjects[1]) {
  results.push(benchmarkVectorSearch(`project-scoped-2 (${topProjects[1].cnt} obs)`, topProjects[1].project));
}

console.log('\n=== Summary ===');
console.log(JSON.stringify(results, null, 2));
