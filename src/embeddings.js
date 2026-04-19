/**
 * embeddings.js — Generate and compare embeddings (#41 multi-provider)
 *
 * Provider abstraction:
 *   - OpenAI  (text-embedding-3-small, 1536 dims) — default
 *   - Voyage  (voyage-3-lite, 512 dims; or voyage-code-3, 1024 dims)
 *   - Fallback (keyword hash, 128 dims) — no API key required
 *
 * Provider selection (in order of precedence):
 *   1. settings.embedding_provider ("openai" | "voyage" | "fallback")
 *   2. Auto-detect from available API keys (openai first, then voyage, then fallback)
 *
 * Each provider reports its model name so that stored embeddings can be
 * re-indexed safely when the provider changes (dimension mismatch is
 * detected in cosineSimilarity).
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
const DATA_DIR = join(homedir(), '.claudeye');
const SETTINGS_PATH = join(DATA_DIR, 'settings.json');

function getSettings() {
  if (!existsSync(SETTINGS_PATH)) return {};
  try { return JSON.parse(readFileSync(SETTINGS_PATH, 'utf8')); }
  catch { return {}; }
}

// ─── Provider registry ────────────────────────────────────────────────────

/**
 * Pick the active embedding provider based on settings and available keys.
 * Returns an object describing how to embed: { name, model, dims, fn, requiresKey }.
 *
 * Exposed so CLI / tests can introspect the current provider without making
 * an actual API call.
 */
export function resolveProvider(settings = getSettings(), env = process.env) {
  const explicit = (settings.embedding_provider || env.CLAUDEYE_EMBEDDING_PROVIDER || '').toLowerCase();
  const openaiKey = settings.openai_api_key || settings.openaiApiKey || env.OPENAI_API_KEY;
  const voyageKey = settings.voyage_api_key || settings.voyageApiKey || env.VOYAGE_API_KEY;
  const voyageModel = settings.voyage_model || env.VOYAGE_MODEL || 'voyage-3-lite';

  // Explicit override
  if (explicit === 'openai') {
    return openaiKey
      ? openaiProvider(openaiKey)
      : fallbackProvider('requested openai but no openai_api_key');
  }
  if (explicit === 'voyage') {
    return voyageKey
      ? voyageProvider(voyageKey, voyageModel)
      : fallbackProvider('requested voyage but no voyage_api_key');
  }
  if (explicit === 'fallback') {
    return fallbackProvider('explicitly selected');
  }

  // Auto-detect
  if (openaiKey) return openaiProvider(openaiKey);
  if (voyageKey) return voyageProvider(voyageKey, voyageModel);
  return fallbackProvider('no api key configured');
}

function openaiProvider(apiKey) {
  return {
    name: 'openai',
    model: 'text-embedding-3-small',
    dims: 1536,
    requiresKey: true,
    reason: null,
    fn: (text) => embedViaOpenAI(text, apiKey),
  };
}

function voyageProvider(apiKey, model) {
  // Voyage dims: voyage-3-lite=512, voyage-3=1024, voyage-code-3=1024, voyage-large-2=1536
  const DIMS_BY_MODEL = {
    'voyage-3-lite': 512,
    'voyage-3': 1024,
    'voyage-3.5': 1024,
    'voyage-3.5-lite': 1024,
    'voyage-code-3': 1024,
    'voyage-code-2': 1536,
    'voyage-large-2': 1536,
  };
  return {
    name: 'voyage',
    model,
    dims: DIMS_BY_MODEL[model] ?? 1024,
    requiresKey: true,
    reason: null,
    fn: (text) => embedViaVoyage(text, apiKey, model),
  };
}

function fallbackProvider(reason) {
  return {
    name: 'fallback',
    model: 'keyword-hash-128',
    dims: 128,
    requiresKey: false,
    reason,
    fn: (text) => Promise.resolve(keywordFallbackEmbed(text)),
  };
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * True iff a real (non-fallback) embedding provider is configured.
 * Used by reindex / save-hook to decide whether to skip embedding.
 */
export function isEmbeddingEnabled() {
  return resolveProvider().name !== 'fallback';
}

/**
 * Name of the currently-active embedding model (e.g. `text-embedding-3-small`).
 * Useful for logging and for persisting `embeddings.model` in the DB.
 */
export function currentEmbeddingModel() {
  return resolveProvider().model;
}

/**
 * Generate an embedding for the given text.
 * Returns a Float32Array. Dimension depends on the active provider.
 */
export async function embed(text) {
  const input = text.slice(0, 8000);
  const provider = resolveProvider();
  return provider.fn(input);
}

/**
 * Like embed(), but also returns provider metadata.
 * Preferred for code paths that want to persist `model` alongside the vector.
 */
export async function embedWithMeta(text) {
  const input = text.slice(0, 8000);
  const provider = resolveProvider();
  const vector = await provider.fn(input);
  return {
    vector,
    model: provider.model,
    provider: provider.name,
    dims: vector.length,
  };
}

// ─── OpenAI ───────────────────────────────────────────────────────────────

async function embedViaOpenAI(text, apiKey, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    let res;
    try {
      res = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'text-embedding-3-small',
          input: text,
          dimensions: 1536,
        }),
        signal: AbortSignal.timeout(30_000), // 30s timeout (#71)
      });
    } catch (netErr) {
      // Network error (DNS, timeout, connection refused)
      if (attempt < retries) {
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
        console.error(`[mem:embed] Network error: ${netErr.message}, retry ${attempt}/${retries} in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw new Error(`[mem:embed] Network error after ${retries} retries: ${netErr.message}`);
    }

    if (res.ok) {
      try {
        const data = await res.json();
        return new Float32Array(data.data[0].embedding);
      } catch (parseErr) {
        throw new Error(`[mem:embed] Failed to parse OpenAI response: ${parseErr.message}`);
      }
    }

    // Retry on transient errors (429, 500, 502, 503, 504)
    const status = res.status;
    if ([429, 500, 502, 503, 504].includes(status) && attempt < retries) {
      const delay = Math.min(1000 * Math.pow(2, attempt - 1), 8000); // 1s, 2s, 4s
      console.error(`[mem:embed] OpenAI ${status}, retry ${attempt}/${retries} in ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
      continue;
    }

    const err = await res.text().catch(() => '(unreadable body)');
    throw new Error(`[mem:embed] OpenAI ${status}: ${err}`);
  }
}

// ─── Voyage AI ────────────────────────────────────────────────────────────

async function embedViaVoyage(text, apiKey, model, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    let res;
    try {
      res = await fetch('https://api.voyageai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          input: text,
          input_type: 'document',
        }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (netErr) {
      if (attempt < retries) {
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
        console.error(`[mem:embed] Voyage network error: ${netErr.message}, retry ${attempt}/${retries} in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw new Error(`[mem:embed] Voyage network error after ${retries} retries: ${netErr.message}`);
    }

    if (res.ok) {
      try {
        const data = await res.json();
        const emb = data?.data?.[0]?.embedding;
        if (!emb) throw new Error(`Voyage response missing data[0].embedding`);
        return new Float32Array(emb);
      } catch (parseErr) {
        throw new Error(`[mem:embed] Failed to parse Voyage response: ${parseErr.message}`);
      }
    }

    const status = res.status;
    if ([429, 500, 502, 503, 504].includes(status) && attempt < retries) {
      const delay = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
      console.error(`[mem:embed] Voyage ${status}, retry ${attempt}/${retries} in ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
      continue;
    }

    const err = await res.text().catch(() => '(unreadable body)');
    throw new Error(`[mem:embed] Voyage ${status}: ${err}`);
  }
}

// ─── Keyword fallback ─────────────────────────────────────────────────────

/**
 * Keyword fallback — 128-dim bag-of-words style vector.
 * Good enough for rough similarity when no API key is available.
 */
function keywordFallbackEmbed(text) {
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
  return normalize(vec);
}

// ─── Similarity ───────────────────────────────────────────────────────────

let _dimMismatchWarned = 0;
const DIM_MISMATCH_WARN_LIMIT = 5;

export function cosineSimilarity(a, b) {
  if (a.length !== b.length) {
    if (_dimMismatchWarned < DIM_MISMATCH_WARN_LIMIT) {
      console.error(`[mem:embed] ⚠ dimension mismatch: ${a.length} vs ${b.length} — run 'claudeye reindex' to fix`);
      _dimMismatchWarned++;
      if (_dimMismatchWarned === DIM_MISMATCH_WARN_LIMIT) {
        console.error('[mem:embed] (suppressing further mismatch warnings)');
      }
    }
    return 0;
  }
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na  += a[i] * a[i];
    nb  += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

function normalize(vec) {
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm === 0) return vec;
  return vec.map(v => v / norm);
}

export function bufToFloat32(buf) {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}
