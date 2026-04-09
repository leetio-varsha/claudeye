/**
 * embeddings.js — Generate and compare embeddings
 *
 * Uses OpenAI text-embedding-3-small (1536 dims, cheap, fast).
 * Falls back to a simple keyword-hash vector if no API key.
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

// ─── Embedding config ─────────────────────────────────────────────────────

export function isEmbeddingEnabled() {
  const s = getSettings();
  const key = s.openai_api_key || s.openaiApiKey || process.env.OPENAI_API_KEY;
  return !!key;
}

// ─── Embedding generation ─────────────────────────────────────────────────

/**
 * Generate a 1536-dim embedding for the given text.
 * Uses OpenAI text-embedding-3-small. Falls back to keyword hash.
 */
export async function embed(text) {
  const input = text.slice(0, 8000);

  const s = getSettings();
  const openaiKey = s.openai_api_key || s.openaiApiKey || process.env.OPENAI_API_KEY;
  if (openaiKey) {
    return embedViaOpenAI(input, openaiKey);
  }

  // Fallback: keyword-based pseudo-embedding (128 dims)
  return keywordFallbackEmbed(input);
}

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
