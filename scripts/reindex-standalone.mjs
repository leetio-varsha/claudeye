#!/usr/bin/env node
/**
 * reindex-standalone.mjs — Daily embedding backfill (#105)
 *
 * Standalone script deployed to ~/.claudeye/ — no ~/Documents access needed.
 * Called from insights-runner.sh after import-cowork-standalone to backfill
 * embeddings for observations added without them.
 *
 * Why standalone: import-cowork-standalone.mjs skips embedding generation
 * to avoid blocking the import loop. This script fills the gap daily.
 *
 * Behaviour:
 *   - Reads API key from ~/.claudeye/settings.json
 *   - If no real API key (openai/voyage): exits 0 silently (fallback embeddings
 *     are 128-dim keyword hashes — not worth backfilling with them)
 *   - Processes up to MAX_PER_RUN observations per run (avoid overloading scheduler)
 *   - Filters: importance >= 0.5, excluding git-commits beyond top-50/project
 *   - OpenAI text-embedding-3-small (1536 dims), batched with delay
 *
 * Deploy: cp scripts/reindex-standalone.mjs ~/.claudeye/reindex-standalone.mjs
 */

import { createRequire } from 'module';
import { join } from 'path';
import { homedir } from 'os';
import { existsSync, readFileSync, appendFileSync, mkdirSync } from 'fs';

const DATA_DIR   = join(homedir(), '.claudeye');
const DB_PATH    = join(DATA_DIR, 'mem.db');
const SETTINGS   = join(DATA_DIR, 'settings.json');
const LOG_DIR    = join(DATA_DIR, 'logs');
const HEARTBEAT  = join(LOG_DIR, 'insights-heartbeat.log');
const STDERR_LOG = join(LOG_DIR, 'insights-stderr.log');

if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });

function log(msg) {
  const line = `${new Date().toISOString()} [reindex-standalone] ${msg}\n`;
  try { appendFileSync(HEARTBEAT, line); } catch { /* non-critical */ }
}
function logErr(msg) {
  const line = `${new Date().toISOString()} [reindex-standalone] ERROR ${msg}\n`;
  try { appendFileSync(STDERR_LOG, line); } catch { /* non-critical */ }
  try { appendFileSync(HEARTBEAT, line); } catch { /* non-critical */ }
}

// ─── Settings ──────────────────────────────────────────────────────────────

function getSettings() {
  if (!existsSync(SETTINGS)) return {};
  try { return JSON.parse(readFileSync(SETTINGS, 'utf8')); } catch { return {}; }
}

const settings = getSettings();
const openaiKey = settings.openai_api_key || settings.openaiApiKey || process.env.OPENAI_API_KEY;

if (!openaiKey) {
  log('no openai_api_key — skipping (fallback embeddings not worth backfilling)');
  process.exit(0);
}

// ─── DB ────────────────────────────────────────────────────────────────────

if (!existsSync(DB_PATH)) {
  log('mem.db not found — skipping');
  process.exit(0);
}

const _require = createRequire(join(DATA_DIR, 'package.json'));
let Database;
try {
  Database = _require('better-sqlite3');
} catch (e) {
  logErr(`cannot load better-sqlite3: ${e.message}`);
  process.exit(1);
}

const db = new Database(DB_PATH, { readonly: false });

// ─── Select candidates ─────────────────────────────────────────────────────

const MAX_PER_RUN  = 100;   // max obs to embed per scheduler run
const TARGET_DIMS  = 1536;  // text-embedding-3-small
const BATCH_SIZE   = 25;    // obs per API request batch
const DELAY_MS     = 400;   // ms between batches

const candidates = db.prepare(`
  SELECT o.id, o.summary FROM observations o
  LEFT JOIN embeddings e ON e.observation_id = o.id
  WHERE (e.observation_id IS NULL OR length(e.vector) != ?)
    AND (
      (o.tool != 'git-commit' AND o.importance >= 0.5)
      OR
      (o.tool = 'git-commit' AND o.id IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (PARTITION BY project ORDER BY created_at DESC) AS rn
          FROM observations WHERE tool = 'git-commit'
        ) WHERE rn <= 50
      ))
    )
  ORDER BY o.importance DESC, o.created_at DESC
  LIMIT ?
`).all(TARGET_DIMS * 4, MAX_PER_RUN);

if (candidates.length === 0) {
  log('nothing to reindex — exit 0');
  process.exit(0);
}

log(`found ${candidates.length} obs to embed (max=${MAX_PER_RUN})`);

// ─── OpenAI embed helper ───────────────────────────────────────────────────

async function embedBatch(texts) {
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${openaiKey}`,
    },
    body: JSON.stringify({
      model: 'text-embedding-3-small',
      input: texts,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`OpenAI ${res.status}: ${body.slice(0, 200)}`);
  }

  const json = await res.json();
  return json.data.map(d => d.embedding); // array of float[] in input order
}

// ─── Save embedding ────────────────────────────────────────────────────────

const upsertEmbed = db.prepare(`
  INSERT INTO embeddings (observation_id, vector, model, created_at)
  VALUES (?, ?, ?, datetime('now'))
  ON CONFLICT(observation_id) DO UPDATE SET
    vector = excluded.vector,
    model  = excluded.model,
    created_at = excluded.created_at
`);

function saveEmbed(obsId, floats, model) {
  const buf = Buffer.allocUnsafe(floats.length * 4);
  for (let i = 0; i < floats.length; i++) buf.writeFloatLE(floats[i], i * 4);
  upsertEmbed.run(obsId, buf, model);
}

// ─── Main loop ─────────────────────────────────────────────────────────────

let reindexed = 0;
let errors    = 0;
const MODEL   = 'text-embedding-3-small';

for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
  const batch = candidates.slice(i, i + BATCH_SIZE).filter(o => o.summary && o.summary.length >= 5);
  if (batch.length === 0) continue;

  try {
    const vectors = await embedBatch(batch.map(o => o.summary));
    for (let j = 0; j < batch.length; j++) {
      try {
        saveEmbed(batch[j].id, vectors[j], MODEL);
        reindexed++;
      } catch (e) {
        errors++;
        logErr(`save obs #${batch[j].id}: ${e.message}`);
      }
    }
  } catch (e) {
    errors++;
    logErr(`batch i=${i}: ${e.message}`);
    // If API is down / rate-limited, stop rather than hammering
    if (errors >= 3) {
      logErr('too many errors — aborting run');
      break;
    }
  }

  if (i + BATCH_SIZE < candidates.length && DELAY_MS > 0) {
    await new Promise(r => setTimeout(r, DELAY_MS));
  }
}

db.close();
log(`done: reindexed=${reindexed} errors=${errors} total=${candidates.length}`);
process.exit(errors > 0 && reindexed === 0 ? 1 : 0);
