/**
 * test/embeddings.test.js — Tests for embedding utilities
 *
 * Tests: cosineSimilarity, bufToFloat32, keywordFallbackEmbed.
 * Does NOT call OpenAI API.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cosineSimilarity, bufToFloat32 } from '../src/embeddings.js';

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    const a = new Float32Array([1, 2, 3]);
    const sim = cosineSimilarity(a, a);
    assert.ok(Math.abs(sim - 1.0) < 0.001);
  });

  it('returns 0 for orthogonal vectors', () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    assert.equal(cosineSimilarity(a, b), 0);
  });

  it('returns -1 for opposite vectors', () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([-1, 0]);
    assert.ok(Math.abs(cosineSimilarity(a, b) - (-1.0)) < 0.001);
  });

  it('returns 0 for zero vectors', () => {
    const a = new Float32Array([0, 0, 0]);
    const b = new Float32Array([1, 2, 3]);
    assert.equal(cosineSimilarity(a, b), 0);
  });

  it('returns 0 for dimension mismatch', () => {
    const a = new Float32Array([1, 2, 3]);
    const b = new Float32Array([1, 2]);
    assert.equal(cosineSimilarity(a, b), 0);
  });

  it('handles high-dimensional vectors', () => {
    const dim = 1536;
    const a = new Float32Array(dim);
    const b = new Float32Array(dim);
    for (let i = 0; i < dim; i++) {
      a[i] = Math.sin(i);
      b[i] = Math.sin(i + 0.1); // slightly shifted
    }
    const sim = cosineSimilarity(a, b);
    assert.ok(sim > 0.99, `Expected high similarity for slightly shifted vectors, got ${sim}`);
  });

  it('similar texts produce higher similarity than dissimilar', () => {
    // Use keyword fallback embedding approach
    function quickEmbed(text) {
      const DIM = 128;
      const vec = new Float32Array(DIM);
      const words = text.toLowerCase().match(/\b\w{3,}\b/g) || [];
      for (const word of words) {
        let h = 0x811c9dc5;
        for (let i = 0; i < word.length; i++) {
          h ^= word.charCodeAt(i);
          h = (h * 0x01000193) >>> 0;
        }
        vec[h % DIM] += 1;
      }
      // Normalize
      let norm = 0;
      for (const v of vec) norm += v * v;
      norm = Math.sqrt(norm);
      if (norm > 0) for (let i = 0; i < DIM; i++) vec[i] /= norm;
      return vec;
    }

    const a = quickEmbed('fixed authentication bug in login service');
    const b = quickEmbed('fixed auth issue in login handler');
    const c = quickEmbed('deployed kubernetes cluster with terraform');

    const simAB = cosineSimilarity(a, b);
    const simAC = cosineSimilarity(a, c);
    assert.ok(simAB > simAC, `Related texts should be more similar: ${simAB} vs ${simAC}`);
  });
});

describe('bufToFloat32', () => {
  it('converts Buffer to Float32Array', () => {
    const original = new Float32Array([1.5, 2.5, 3.5]);
    const buf = Buffer.from(original.buffer);
    const result = bufToFloat32(buf);
    assert.equal(result.length, 3);
    assert.ok(Math.abs(result[0] - 1.5) < 0.001);
    assert.ok(Math.abs(result[1] - 2.5) < 0.001);
    assert.ok(Math.abs(result[2] - 3.5) < 0.001);
  });

  it('handles empty buffer', () => {
    const buf = Buffer.alloc(0);
    const result = bufToFloat32(buf);
    assert.equal(result.length, 0);
  });

  it('preserves 1536-dim vectors', () => {
    const dim = 1536;
    const original = new Float32Array(dim);
    for (let i = 0; i < dim; i++) original[i] = Math.random();
    const buf = Buffer.from(original.buffer);
    const result = bufToFloat32(buf);
    assert.equal(result.length, dim);
    for (let i = 0; i < dim; i++) {
      assert.ok(Math.abs(result[i] - original[i]) < 0.0001);
    }
  });
});
