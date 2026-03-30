/**
 * src/reindex.js — Rebuild embeddings for observations missing them or with degraded (128-dim) vectors.
 *
 * Uses OpenAI text-embedding-3-small (1536 dims).
 * Batches requests to avoid rate limits.
 */

import { getDb, saveEmbedding } from './db.js';
import { embed, isEmbeddingEnabled } from './embeddings.js';

/**
 * Reindex observations that are missing embeddings or have degraded (non-1536) vectors.
 *
 * @param {Object} opts
 * @param {number} opts.batchSize  - observations per batch (default 50)
 * @param {number} opts.delayMs    - delay between batches in ms (default 500)
 * @param {boolean} opts.force     - re-embed ALL observations, even those with 1536-dim vectors
 * @param {string|null} opts.project - scope to a specific project
 * @param {function} opts.onProgress - callback({ done, total, current })
 * @returns {{ reindexed: number, skipped: number, errors: number, total: number }}
 */
export async function reindex(opts = {}) {
  const {
    batchSize = 50,
    delayMs = 500,
    force = false,
    project = null,
    onProgress = null,
  } = opts;

  if (!isEmbeddingEnabled()) {
    throw new Error('No embedding API key configured. Run: claudeye setup');
  }

  const db = getDb();

  // Get observations that need (re-)embedding
  let observations;
  if (force) {
    // All observations
    const query = project
      ? `SELECT id, summary FROM observations WHERE project = ? ORDER BY created_at ASC`
      : `SELECT id, summary FROM observations ORDER BY created_at ASC`;
    observations = project ? db.prepare(query).all(project) : db.prepare(query).all();
  } else {
    // Only those missing embeddings or with degraded (non-1536 dim) vectors
    const query = project
      ? `SELECT o.id, o.summary FROM observations o
         LEFT JOIN embeddings e ON e.observation_id = o.id
         WHERE o.project = ? AND (e.observation_id IS NULL OR length(e.vector) != ${1536 * 4})
         ORDER BY o.created_at ASC`
      : `SELECT o.id, o.summary FROM observations o
         LEFT JOIN embeddings e ON e.observation_id = o.id
         WHERE e.observation_id IS NULL OR length(e.vector) != ${1536 * 4}
         ORDER BY o.created_at ASC`;
    observations = project ? db.prepare(query).all(project) : db.prepare(query).all();
  }

  const total = observations.length;
  let reindexed = 0;
  let skipped = 0;
  let errors = 0;

  for (let i = 0; i < total; i += batchSize) {
    const batch = observations.slice(i, i + batchSize);

    for (const obs of batch) {
      if (!obs.summary || obs.summary.length < 5) {
        skipped++;
        continue;
      }

      try {
        const vec = await embed(obs.summary);
        saveEmbedding(obs.id, vec);
        reindexed++;
      } catch (e) {
        errors++;
        if (errors <= 3) {
          console.error(`  [reindex] Error on obs #${obs.id}: ${e.message}`);
        } else if (errors === 4) {
          console.error(`  [reindex] Suppressing further errors...`);
        }
      }
    }

    if (onProgress) {
      onProgress({ done: Math.min(i + batchSize, total), total });
    }

    // Rate limit delay between batches
    if (i + batchSize < total && delayMs > 0) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  return { reindexed, skipped, errors, total };
}
