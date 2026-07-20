/**
 * quantize-migrate.test.js — batch float32 → int8 migration (#138)
 *
 * Exercises the migration against a real SQLite DB: mixed-format corpora,
 * idempotency, actual byte savings, and the format-aware SQL that reindex
 * depends on.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { existsSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { quantizeExistingEmbeddings } from '../src/quantize-migrate.js';
import {
  quantizeToI8, decodeVector, vectorDimsSql,
  FORMAT_F32, FORMAT_I8, Q8_HEADER_BYTES,
} from '../src/quantize.js';
import { cosineSimilarity } from '../src/embeddings.js';

const TEST_DIR = join(tmpdir(), 'claudeye-quantize-test-' + Date.now());
const TEST_DB = join(TEST_DIR, 'test.db');
const DIMS = 1536;

let db;

function seededVector(seed) {
  const v = new Float32Array(DIMS);
  let s = seed;
  let norm = 0;
  for (let i = 0; i < DIMS; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    v[i] = (s / 0x7fffffff) * 2 - 1;
    norm += v[i] * v[i];
  }
  norm = Math.sqrt(norm);
  for (let i = 0; i < DIMS; i++) v[i] /= norm;
  return v;
}

function float32Blob(vec) {
  const buf = Buffer.allocUnsafe(vec.length * 4);
  for (let i = 0; i < vec.length; i++) buf.writeFloatLE(vec[i], i * 4);
  return buf;
}

before(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

after(() => {
  try { db?.close(); } catch { /* already closed */ }
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  try { db?.close(); } catch { /* first run */ }
  if (existsSync(TEST_DB)) rmSync(TEST_DB, { force: true });

  db = new Database(TEST_DB);
  db.exec(`
    CREATE TABLE embeddings (
      observation_id INTEGER PRIMARY KEY,
      vector         BLOB    NOT NULL,
      model          TEXT    NOT NULL DEFAULT 'text-embedding-3-small',
      format         TEXT    NOT NULL DEFAULT 'f32',
      created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
    );
  `);
});

function seed(count, { format = FORMAT_F32 } = {}) {
  const insert = db.prepare(
    `INSERT INTO embeddings (observation_id, vector, format) VALUES (?, ?, ?)`
  );
  const vectors = [];
  for (let i = 0; i < count; i++) {
    const vec = seededVector(i + 1);
    vectors.push(vec);
    const blob = format === FORMAT_I8 ? quantizeToI8(vec) : float32Blob(vec);
    insert.run(i + 1, blob, format);
  }
  return vectors;
}

// ─── Migration ─────────────────────────────────────────────────────────────

describe('quantize-migrate: conversion', () => {
  it('converts every float32 row and shrinks blobs ~4x', () => {
    seed(50);
    const r = quantizeExistingEmbeddings({ db, batchSize: 10 });

    assert.equal(r.converted, 50);
    assert.equal(r.errors, 0);
    assert.equal(r.total, 50);

    const ratio = r.bytesBefore / r.bytesAfter;
    assert.ok(ratio > 3.9, `expected >3.9x blob shrink, got ${ratio.toFixed(2)}x`);

    const remaining = db.prepare(
      `SELECT COUNT(*) as n FROM embeddings WHERE format = ?`
    ).get(FORMAT_F32).n;
    assert.equal(remaining, 0, 'no float32 rows should remain');
  });

  it('preserves vector direction through the DB round-trip', () => {
    const originals = seed(20);
    quantizeExistingEmbeddings({ db });

    const rows = db.prepare(
      `SELECT observation_id, vector, format FROM embeddings ORDER BY observation_id`
    ).all();

    assert.equal(rows.length, 20);
    for (const row of rows) {
      assert.equal(row.format, FORMAT_I8);
      const decoded = decodeVector(row.vector, row.format);
      const original = originals[row.observation_id - 1];
      assert.equal(decoded.length, DIMS);
      assert.ok(
        cosineSimilarity(decoded, original) > 0.995,
        `obs ${row.observation_id} drifted too far after migration`
      );
    }
  });

  it('is idempotent — a second run is a no-op', () => {
    seed(30);
    const first = quantizeExistingEmbeddings({ db });
    assert.equal(first.converted, 30);

    const second = quantizeExistingEmbeddings({ db });
    assert.equal(second.converted, 0);
    assert.equal(second.total, 0);
  });

  it('leaves already-quantized rows untouched in a mixed corpus', () => {
    seed(10);                          // f32, ids 1..10
    // add pre-quantized rows
    const insert = db.prepare(
      `INSERT INTO embeddings (observation_id, vector, format) VALUES (?, ?, ?)`
    );
    for (let i = 11; i <= 20; i++) insert.run(i, quantizeToI8(seededVector(i)), FORMAT_I8);

    const before = db.prepare(
      `SELECT observation_id, vector FROM embeddings WHERE format = 'i8' ORDER BY observation_id`
    ).all();

    const r = quantizeExistingEmbeddings({ db });
    assert.equal(r.converted, 10, 'only the float32 rows should be converted');

    const after = db.prepare(
      `SELECT observation_id, vector FROM embeddings WHERE observation_id > 10 ORDER BY observation_id`
    ).all();
    assert.deepEqual(after, before, 'pre-existing i8 rows must be byte-identical');
  });

  it('honours --limit for incremental runs', () => {
    seed(40);
    const r = quantizeExistingEmbeddings({ db, limit: 15, batchSize: 10 });

    assert.equal(r.converted, 15);
    const left = db.prepare(
      `SELECT COUNT(*) as n FROM embeddings WHERE format = ?`
    ).get(FORMAT_F32).n;
    assert.equal(left, 25, 'a partial migration must leave the rest as float32');
  });

  it('a partially-migrated DB is still fully readable', () => {
    const originals = seed(20);
    quantizeExistingEmbeddings({ db, limit: 8 });

    const rows = db.prepare(
      `SELECT observation_id, vector, format FROM embeddings ORDER BY observation_id`
    ).all();

    const formats = new Set(rows.map(r => r.format));
    assert.equal(formats.size, 2, 'this test needs a genuinely mixed corpus');

    for (const row of rows) {
      const decoded = decodeVector(row.vector, row.format);
      assert.equal(decoded.length, DIMS);
      assert.ok(cosineSimilarity(decoded, originals[row.observation_id - 1]) > 0.995);
    }
  });
});

// ─── Dry run ───────────────────────────────────────────────────────────────

describe('quantize-migrate: dry run', () => {
  it('writes nothing but estimates the saving', () => {
    seed(25);
    const r = quantizeExistingEmbeddings({ db, dryRun: true });

    assert.equal(r.dryRun, true);
    assert.equal(r.converted, 0);
    assert.equal(r.total, 25);
    assert.ok(r.bytesAfter < r.bytesBefore / 3.9);

    const untouched = db.prepare(
      `SELECT COUNT(*) as n FROM embeddings WHERE format = ?`
    ).get(FORMAT_F32).n;
    assert.equal(untouched, 25, 'dry run must not modify any row');
  });

  it('estimate lands within 1% of the real result', () => {
    seed(25);
    const estimate = quantizeExistingEmbeddings({ db, dryRun: true });
    const actual = quantizeExistingEmbeddings({ db });

    const delta = Math.abs(estimate.bytesAfter - actual.bytesAfter) / actual.bytesAfter;
    assert.ok(delta < 0.01, `dry-run estimate off by ${(delta * 100).toFixed(2)}%`);
  });

  it('reports nothing to do on an empty table', () => {
    const r = quantizeExistingEmbeddings({ db });
    assert.equal(r.total, 0);
    assert.equal(r.converted, 0);
  });
});

// ─── Robustness ────────────────────────────────────────────────────────────

describe('quantize-migrate: robustness', () => {
  it('skips a malformed blob instead of aborting the run', () => {
    seed(10);
    // Zero-length vector → decodeVector yields an empty array
    db.prepare(`UPDATE embeddings SET vector = ? WHERE observation_id = 5`)
      .run(Buffer.alloc(0));

    const r = quantizeExistingEmbeddings({ db, batchSize: 3 });

    assert.equal(r.errors, 1);
    assert.equal(r.converted, 9, 'the other 9 rows must still convert');

    const stuck = db.prepare(
      `SELECT format FROM embeddings WHERE observation_id = 5`
    ).get().format;
    assert.equal(stuck, FORMAT_F32, 'unconvertible row stays float32 for reindex to rebuild');
  });

  it('terminates on a corpus where every row fails', () => {
    seed(5);
    db.prepare(`UPDATE embeddings SET vector = ?`).run(Buffer.alloc(0));

    // Guards against the infinite loop that a naive `WHERE format='f32'`
    // re-select would cause when no row can make progress.
    const r = quantizeExistingEmbeddings({ db, batchSize: 2 });
    assert.equal(r.converted, 0);
    assert.ok(r.errors > 0);
  });

  it('reclaims file size after VACUUM', () => {
    seed(400);
    const r = quantizeExistingEmbeddings({ db, vacuum: true });

    assert.equal(r.vacuumed, true);
    assert.ok(
      r.sizeAfter < r.sizeBefore,
      `expected the file to shrink, got ${r.sizeBefore} → ${r.sizeAfter}`
    );
  });
});

// ─── Format-aware SQL (what reindex relies on) ─────────────────────────────

describe('quantize-migrate: vectorDimsSql against a real DB', () => {
  it('reports 1536 dims for both formats', () => {
    seed(5);
    const insert = db.prepare(
      `INSERT INTO embeddings (observation_id, vector, format) VALUES (?, ?, ?)`
    );
    for (let i = 100; i < 105; i++) insert.run(i, quantizeToI8(seededVector(i)), FORMAT_I8);

    const rows = db.prepare(
      `SELECT ${vectorDimsSql('e')} as dims, COUNT(*) as n FROM embeddings e GROUP BY dims`
    ).all();

    assert.equal(rows.length, 1, `expected a single dimension bucket, got ${JSON.stringify(rows)}`);
    assert.equal(rows[0].dims, DIMS);
    assert.equal(rows[0].n, 10);
  });

  it('does not flag quantized vectors as degraded', () => {
    seed(10);
    quantizeExistingEmbeddings({ db });

    // This is the exact predicate src/reindex.js uses to find work.
    const degraded = db.prepare(
      `SELECT COUNT(*) as n FROM embeddings e WHERE ${vectorDimsSql('e')} != ${DIMS}`
    ).get().n;

    assert.equal(degraded, 0, 'quantized rows must not be queued for re-embedding');
  });

  it('still detects genuinely degraded 128-dim fallback vectors', () => {
    seed(3);
    const fallback = new Float32Array(128).fill(0.1);
    db.prepare(`INSERT INTO embeddings (observation_id, vector, format) VALUES (?, ?, ?)`)
      .run(99, float32Blob(fallback), FORMAT_F32);
    db.prepare(`INSERT INTO embeddings (observation_id, vector, format) VALUES (?, ?, ?)`)
      .run(98, quantizeToI8(fallback), FORMAT_I8);

    const degraded = db.prepare(
      `SELECT observation_id FROM embeddings e WHERE ${vectorDimsSql('e')} != ${DIMS} ORDER BY observation_id`
    ).all().map(r => r.observation_id);

    assert.deepEqual(degraded, [98, 99], 'both f32 and i8 fallback vectors must be flagged');
  });

  it('int8 blob length is dims + header', () => {
    seed(1);
    quantizeExistingEmbeddings({ db });
    const len = db.prepare(`SELECT length(vector) as n FROM embeddings`).get().n;
    assert.equal(len, DIMS + Q8_HEADER_BYTES);
  });
});
