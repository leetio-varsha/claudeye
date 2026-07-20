/**
 * quantize-migrate.js — batch migration of stored float32 vectors to int8 (#138)
 *
 * Idempotent: only rows with format='f32' are touched, so re-running is a no-op
 * once the corpus is converted. Runs in bounded transactions so a crash mid-way
 * leaves a consistent (partially-migrated) DB — the read path handles mixed
 * formats, so a partial migration is a valid steady state, not a broken one.
 *
 * VACUUM is deliberately NOT automatic: it rewrites the whole file, needs free
 * space equal to the DB size, and holds an exclusive lock for minutes on a
 * 490 MB DB. Space is only actually reclaimed after it runs, so the caller opts
 * in explicitly.
 */

import { getDb } from './db.js';
import { quantizeToI8, decodeVector, FORMAT_F32, FORMAT_I8 } from './quantize.js';

/**
 * Convert float32 vectors to int8 in place.
 *
 * @param {Object} opts
 * @param {boolean} opts.dryRun     — report what would change, write nothing
 * @param {number}  opts.batchSize  — rows per transaction (default 500)
 * @param {number}  opts.limit      — max rows to convert this run (default: all)
 * @param {boolean} opts.vacuum     — run VACUUM afterwards to reclaim space
 * @param {function} opts.onProgress — callback({ done, total, bytesBefore, bytesAfter })
 * @param {Object}  opts.db         — database handle (defaults to the live DB; injectable for tests)
 */
export function quantizeExistingEmbeddings(opts = {}) {
  const {
    dryRun = false,
    batchSize = 500,
    limit = null,
    vacuum = false,
    onProgress = null,
    db = getDb(),
  } = opts;

  const pending = db.prepare(
    `SELECT COUNT(*) as n, COALESCE(SUM(length(vector)), 0) as bytes
     FROM embeddings WHERE format = ?`
  ).get(FORMAT_F32);

  const total = limit ? Math.min(pending.n, limit) : pending.n;
  const sizeBefore = dbSizeBytes(db);

  if (total === 0) {
    return {
      converted: 0, skipped: 0, errors: 0, total: 0,
      bytesBefore: 0, bytesAfter: 0, sizeBefore, sizeAfter: sizeBefore,
      vacuumed: false, dryRun,
    };
  }

  if (dryRun) {
    // int8 blob = dims + 8 header bytes; float32 blob = dims * 4.
    const estimatedAfter = Math.round(pending.bytes / 4) + 8 * pending.n;
    return {
      converted: 0, skipped: 0, errors: 0, total,
      bytesBefore: pending.bytes, bytesAfter: estimatedAfter,
      sizeBefore, sizeAfter: sizeBefore, vacuumed: false, dryRun: true,
    };
  }

  const update = db.prepare(
    `UPDATE embeddings SET vector = ?, format = ? WHERE observation_id = ?`
  );

  let converted = 0, errors = 0, bytesBefore = 0, bytesAfter = 0;

  // Rows that fail conversion keep format='f32', so a plain `WHERE format='f32'`
  // would hand them back on every iteration and inflate the error count. Track
  // and exclude them.
  const failedIds = new Set();
  const selectBatch = (take) => {
    if (failedIds.size === 0) {
      return db.prepare(
        `SELECT observation_id, vector FROM embeddings WHERE format = ? LIMIT ?`
      ).all(FORMAT_F32, take);
    }
    const placeholders = [...failedIds].map(() => '?').join(',');
    return db.prepare(
      `SELECT observation_id, vector FROM embeddings
       WHERE format = ? AND observation_id NOT IN (${placeholders}) LIMIT ?`
    ).all(FORMAT_F32, ...failedIds, take);
  };

  const convertBatch = db.transaction((rows) => {
    for (const row of rows) {
      try {
        const vec = decodeVector(row.vector, FORMAT_F32);
        if (vec.length === 0) { errors++; failedIds.add(row.observation_id); continue; }
        const blob = quantizeToI8(vec);
        update.run(blob, FORMAT_I8, row.observation_id);
        bytesBefore += row.vector.length;
        bytesAfter += blob.length;
        converted++;
      } catch {
        // A single malformed blob must not abort the run — it stays f32 and is
        // reported, so `claudeye reindex` can rebuild it later.
        errors++;
        failedIds.add(row.observation_id);
      }
    }
  });

  while (converted + errors < total) {
    const take = Math.min(batchSize, total - (converted + errors));
    // Rows that fail conversion keep format='f32' and would be re-selected
    // forever — so bail out if a whole batch made no progress.
    const before = converted;
    const rows = selectBatch(take);
    if (rows.length === 0) break;
    convertBatch(rows);
    if (converted === before) break;
    if (onProgress) onProgress({ done: converted, total, bytesBefore, bytesAfter });
  }

  let vacuumed = false;
  if (vacuum) {
    db.exec('VACUUM');
    vacuumed = true;
  }

  return {
    converted, skipped: 0, errors, total,
    bytesBefore, bytesAfter,
    sizeBefore, sizeAfter: dbSizeBytes(db),
    vacuumed, dryRun: false,
  };
}

function dbSizeBytes(db) {
  try {
    const pageCount = db.pragma('page_count', { simple: true });
    const pageSize = db.pragma('page_size', { simple: true });
    return pageCount * pageSize;
  } catch {
    return 0;
  }
}
