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

// ─── int8 quantization (#138) ──────────────────────────────────────────────
// DRIFT-GUARD: this is an inlined copy of src/quantize.js. This script is
// deployed to ~/.claudeye/ and cannot import from the repo. Any change here
// must mirror src/quantize.js — test/quantize.test.js asserts byte-for-byte
// parity between the two implementations (see #118/#125 for prior drift bugs).

const Q8_HEADER_BYTES = 8;
const Q8_VERSION      = 1;

function quantizeToI8(vector) {
  const dims = vector.length;
  let maxAbs = 0;
  for (let i = 0; i < dims; i++) {
    const a = Math.abs(vector[i]);
    if (a > maxAbs) maxAbs = a;
  }
  const scale = maxAbs === 0 ? 0 : maxAbs / 127;
  const buf = Buffer.allocUnsafe(Q8_HEADER_BYTES + dims);
  buf[0] = 0x51; buf[1] = 0x38; buf[2] = Q8_VERSION; buf[3] = 0;
  buf.writeFloatLE(scale, 4);
  if (scale === 0) { buf.fill(0, Q8_HEADER_BYTES); return buf; }
  for (let i = 0; i < dims; i++) {
    let q = Math.round(vector[i] / scale);
    if (q > 127) q = 127; else if (q < -127) q = -127;
    buf.writeInt8(q, Q8_HEADER_BYTES + i);
  }
  return buf;
}

// Does this DB know about embeddings.format? If src/db.js migrations haven't
// run yet, fall back to legacy float32 writes rather than failing the insert.
const HAS_FORMAT_COL = db.prepare(`PRAGMA table_info(embeddings)`)
  .all().some(c => c.name === 'format');

// Opt-in, default OFF — mirrors isQuantizationEnabled() in src/quantize.js.
const QUANTIZE = HAS_FORMAT_COL && (() => {
  const env = process.env.CLAUDEYE_EMBEDDING_QUANTIZE;
  if (env != null && env !== '') return ['1', 'true', 'yes', 'on'].includes(String(env).toLowerCase());
  return getSettings().embedding_quantize === true;
})();

// Format-aware dimension check — mirrors vectorDimsSql() in src/quantize.js.
// Must NOT compare raw byte length: an int8 vector is ~4x shorter but valid,
// and treating it as degraded would re-embed the whole corpus against the API.
const DIMS_SQL = HAS_FORMAT_COL
  ? `(CASE WHEN e.format = 'i8' THEN length(e.vector) - ${Q8_HEADER_BYTES} ELSE length(e.vector) / 4 END)`
  : `(length(e.vector) / 4)`;

// ─── Select candidates ─────────────────────────────────────────────────────

const MAX_PER_RUN  = 100;   // max obs to embed per scheduler run
const TARGET_DIMS  = 1536;  // text-embedding-3-small
const BATCH_SIZE   = 25;    // obs per API request batch
const DELAY_MS     = 400;   // ms between batches

const candidates = db.prepare(`
  SELECT o.id, o.summary FROM observations o
  LEFT JOIN embeddings e ON e.observation_id = o.id
  WHERE (e.observation_id IS NULL OR ${DIMS_SQL} != ?)
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
`).all(TARGET_DIMS, MAX_PER_RUN);

if (candidates.length === 0) {
  log('nothing to reindex — exit 0');
  process.exit(0);
}

log(`found ${candidates.length} obs to embed (max=${MAX_PER_RUN})`);

// ─── OpenAI embed helper ───────────────────────────────────────────────────

const EMBED_URL     = 'https://api.openai.com/v1/embeddings';
const EMBED_RETRIES = 3;     // network attempts per batch (launchd runs right after
                             // wake — DNS/route may not be up for the first seconds)
const RETRY_BASE_MS = 2000;  // backoff: 2s, 4s

// undici's fetch() throws TypeError('fetch failed') and hides the real reason
// (ENOTFOUND, ECONNREFUSED, ETIMEDOUT…) in e.cause — surface it in logs.
function describeNetError(e) {
  const c = e.cause;
  if (!c) return e.message;
  const code = c.code || c.errno || c.name || '';
  return `${e.message} (cause: ${code}${c.message ? ` ${c.message}` : ''})`;
}

async function embedBatch(texts) {
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(EMBED_URL, {
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
    } catch (netErr) {
      if (attempt < EMBED_RETRIES) {
        const delay = RETRY_BASE_MS * attempt;
        log(`openai ${EMBED_URL}: ${describeNetError(netErr)} — retry ${attempt}/${EMBED_RETRIES} in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw new Error(`openai ${EMBED_URL}: ${describeNetError(netErr)} after ${EMBED_RETRIES} attempts`);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`openai ${EMBED_URL} HTTP ${res.status}: ${body.slice(0, 200)}`);
    }

    const json = await res.json();
    return json.data.map(d => d.embedding); // array of float[] in input order
  }
}

// ─── Save embedding ────────────────────────────────────────────────────────

const upsertEmbed = HAS_FORMAT_COL
  ? db.prepare(`
      INSERT INTO embeddings (observation_id, vector, model, format, created_at)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(observation_id) DO UPDATE SET
        vector = excluded.vector,
        model  = excluded.model,
        format = excluded.format,
        created_at = excluded.created_at
    `)
  : db.prepare(`
      INSERT INTO embeddings (observation_id, vector, model, created_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(observation_id) DO UPDATE SET
        vector = excluded.vector,
        model  = excluded.model,
        created_at = excluded.created_at
    `);

function saveEmbed(obsId, floats, model) {
  if (QUANTIZE) {
    upsertEmbed.run(obsId, quantizeToI8(floats), model, 'i8');
    return;
  }
  const buf = Buffer.allocUnsafe(floats.length * 4);
  for (let i = 0; i < floats.length; i++) buf.writeFloatLE(floats[i], i * 4);
  if (HAS_FORMAT_COL) upsertEmbed.run(obsId, buf, model, 'f32');
  else upsertEmbed.run(obsId, buf, model);
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
