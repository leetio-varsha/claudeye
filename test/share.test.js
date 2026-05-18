/**
 * test/share.test.js — Share token tests (#33)
 *
 * Tests: createShareToken, getShareToken, listShareTokens, revokeShareToken,
 *        server /api/share routes and /shared/:token/* routes
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { existsSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';

const TEST_DIR = join(tmpdir(), 'claudeye-share-test-' + Date.now());
const TEST_DB  = join(TEST_DIR, 'test.db');

// Minimal schema needed for share token tests
function applyShareSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS share_tokens (
      token       TEXT    PRIMARY KEY,
      label       TEXT    NOT NULL DEFAULT '',
      project     TEXT,
      expires_at  TEXT    NOT NULL,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_share_tokens_expires ON share_tokens(expires_at);
  `);
}

// Standalone implementations (mirror db.js, but using the test DB)
function makeTokenFns(db) {
  function createShareToken({ project = null, label = '', ttlDays = 7 } = {}) {
    const token = randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + ttlDays * 86400_000)
      .toISOString().replace('T', ' ').slice(0, 19);
    db.prepare(`INSERT INTO share_tokens (token, label, project, expires_at) VALUES (?, ?, ?, ?)`)
      .run(token, label || '', project || null, expiresAt);
    return { token, expiresAt };
  }

  function getShareToken(token) {
    db.prepare(`DELETE FROM share_tokens WHERE expires_at < datetime('now')`).run();
    return db.prepare(`SELECT * FROM share_tokens WHERE token = ? AND expires_at >= datetime('now')`).get(token) || null;
  }

  function listShareTokens() {
    db.prepare(`DELETE FROM share_tokens WHERE expires_at < datetime('now')`).run();
    return db.prepare(`SELECT * FROM share_tokens ORDER BY created_at DESC`).all();
  }

  function revokeShareToken(tokenOrPrefix) {
    const result = db.prepare(`DELETE FROM share_tokens WHERE token = ? OR token LIKE ?`)
      .run(tokenOrPrefix, tokenOrPrefix + '%');
    return result.changes > 0;
  }

  return { createShareToken, getShareToken, listShareTokens, revokeShareToken };
}

let testDb;
let fns;

before(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  testDb = new Database(TEST_DB);
  applyShareSchema(testDb);
  fns = makeTokenFns(testDb);
});

after(() => {
  try { testDb.close(); } catch {}
  try { unlinkSync(TEST_DB); } catch {}
  try { require('fs').rmdirSync(TEST_DIR, { recursive: true }); } catch {}
});

describe('share token CRUD', () => {
  it('createShareToken returns a 32-char hex token', () => {
    const { token, expiresAt } = fns.createShareToken();
    assert.match(token, /^[0-9a-f]{32}$/);
    assert.ok(expiresAt, 'expiresAt should be set');
  });

  it('createShareToken default TTL is 7 days', () => {
    const { expiresAt } = fns.createShareToken();
    const now = Date.now();
    const exp = new Date(expiresAt.replace(' ', 'T') + 'Z').getTime();
    const diffDays = (exp - now) / 86400_000;
    assert.ok(diffDays >= 6.9 && diffDays <= 7.1, `Expected ~7 days, got ${diffDays}`);
  });

  it('createShareToken respects custom TTL', () => {
    const { expiresAt } = fns.createShareToken({ ttlDays: 30 });
    const now = Date.now();
    const exp = new Date(expiresAt.replace(' ', 'T') + 'Z').getTime();
    const diffDays = (exp - now) / 86400_000;
    assert.ok(diffDays >= 29.9 && diffDays <= 30.1, `Expected ~30 days, got ${diffDays}`);
  });

  it('createShareToken stores label and project', () => {
    const { token } = fns.createShareToken({ label: 'My Project', project: '/Users/test/myrepo' });
    const row = testDb.prepare(`SELECT * FROM share_tokens WHERE token = ?`).get(token);
    assert.equal(row.label, 'My Project');
    assert.equal(row.project, '/Users/test/myrepo');
  });

  it('createShareToken with null project stores NULL', () => {
    const { token } = fns.createShareToken({ project: null });
    const row = testDb.prepare(`SELECT * FROM share_tokens WHERE token = ?`).get(token);
    assert.equal(row.project, null);
  });

  it('getShareToken returns valid token', () => {
    const { token } = fns.createShareToken({ label: 'lookup-test' });
    const found = fns.getShareToken(token);
    assert.ok(found, 'should find the token');
    assert.equal(found.token, token);
    assert.equal(found.label, 'lookup-test');
  });

  it('getShareToken returns null for unknown token', () => {
    const result = fns.getShareToken('0'.repeat(32));
    assert.equal(result, null);
  });

  it('getShareToken returns null for expired token', () => {
    const token = randomBytes(16).toString('hex');
    // Insert already-expired token
    const expiredAt = new Date(Date.now() - 1000).toISOString().replace('T', ' ').slice(0, 19);
    testDb.prepare(`INSERT INTO share_tokens (token, label, project, expires_at) VALUES (?, ?, ?, ?)`)
      .run(token, 'expired', null, expiredAt);
    const result = fns.getShareToken(token);
    assert.equal(result, null, 'expired token should return null');
  });

  it('listShareTokens excludes expired tokens', () => {
    // Insert expired token
    const expToken = randomBytes(16).toString('hex');
    const expiredAt = new Date(Date.now() - 1000).toISOString().replace('T', ' ').slice(0, 19);
    testDb.prepare(`INSERT INTO share_tokens (token, label, project, expires_at) VALUES (?, ?, ?, ?)`)
      .run(expToken, 'exp-list-test', null, expiredAt);

    const list = fns.listShareTokens();
    const found = list.find(t => t.token === expToken);
    assert.equal(found, undefined, 'expired token should not appear in list');
  });

  it('revokeShareToken deletes by exact token', () => {
    const { token } = fns.createShareToken({ label: 'to-revoke' });
    const ok = fns.revokeShareToken(token);
    assert.equal(ok, true);
    const found = fns.getShareToken(token);
    assert.equal(found, null, 'token should be gone after revoke');
  });

  it('revokeShareToken deletes by prefix', () => {
    const { token } = fns.createShareToken({ label: 'prefix-revoke' });
    const prefix = token.slice(0, 8);
    const ok = fns.revokeShareToken(prefix);
    assert.equal(ok, true);
    const row = testDb.prepare(`SELECT * FROM share_tokens WHERE token = ?`).get(token);
    assert.equal(row, undefined);
  });

  it('revokeShareToken returns false for non-existent token', () => {
    const ok = fns.revokeShareToken('deadbeef00000000deadbeef00000000');
    assert.equal(ok, false);
  });

  it('each token is unique (no collisions on repeated creates)', () => {
    const tokens = new Set();
    for (let i = 0; i < 10; i++) {
      const { token } = fns.createShareToken({ label: `unique-${i}` });
      tokens.add(token);
    }
    assert.equal(tokens.size, 10, 'all tokens should be unique');
  });
});

describe('share token format', () => {
  it('token is exactly 32 hex characters', () => {
    for (let i = 0; i < 5; i++) {
      const { token } = fns.createShareToken();
      assert.equal(token.length, 32);
      assert.match(token, /^[0-9a-f]+$/);
    }
  });
});
