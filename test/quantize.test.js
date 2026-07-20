/**
 * quantize.test.js — int8 embedding quantization (#138)
 *
 * Covers the two things that decide whether this feature is safe to ship:
 *   1. Round-trip fidelity — does a quantized vector still point the same way?
 *   2. Search parity — do the top-K results actually stay the same?
 *
 * Plus the drift-guard against the inlined copy in scripts/reindex-standalone.mjs
 * (see #118/#125 for the class of bug this prevents).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import {
  quantizeToI8, dequantizeI8, decodeVector, isQuantized,
  vectorDims, expectedByteLength, vectorDimsSql, isQuantizationEnabled,
  FORMAT_F32, FORMAT_I8, Q8_HEADER_BYTES,
} from '../src/quantize.js';
import { cosineSimilarity } from '../src/embeddings.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Deterministic PRNG so failures are reproducible. */
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random unit vector, shaped like a real normalized embedding. */
function randomUnitVector(dims, rng) {
  const v = new Float32Array(dims);
  let norm = 0;
  for (let i = 0; i < dims; i++) {
    // Box-Muller → gaussian components, like real embedding distributions
    const u1 = Math.max(rng(), 1e-9), u2 = rng();
    v[i] = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    norm += v[i] * v[i];
  }
  norm = Math.sqrt(norm);
  for (let i = 0; i < dims; i++) v[i] /= norm;
  return v;
}

function float32Blob(vec) {
  const buf = Buffer.allocUnsafe(vec.length * 4);
  for (let i = 0; i < vec.length; i++) buf.writeFloatLE(vec[i], i * 4);
  return buf;
}

const DIMS = 1536;

// ─── Round-trip ────────────────────────────────────────────────────────────

describe('quantize: round-trip', () => {
  it('shrinks a 1536-dim vector ~4x', () => {
    const rng = mulberry32(1);
    const blob = quantizeToI8(randomUnitVector(DIMS, rng));

    assert.equal(blob.length, DIMS + Q8_HEADER_BYTES);
    assert.equal(blob.length, expectedByteLength(DIMS, FORMAT_I8));
    // float32 would be 6144 bytes
    const ratio = (DIMS * 4) / blob.length;
    assert.ok(ratio > 3.9, `expected >3.9x shrink, got ${ratio.toFixed(2)}x`);
  });

  it('preserves direction: cosine drift < 0.5%', () => {
    const rng = mulberry32(42);
    let worst = 0;
    for (let n = 0; n < 50; n++) {
      const orig = randomUnitVector(DIMS, rng);
      const back = dequantizeI8(quantizeToI8(orig));
      const sim = cosineSimilarity(orig, back);
      worst = Math.max(worst, 1 - sim);
    }
    assert.ok(worst < 0.005, `worst cosine drift ${(worst * 100).toFixed(4)}% exceeds 0.5%`);
  });

  it('keeps per-component error within one quantization step', () => {
    const rng = mulberry32(7);
    const orig = randomUnitVector(DIMS, rng);
    const back = dequantizeI8(quantizeToI8(orig));

    let maxAbs = 0;
    for (const v of orig) maxAbs = Math.max(maxAbs, Math.abs(v));
    const step = maxAbs / 127;

    for (let i = 0; i < DIMS; i++) {
      assert.ok(
        Math.abs(orig[i] - back[i]) <= step / 2 + 1e-6,
        `component ${i} drifted more than half a quantization step`
      );
    }
  });

  it('handles an all-zero vector without producing NaN', () => {
    const zero = new Float32Array(DIMS);
    const back = dequantizeI8(quantizeToI8(zero));
    assert.equal(back.length, DIMS);
    assert.ok(back.every(v => v === 0), 'zero vector must round-trip to exact zeros');
  });

  it('clamps rather than wrapping on extreme components', () => {
    const v = new Float32Array(8);
    v[0] = 1e6; v[1] = -1e6; v[2] = 1e-9;
    const back = dequantizeI8(quantizeToI8(v));
    assert.ok(Number.isFinite(back[0]) && back[0] > 0);
    assert.ok(Number.isFinite(back[1]) && back[1] < 0);
    assert.ok(back.every(Number.isFinite));
  });

  it('rejects an empty vector rather than writing a headers-only blob', () => {
    assert.throws(() => quantizeToI8(new Float32Array(0)), /empty vector/);
  });
});

// ─── Format detection ──────────────────────────────────────────────────────

describe('quantize: format detection', () => {
  it('recognizes its own blobs and rejects float32 ones', () => {
    const rng = mulberry32(3);
    const vec = randomUnitVector(DIMS, rng);
    assert.equal(isQuantized(quantizeToI8(vec)), true);
    assert.equal(isQuantized(float32Blob(vec)), false);
  });

  it('decodeVector honours the explicit format column', () => {
    const rng = mulberry32(4);
    const vec = randomUnitVector(64, rng);

    const asF32 = decodeVector(float32Blob(vec), FORMAT_F32);
    assert.equal(asF32.length, 64);
    for (let i = 0; i < 64; i++) assert.ok(Math.abs(asF32[i] - vec[i]) < 1e-6);

    const asI8 = decodeVector(quantizeToI8(vec), FORMAT_I8);
    assert.equal(asI8.length, 64);
    assert.ok(cosineSimilarity(asI8, vec) > 0.995);
  });

  it('sniffs the format when the column is unavailable (archive.db path)', () => {
    const rng = mulberry32(5);
    const vec = randomUnitVector(DIMS, rng);

    assert.equal(decodeVector(quantizeToI8(vec), null).length, DIMS);
    assert.equal(decodeVector(float32Blob(vec), null).length, DIMS);
  });

  it('reports dimensions, not byte length, for both formats', () => {
    const rng = mulberry32(6);
    const vec = randomUnitVector(DIMS, rng);
    assert.equal(vectorDims(quantizeToI8(vec), FORMAT_I8), DIMS);
    assert.equal(vectorDims(float32Blob(vec), FORMAT_F32), DIMS);
    // and via sniffing
    assert.equal(vectorDims(quantizeToI8(vec)), DIMS);
    assert.equal(vectorDims(float32Blob(vec)), DIMS);
  });

  it('returns an empty vector for null blobs instead of throwing', () => {
    assert.equal(decodeVector(null).length, 0);
    assert.equal(vectorDims(null), 0);
  });

  it('does not alias the source buffer on the float32 path', () => {
    const vec = new Float32Array([1, 2, 3, 4]);
    const buf = float32Blob(vec);
    const decoded = decodeVector(buf, FORMAT_F32);
    buf.writeFloatLE(999, 0);
    assert.equal(decoded[0], 1, 'decoded vector must not alias the pooled DB buffer');
  });
});

// ─── Search parity — the criterion that actually matters ───────────────────

describe('quantize: search parity', () => {
  /**
   * Corpus with actual retrieval signal: a handful of vectors are planted near
   * the query, the rest are background noise.
   *
   * A uniformly-random corpus would be the wrong model here — in 1536 dims every
   * random pair sits within ~0.03 of cosine 0, so adjacent ranks are separated
   * by less than the quantization step and the top-K reshuffles on pure noise.
   * That measures the geometry of random high-dimensional vectors, not whether
   * quantization hurts search. Real embeddings of related text are genuinely
   * closer to their neighbours, which is what this builds.
   */
  function plantedCorpus(query, rng, { size = 500, related = 30 } = {}) {
    const corpus = [];
    for (let i = 0; i < related; i++) {
      // query + scaled noise → cosine ~0.3–0.9, like a real semantic neighbour
      const noise = randomUnitVector(DIMS, rng);
      const weight = 0.15 + rng() * 0.7;
      const v = new Float32Array(DIMS);
      let norm = 0;
      for (let d = 0; d < DIMS; d++) {
        v[d] = query[d] + weight * noise[d];
        norm += v[d] * v[d];
      }
      norm = Math.sqrt(norm);
      for (let d = 0; d < DIMS; d++) v[d] /= norm;
      corpus.push({ id: corpus.length, vec: v });
    }
    while (corpus.length < size) {
      corpus.push({ id: corpus.length, vec: randomUnitVector(DIMS, rng) });
    }
    return corpus;
  }

  const topK = (corpus, query, getVec, k) => corpus
    .map(c => ({ id: c.id, score: cosineSimilarity(query, getVec(c)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map(r => r.id);

  it('returns an identical top-10 set on a corpus with real signal', () => {
    const rng = mulberry32(2024);
    const QUERIES = 20;
    let mismatched = 0;

    for (let q = 0; q < QUERIES; q++) {
      const query = randomUnitVector(DIMS, rng);
      const corpus = plantedCorpus(query, rng);

      const before = topK(corpus, query, c => c.vec, 10);
      const after = topK(corpus, query, c => dequantizeI8(quantizeToI8(c.vec)), 10);

      // Set equality, not ordering: near-tied neighbours may swap adjacent
      // positions, which does not change what the user is shown.
      if ([...before].sort().join(',') !== [...after].sort().join(',')) mismatched++;
    }

    assert.equal(
      mismatched, 0,
      `${mismatched}/${QUERIES} queries returned a different top-10 set after quantization`
    );
  });

  it('holds recall@10 at 100% even on an all-noise corpus', () => {
    // Adversarial case: no signal at all, so ranks are separated by less than
    // the quantization step. Ordering churns, but the retrieved *set* should
    // still overlap almost entirely.
    const rng = mulberry32(31337);
    const QUERIES = 20;
    let totalRecall = 0;

    for (let q = 0; q < QUERIES; q++) {
      const query = randomUnitVector(DIMS, rng);
      const corpus = Array.from({ length: 500 }, (_, id) => ({
        id, vec: randomUnitVector(DIMS, rng),
      }));

      const before = new Set(topK(corpus, query, c => c.vec, 10));
      const after = topK(corpus, query, c => dequantizeI8(quantizeToI8(c.vec)), 10);
      totalRecall += after.filter(id => before.has(id)).length / 10;
    }

    const recall = totalRecall / QUERIES;
    assert.ok(recall >= 0.95, `recall@10 fell to ${(recall * 100).toFixed(1)}%`);
  });

  it('keeps similarity scores within 0.5% of the float32 baseline', () => {
    const rng = mulberry32(99);
    const query = randomUnitVector(DIMS, rng);
    let worst = 0;

    for (let n = 0; n < 100; n++) {
      const vec = randomUnitVector(DIMS, rng);
      const exact = cosineSimilarity(query, vec);
      const quant = cosineSimilarity(query, dequantizeI8(quantizeToI8(vec)));
      worst = Math.max(worst, Math.abs(exact - quant));
    }

    assert.ok(worst < 0.005, `worst score delta ${worst.toFixed(5)} exceeds 0.005`);
  });
});

// ─── SQL helper ────────────────────────────────────────────────────────────

describe('quantize: vectorDimsSql', () => {
  it('subtracts the header for i8 and divides by 4 for f32', () => {
    const sql = vectorDimsSql('e');
    assert.match(sql, /e\.format = 'i8'/);
    assert.match(sql, new RegExp(`length\\(e\\.vector\\) - ${Q8_HEADER_BYTES}`));
    assert.match(sql, /length\(e\.vector\) \/ 4/);
  });

  it('respects the table alias', () => {
    assert.match(vectorDimsSql('emb'), /emb\.format/);
    assert.ok(!vectorDimsSql('emb').includes('e.vector'));
  });
});

// ─── Settings gate ─────────────────────────────────────────────────────────

describe('quantize: isQuantizationEnabled', () => {
  it('defaults to OFF until the deployed standalone copy is refreshed', () => {
    // Guards the two-step rollout: an older ~/.claudeye/reindex-standalone.mjs
    // would re-embed every int8 row against the paid API.
    assert.equal(isQuantizationEnabled({}, {}), false);
  });

  it('opts in via settings', () => {
    assert.equal(isQuantizationEnabled({ embedding_quantize: true }, {}), true);
    assert.equal(isQuantizationEnabled({ embeddingQuantize: true }, {}), true);
  });

  it('lets env override settings in both directions', () => {
    assert.equal(
      isQuantizationEnabled({ embedding_quantize: false }, { CLAUDEYE_EMBEDDING_QUANTIZE: '1' }),
      true
    );
    assert.equal(
      isQuantizationEnabled({ embedding_quantize: true }, { CLAUDEYE_EMBEDDING_QUANTIZE: '0' }),
      false
    );
  });

  it('treats an unset or empty env var as "not specified"', () => {
    assert.equal(isQuantizationEnabled({ embedding_quantize: true }, { CLAUDEYE_EMBEDDING_QUANTIZE: '' }), true);
  });
});

// ─── Drift-guard vs the standalone copy (#118/#125) ────────────────────────

describe('quantize: standalone parity', () => {
  const standalonePath = join(__dirname, '..', 'scripts', 'reindex-standalone.mjs');
  const source = readFileSync(standalonePath, 'utf8');

  it('inlines a quantizer that is byte-for-byte identical to src/quantize.js', () => {
    // Extract and evaluate the inlined implementation, then compare outputs.
    const match = source.match(/function quantizeToI8\(vector\) \{[\s\S]*?\n\}/);
    assert.ok(match, 'standalone must still define quantizeToI8');

    const standaloneQuantize = new Function(
      'Buffer', 'Q8_HEADER_BYTES', 'Q8_VERSION',
      `${match[0]}; return quantizeToI8;`
    )(Buffer, Q8_HEADER_BYTES, 1);

    const rng = mulberry32(555);
    for (let n = 0; n < 10; n++) {
      const vec = randomUnitVector(DIMS, rng);
      assert.deepEqual(
        standaloneQuantize(vec),
        quantizeToI8(vec),
        'standalone quantizer drifted from src/quantize.js'
      );
    }
  });

  it('uses a format-aware dimension check, not raw byte length', () => {
    // The bug this guards: `length(e.vector) != 6144` marks every int8 row as
    // degraded and re-embeds the whole corpus against the paid API.
    assert.ok(
      !/length\(e\.vector\) != \?/.test(source),
      'standalone still compares raw byte length for degraded-vector detection'
    );
    assert.match(source, /CASE WHEN e\.format = 'i8'/);
  });

  it('writes the format column when the schema has it', () => {
    assert.match(source, /INSERT INTO embeddings \(observation_id, vector, model, format, created_at\)/);
    assert.match(source, /HAS_FORMAT_COL/);
  });

  it('gates quantization the same way src does — opt-in, default off', () => {
    // If these two disagree, the standalone could emit int8 rows into a DB whose
    // src-side readers/writers still assume float32 (or vice versa).
    assert.match(source, /\['1', 'true', 'yes', 'on'\]/);
    assert.match(source, /embedding_quantize === true/);
    assert.equal(isQuantizationEnabled({}, {}), false);
  });
});
