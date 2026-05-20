/**
 * test/graph.test.js — Knowledge Graph tests (#26)
 *
 * Tests entity extraction and relation building with in-memory SQLite.
 * Does NOT call getDb() — uses its own test DB to avoid touching real data.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  extractFileEntities,
  fileRelationType,
  upsertEntity,
  upsertRelation,
} from '../src/graph.js';

// ─── In-memory DB with graph schema ──────────────────────────────────────

function makeTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE observations (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  TEXT,
      project     TEXT NOT NULL,
      tool        TEXT NOT NULL,
      summary     TEXT NOT NULL,
      raw_input   TEXT,
      tags        TEXT NOT NULL DEFAULT '[]',
      importance  REAL NOT NULL DEFAULT 0.5,
      decision_rationale TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE entities (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      project     TEXT NOT NULL,
      type        TEXT NOT NULL,
      name        TEXT NOT NULL,
      metadata    TEXT NOT NULL DEFAULT '{}',
      first_seen  TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen   TEXT NOT NULL DEFAULT (datetime('now')),
      mention_count INTEGER NOT NULL DEFAULT 1
    );
    CREATE UNIQUE INDEX idx_entities_project_type_name ON entities(project, type, name);

    CREATE TABLE relations (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id     INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      target_id     INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      relation_type TEXT    NOT NULL,
      weight        REAL    NOT NULL DEFAULT 1.0,
      obs_id        INTEGER REFERENCES observations(id) ON DELETE SET NULL,
      created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX idx_relations_edge ON relations(source_id, target_id, relation_type);
  `);

  return db;
}

// ─── extractFileEntities ─────────────────────────────────────────────────

describe('extractFileEntities', () => {
  it('extracts JS file from summary', () => {
    const files = extractFileEntities('Fixed bug in src/compress.js line 42');
    assert.ok(files.includes('src/compress.js'), `got: ${JSON.stringify(files)}`);
  });

  it('extracts multiple files', () => {
    const files = extractFileEntities('Updated src/db.js and test/db.test.js');
    assert.equal(files.length, 2);
    assert.ok(files.some(f => f.endsWith('db.js')));
    assert.ok(files.some(f => f.endsWith('db.test.js')));
  });

  it('extracts file from raw_input', () => {
    const files = extractFileEntities('edited a file', '/Users/yuri/project/src/server.js');
    assert.ok(files.some(f => f.endsWith('server.js')));
  });

  it('ignores node_modules paths', () => {
    const files = extractFileEntities('required node_modules/lodash/index.js');
    assert.equal(files.length, 0);
  });

  it('returns empty array when no files', () => {
    const files = extractFileEntities('ran git status, everything clean');
    assert.deepEqual(files, []);
  });

  it('deduplicates same file mentioned twice', () => {
    const files = extractFileEntities('src/db.js updated — see src/db.js for details');
    const dbFiles = files.filter(f => f.endsWith('db.js'));
    assert.equal(dbFiles.length, 1);
  });

  it('handles yaml and sql extensions', () => {
    const files = extractFileEntities('ran migration scripts/migration.sql and config/app.yaml');
    assert.ok(files.some(f => f.endsWith('migration.sql')));
    assert.ok(files.some(f => f.endsWith('app.yaml')));
  });
});

// ─── fileRelationType ────────────────────────────────────────────────────

describe('fileRelationType', () => {
  it('returns fixed_by for bugfix tag', () => {
    assert.equal(fileRelationType(['bugfix', 'auth']), 'fixed_by');
  });

  it('returns fixed_by for fix tag', () => {
    assert.equal(fileRelationType(['fix']), 'fixed_by');
  });

  it('returns caused_by for error tag', () => {
    assert.equal(fileRelationType(['error', 'database']), 'caused_by');
  });

  it('returns decided_in for decision tag', () => {
    assert.equal(fileRelationType(['decision']), 'decided_in');
  });

  it('returns touched_in for routine tags', () => {
    assert.equal(fileRelationType(['read', 'config']), 'touched_in');
  });

  it('prioritises bugfix over error if both present', () => {
    assert.equal(fileRelationType(['error', 'bugfix']), 'fixed_by');
  });

  it('returns touched_in for empty array', () => {
    assert.equal(fileRelationType([]), 'touched_in');
  });
});

// ─── upsertEntity ─────────────────────────────────────────────────────────

describe('upsertEntity', () => {
  let db;
  before(() => { db = makeTestDb(); });
  after(() => { db.close(); });

  it('inserts new entity and returns id', () => {
    const id = upsertEntity(db, { project: '/proj/a', type: 'file', name: 'src/db.js' });
    assert.ok(typeof id === 'number' || typeof id === 'bigint');
    const row = db.prepare('SELECT * FROM entities WHERE id = ?').get(id);
    assert.equal(row.name, 'src/db.js');
    assert.equal(row.type, 'file');
    assert.equal(row.mention_count, 1);
  });

  it('increments mention_count on duplicate', () => {
    upsertEntity(db, { project: '/proj/a', type: 'file', name: 'src/index.js' });
    upsertEntity(db, { project: '/proj/a', type: 'file', name: 'src/index.js' });
    const row = db.prepare("SELECT * FROM entities WHERE name = 'src/index.js'").get();
    assert.equal(row.mention_count, 2);
  });

  it('treats same name in different projects as distinct', () => {
    const id1 = upsertEntity(db, { project: '/proj/a', type: 'tool', name: 'Bash' });
    const id2 = upsertEntity(db, { project: '/proj/b', type: 'tool', name: 'Bash' });
    assert.notEqual(id1, id2);
  });

  it('treats same name with different type as distinct', () => {
    const id1 = upsertEntity(db, { project: '/proj/a', type: 'file',    name: 'main' });
    const id2 = upsertEntity(db, { project: '/proj/a', type: 'project', name: 'main' });
    assert.notEqual(id1, id2);
  });
});

// ─── upsertRelation ──────────────────────────────────────────────────────

describe('upsertRelation', () => {
  let db;
  before(() => { db = makeTestDb(); });
  after(() => { db.close(); });

  it('inserts new relation and returns id', () => {
    const src = upsertEntity(db, { project: '/p', type: 'file',    name: 'a.js' });
    const tgt = upsertEntity(db, { project: '/p', type: 'project', name: 'p' });
    const rid = upsertRelation(db, { sourceId: src, targetId: tgt, relationType: 'belongs_to' });
    assert.ok(typeof rid === 'number' || typeof rid === 'bigint');
    const row = db.prepare('SELECT * FROM relations WHERE id = ?').get(rid);
    assert.equal(row.relation_type, 'belongs_to');
    assert.equal(Number(row.weight), 1.0);
  });

  it('bumps weight on duplicate edge', () => {
    const src = upsertEntity(db, { project: '/p', type: 'file', name: 'b.js' });
    const tgt = upsertEntity(db, { project: '/p', type: 'file', name: 'c.js' });
    upsertRelation(db, { sourceId: src, targetId: tgt, relationType: 'related_to' });
    upsertRelation(db, { sourceId: src, targetId: tgt, relationType: 'related_to' });
    const row = db.prepare("SELECT weight FROM relations WHERE source_id = ? AND target_id = ? AND relation_type = 'related_to'").get(src, tgt);
    assert.equal(Number(row.weight), 2.0);
  });

  it('treats different relation_type as different edge', () => {
    const src = upsertEntity(db, { project: '/p', type: 'file', name: 'd.js' });
    const tgt = upsertEntity(db, { project: '/p', type: 'file', name: 'e.js' });
    const r1 = upsertRelation(db, { sourceId: src, targetId: tgt, relationType: 'related_to' });
    const r2 = upsertRelation(db, { sourceId: src, targetId: tgt, relationType: 'fixed_by' });
    assert.notEqual(r1, r2);
  });
});
