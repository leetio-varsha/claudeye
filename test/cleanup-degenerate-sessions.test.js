/**
 * test/cleanup-degenerate-sessions.test.js — #122
 *
 * cleanupDegenerateSessions() sweeps the ~1,900 observation-less junk sessions
 * (project '/', blank, or $TMPDIR/tmp) that accumulated BEFORE the #121 live-hook
 * guard landed. It must:
 *   - delete only observation-less sessions whose project is degenerate,
 *   - never touch sessions that HAVE observations,
 *   - never touch real-project sessions,
 *   - never touch the import-/cowork- id namespaces (handled by other cleanups),
 *   - default to dry-run (count + examples, no delete).
 *
 * HOME is overridden before importing db.js so getDb() resolves to a tmp dir
 * (same pattern as project-registry / agent-daemon tests).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const TEST_DIR  = join(tmpdir(), 'claudeye-degen-cleanup-test-' + Date.now());
const ORIG_HOME = process.env.HOME;

mkdirSync(TEST_DIR, { recursive: true });
process.env.HOME = TEST_DIR;

const { getDb, cleanupDegenerateSessions } = await import('../src/db.js');

function seed() {
  const db = getDb();
  // Wipe any prior rows so the test is deterministic.
  db.exec('DELETE FROM observations; DELETE FROM sessions;');

  const addSession = db.prepare('INSERT INTO sessions (id, project) VALUES (?, ?)');
  const addObs = db.prepare(
    `INSERT INTO observations (session_id, project, tool, summary) VALUES (?, ?, ?, ?)`
  );

  // --- should be deleted: empty + degenerate project ---
  addSession.run('uuid-junk-root', '/');
  addSession.run('uuid-junk-tmpdir', '/private/var/folders/1x/abc/T');
  addSession.run('uuid-junk-tmp', '/tmp/whatever');
  addSession.run('uuid-junk-blank', '   ');

  // --- should survive: degenerate project BUT has observations ---
  addSession.run('uuid-degen-but-active', '/');
  addObs.run('uuid-degen-but-active', '/', 'Bash', 'did a thing');

  // --- should survive: real project, empty ---
  addSession.run('uuid-real-empty', '/Users/lord/Documents/Claude/Projects/Claudeye/claudeye');

  // --- should survive: degenerate but protected id namespaces ---
  addSession.run('import-git-xyz', '/');
  addSession.run('cowork-abc', '/tmp');

  return db;
}

describe('cleanupDegenerateSessions (#122)', () => {
  before(seed);
  after(() => {
    try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* noop */ }
    if (ORIG_HOME === undefined) delete process.env.HOME;
    else process.env.HOME = ORIG_HOME;
  });

  it('dry-run reports the 4 empty degenerate sessions and deletes nothing', () => {
    const db = getDb();
    const before = db.prepare('SELECT COUNT(*) n FROM sessions').get().n;

    const res = cleanupDegenerateSessions({ dryRun: true });
    assert.equal(res.sessions, 4, 'should count exactly the 4 empty degenerate junk sessions');
    assert.ok(Array.isArray(res.examples) && res.examples.length > 0, 'provides example rows');

    const after = db.prepare('SELECT COUNT(*) n FROM sessions').get().n;
    assert.equal(after, before, 'dry-run must not delete any rows');
  });

  it('real run deletes only the empty degenerate junk sessions', () => {
    const db = getDb();
    const res = cleanupDegenerateSessions({ dryRun: false });
    assert.equal(res.sessions, 4, 'deletes exactly the 4 junk sessions');

    const remaining = db.prepare('SELECT id FROM sessions ORDER BY id').all().map(r => r.id);
    assert.deepEqual(
      remaining,
      ['cowork-abc', 'import-git-xyz', 'uuid-degen-but-active', 'uuid-real-empty'],
      'survivors: active-degenerate, real-empty, and protected import-/cowork- ids',
    );

    // The session that had an observation must still own it.
    const obs = db.prepare('SELECT COUNT(*) n FROM observations WHERE session_id = ?')
      .get('uuid-degen-but-active').n;
    assert.equal(obs, 1, 'observation under the surviving session is untouched');
  });

  it('is idempotent — a second run finds nothing to delete', () => {
    const res = cleanupDegenerateSessions({ dryRun: false });
    assert.equal(res.sessions, 0, 'no junk left after the first sweep');
  });
});
