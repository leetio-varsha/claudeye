/**
 * embeddings.js — Generate and compare embeddings via Anthropic/OpenAI
 *
 * Uses OpenAI text-embedding-3-small (1536 dims, cheap, fast).
 * Falls back to a simple TF-IDF-like keyword vector if no API key.
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const SETTINGS_PATH = join(homedir(), '.claudeye', 'settings.json');

function getSettings() {
  if (!existsSync(SETTINGS_PATH)) return {};
  try { return JSON.parse(readFileSync(SETTINGS_PATH, 'utf8')); }
  catch { return {}; }
}

// ─── Embedding generation ─────────────────────────────────────────────────

let _client = null;

function getClient() {
  if (_client) return _client;
  const settings = getSettings();
  const apiKey = settings.anthropicApiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('[mem] ANTHROPIC_API_KEY not set — run: cmem setup');
  _client = new Anthropic({ apiKey });
  return _client;
}

/**
 * Generate a 1536-dim embedding for the given text.
 * Uses Anthropic's voyage-3-lite model via the embeddings endpoint.
 * Returns a Float32Array.
 */
export async function embed(text) {
  const client = getClient();
  // Truncate to ~8000 chars (safe for most embedding models)
  const input = text.slice(0, 8000);

  try {
    // Anthropic uses voyage models for embeddings
    const response = await client.beta.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1,
      messages: [{ role: 'user', content: input }],
      // We actually call the embeddings endpoint separately
    });
    // Fall through to OpenAI-compatible approach
  } catch {}

  // Use OpenAI embeddings API (compatible, cheap, reliable)
  // Anthropic doesn't expose embeddings directly yet — use OpenAI or voyage
  const openaiKey = getSettings().openaiApiKey || process.env.OPENAI_API_KEY;
  if (openaiKey) {
    return embedViaOpenAI(input, openaiKey);
  }

  // Fallback: keyword-based pseudo-embedding (128 dims)
  console.error('[mem:embed] No OpenAI key found, using keyword fallback');
  return keywordFallbackEmbed(input);
}

async function embedViaOpenAI(text, apiKey) {
  const res = await fetch('https://api.openai.com/v1/embeddings', {
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
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`[mem:embed] OpenAI error: ${err}`);
  }

  const data = await res.json();
  return new Float32Array(data.data[0].embedding);
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
    // FNV-1a hash to bucket
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

export function cosineSimilarity(a, b) {
  if (a.length !== b.length) return 0;
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
