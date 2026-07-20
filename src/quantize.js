/**
 * quantize.js — int8 scalar quantization for embedding vectors (#138)
 *
 * Motivation: `embeddings` is 65% of mem.db (318 MB of 490 MB). Vectors are
 * stored as raw Float32Array blobs: 1536 dims × 4 bytes = 6144 bytes each.
 * Retention/purge only touch text and junk, never the vectors — so the only
 * remaining lever on DB size is the storage format itself.
 *
 * Symmetric per-vector scalar quantization float32 → int8:
 *   scale = max(|v|) / 127
 *   q[i]  = round(v[i] / scale)          (clamped to [-127, 127])
 *   v[i] ≈ q[i] * scale
 *
 * Storage: 6144 → 1544 bytes (≈3.98× smaller).
 *
 * Why this is safe for search: every consumer of these vectors runs them
 * through `cosineSimilarity`, which normalizes both operands — so the scale
 * factor cancels out entirely and only the rounding of the direction survives.
 * At 1536 dims the per-component rounding error averages out; measured cosine
 * drift is < 0.5% (see test/quantize.test.js).
 *
 * ─── Blob layout (little-endian, 8-byte header) ───────────────────────────
 *   [0..1]  magic  0x51 0x38  ('Q8')
 *   [2]     version (1)
 *   [3]     reserved (0)
 *   [4..7]  float32 scale
 *   [8..]   int8 components (one byte per dimension)
 *
 * The blob is self-describing (magic + version), and the `embeddings.format`
 * column ('f32' | 'i8') is the authoritative source of truth. Readers should
 * prefer the column and fall back to magic sniffing for rows written before
 * the column existed.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export const FORMAT_F32 = 'f32';
export const FORMAT_I8 = 'i8';

export const Q8_HEADER_BYTES = 8;
export const Q8_VERSION = 1;
const MAGIC_0 = 0x51; // 'Q'
const MAGIC_1 = 0x38; // '8'
const INT8_MAX = 127;

/**
 * Quantize a Float32Array to an int8 blob.
 *
 * @param {Float32Array|number[]} vector
 * @returns {Buffer} self-describing int8 blob (8-byte header + dims bytes)
 */
export function quantizeToI8(vector) {
  const dims = vector.length;
  if (dims === 0) throw new Error('[quantize] refusing to quantize an empty vector');

  let maxAbs = 0;
  for (let i = 0; i < dims; i++) {
    const a = Math.abs(vector[i]);
    if (a > maxAbs) maxAbs = a;
  }

  // All-zero vector: scale 0 would produce NaN on dequantize. Store scale 0 and
  // all-zero components — dequantizes back to an exact zero vector.
  const scale = maxAbs === 0 ? 0 : maxAbs / INT8_MAX;

  const buf = Buffer.allocUnsafe(Q8_HEADER_BYTES + dims);
  buf[0] = MAGIC_0;
  buf[1] = MAGIC_1;
  buf[2] = Q8_VERSION;
  buf[3] = 0;
  buf.writeFloatLE(scale, 4);

  if (scale === 0) {
    buf.fill(0, Q8_HEADER_BYTES);
    return buf;
  }

  for (let i = 0; i < dims; i++) {
    let q = Math.round(vector[i] / scale);
    if (q > INT8_MAX) q = INT8_MAX;
    else if (q < -INT8_MAX) q = -INT8_MAX;
    buf.writeInt8(q, Q8_HEADER_BYTES + i);
  }
  return buf;
}

/**
 * Dequantize an int8 blob back to a Float32Array.
 *
 * @param {Buffer} buf
 * @returns {Float32Array}
 */
export function dequantizeI8(buf) {
  if (!isQuantized(buf)) {
    throw new Error('[quantize] buffer is not a valid int8 vector blob');
  }
  const scale = buf.readFloatLE(4);
  const dims = buf.length - Q8_HEADER_BYTES;
  const out = new Float32Array(dims);
  for (let i = 0; i < dims; i++) {
    out[i] = buf.readInt8(Q8_HEADER_BYTES + i) * scale;
  }
  return out;
}

/**
 * True iff the buffer carries the int8 magic header and a plausible length.
 * Used as a fallback when the `format` column is unavailable.
 */
export function isQuantized(buf) {
  return Boolean(
    buf &&
    buf.length > Q8_HEADER_BYTES &&
    buf[0] === MAGIC_0 &&
    buf[1] === MAGIC_1 &&
    buf[2] === Q8_VERSION
  );
}

/**
 * Decode a stored vector blob into a Float32Array, regardless of format.
 *
 * @param {Buffer} buf
 * @param {string|null} format  value of `embeddings.format`, if the caller has it
 * @returns {Float32Array}
 */
export function decodeVector(buf, format = null) {
  if (!buf) return new Float32Array(0);
  if (format === FORMAT_I8 || (format == null && isQuantized(buf))) {
    return dequantizeI8(buf);
  }
  // float32: copy out rather than aliasing — better-sqlite3 buffers may be
  // pooled/shared, and a stale view would silently corrupt later reads.
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

/**
 * Number of dimensions a stored blob represents.
 */
export function vectorDims(buf, format = null) {
  if (!buf) return 0;
  if (format === FORMAT_I8 || (format == null && isQuantized(buf))) {
    return buf.length - Q8_HEADER_BYTES;
  }
  return Math.floor(buf.length / 4);
}

/**
 * Byte length a vector of `dims` dimensions occupies in the given format.
 */
export function expectedByteLength(dims, format) {
  return format === FORMAT_I8 ? dims + Q8_HEADER_BYTES : dims * 4;
}

/**
 * Whether NEW embeddings should be written in int8 form.
 *
 * Default: OFF, deliberately — this is a two-step rollout.
 *
 * The read path is format-aware everywhere in src/, but `reindex-standalone.mjs`
 * is *deployed by hand* to ~/.claudeye/ and older deployed copies detect degraded
 * vectors by raw byte length (`length(vector) != 6144`). Such a copy would classify
 * every int8 row as degraded and re-embed the entire corpus against the paid API,
 * writing it back as float32 — an expensive loop.
 *
 * So writes stay float32 until the environment is ready. Rollout:
 *   1. `claudeye quantize-embeddings --dry-run`   — check the projected saving
 *   2. `cp scripts/reindex-standalone.mjs ~/.claudeye/`  — refresh the deployed copy
 *   3. `claudeye quantize-embeddings --vacuum`    — convert + reclaim space
 *   4. set `embedding_quantize: true` in ~/.claudeye/settings.json
 *
 * Flipping this is non-destructive in either direction: existing rows keep their
 * own format and both are readable.
 */
export function isQuantizationEnabled(settings = null, env = process.env) {
  const envVal = env.CLAUDEYE_EMBEDDING_QUANTIZE;
  if (envVal != null && envVal !== '') {
    return ['1', 'true', 'yes', 'on'].includes(String(envVal).toLowerCase());
  }
  const s = settings ?? readSettings();
  return s.embedding_quantize === true || s.embeddingQuantize === true;
}

function readSettings() {
  const p = join(homedir(), '.claudeye', 'settings.json');
  if (!existsSync(p)) return {};
  try { return JSON.parse(readFileSync(p, 'utf8')); }
  catch { return {}; }
}

/**
 * SQL expression yielding the dimension count of a stored vector, format-aware.
 *
 * Single source of truth shared by src/ and scripts/ standalone copies so the
 * "degraded vector" detection in reindex can't drift between them (#118/#125).
 *
 * @param {string} alias  table alias for the `embeddings` row (e.g. 'e')
 */
export function vectorDimsSql(alias = 'e') {
  return `(CASE WHEN ${alias}.format = '${FORMAT_I8}' ` +
         `THEN length(${alias}.vector) - ${Q8_HEADER_BYTES} ` +
         `ELSE length(${alias}.vector) / 4 END)`;
}
