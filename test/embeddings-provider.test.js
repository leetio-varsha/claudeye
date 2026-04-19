/**
 * test/embeddings-provider.test.js — Multi-provider embedding selection (#41)
 *
 * Pure logic tests for `resolveProvider()` — no network calls. Uses hand-built
 * settings/env inputs so it works in any sandbox (no ~/.claudeye/settings.json
 * required).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveProvider } from '../src/embeddings.js';

describe('resolveProvider: explicit selection', () => {
  it('uses openai when requested and key present', () => {
    const p = resolveProvider({ embedding_provider: 'openai', openai_api_key: 'sk-x' }, {});
    assert.equal(p.name, 'openai');
    assert.equal(p.model, 'text-embedding-3-small');
    assert.equal(p.dims, 1536);
    assert.equal(p.requiresKey, true);
  });

  it('falls back when openai explicitly requested without key', () => {
    const p = resolveProvider({ embedding_provider: 'openai' }, {});
    assert.equal(p.name, 'fallback');
    assert.match(p.reason, /openai/i);
  });

  it('uses voyage when requested with key', () => {
    const p = resolveProvider({ embedding_provider: 'voyage', voyage_api_key: 'pa-x' }, {});
    assert.equal(p.name, 'voyage');
    assert.equal(p.model, 'voyage-3-lite');
    assert.equal(p.dims, 512);
  });

  it('uses voyage model override via settings', () => {
    const p = resolveProvider(
      { embedding_provider: 'voyage', voyage_api_key: 'pa-x', voyage_model: 'voyage-code-3' },
      {},
    );
    assert.equal(p.name, 'voyage');
    assert.equal(p.model, 'voyage-code-3');
    assert.equal(p.dims, 1024);
  });

  it('falls back when voyage requested without key', () => {
    const p = resolveProvider({ embedding_provider: 'voyage' }, {});
    assert.equal(p.name, 'fallback');
    assert.match(p.reason, /voyage/i);
  });

  it('respects explicit fallback selection even with keys available', () => {
    const p = resolveProvider(
      { embedding_provider: 'fallback', openai_api_key: 'sk-x', voyage_api_key: 'pa-x' },
      {},
    );
    assert.equal(p.name, 'fallback');
    assert.equal(p.dims, 128);
  });
});

describe('resolveProvider: auto-detect', () => {
  it('prefers openai when both keys present', () => {
    const p = resolveProvider(
      { openai_api_key: 'sk-x', voyage_api_key: 'pa-x' },
      {},
    );
    assert.equal(p.name, 'openai');
  });

  it('uses voyage when only voyage key present', () => {
    const p = resolveProvider({ voyage_api_key: 'pa-x' }, {});
    assert.equal(p.name, 'voyage');
  });

  it('falls back when no key is configured', () => {
    const p = resolveProvider({}, {});
    assert.equal(p.name, 'fallback');
    assert.equal(p.dims, 128);
  });

  it('reads openai key from env', () => {
    const p = resolveProvider({}, { OPENAI_API_KEY: 'sk-env' });
    assert.equal(p.name, 'openai');
  });

  it('reads voyage key from env', () => {
    const p = resolveProvider({}, { VOYAGE_API_KEY: 'pa-env' });
    assert.equal(p.name, 'voyage');
  });

  it('env CLAUDEYE_EMBEDDING_PROVIDER overrides auto-detect', () => {
    const p = resolveProvider(
      { openai_api_key: 'sk-x', voyage_api_key: 'pa-x' },
      { CLAUDEYE_EMBEDDING_PROVIDER: 'voyage' },
    );
    assert.equal(p.name, 'voyage');
  });
});

describe('resolveProvider: voyage model dims', () => {
  const cases = [
    ['voyage-3-lite',   512],
    ['voyage-3',        1024],
    ['voyage-3.5',      1024],
    ['voyage-3.5-lite', 1024],
    ['voyage-code-3',   1024],
    ['voyage-code-2',   1536],
    ['voyage-large-2',  1536],
  ];
  for (const [model, dims] of cases) {
    it(`reports dims=${dims} for ${model}`, () => {
      const p = resolveProvider({ embedding_provider: 'voyage', voyage_api_key: 'x', voyage_model: model }, {});
      assert.equal(p.dims, dims);
    });
  }

  it('falls back to 1024 dims for unknown voyage model', () => {
    const p = resolveProvider({ embedding_provider: 'voyage', voyage_api_key: 'x', voyage_model: 'voyage-future-9' }, {});
    assert.equal(p.dims, 1024);
  });
});

describe('fallback provider produces valid 128-dim vector', async () => {
  it('keyword fallback returns 128-dim normalized Float32Array', async () => {
    const p = resolveProvider({}, {});
    assert.equal(p.name, 'fallback');
    const vec = await p.fn('hello world this is a test of the fallback embedder');
    assert.equal(vec.length, 128);
    // Unit vector: sum of squares ≈ 1 (or 0 for empty input)
    let sum = 0;
    for (const v of vec) sum += v * v;
    assert.ok(Math.abs(sum - 1) < 0.001, `expected unit length, got ${sum}`);
  });
});
