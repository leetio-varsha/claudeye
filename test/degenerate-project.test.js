/**
 * test/degenerate-project.test.js — #121
 *
 * isDegenerateProject() gates session registration for the live hooks so that
 * Claudeye's own Cowork scheduled/agent runs (which resolve `project` to '/' or
 * $TMPDIR) don't pile up observation-less junk sessions and produce a false
 * "sessions↑ / obs flat" host-import-lag signal.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isDegenerateProject } from '../src/db.js';

describe('isDegenerateProject (#121)', () => {
  it('treats filesystem root and blank/invalid as degenerate', () => {
    assert.equal(isDegenerateProject('/'), true);
    assert.equal(isDegenerateProject(''), true);
    assert.equal(isDegenerateProject('   '), true);
    assert.equal(isDegenerateProject(null), true);
    assert.equal(isDegenerateProject(undefined), true);
    assert.equal(isDegenerateProject(42), true);
  });

  it('treats OS temp dirs ($TMPDIR / /tmp) as degenerate', () => {
    // macOS $TMPDIR shapes observed in the live DB
    assert.equal(isDegenerateProject('/private/var/folders/1x/abc123/T'), true);
    assert.equal(isDegenerateProject('/var/folders/1x/abc123/T'), true);
    assert.equal(isDegenerateProject('/tmp'), true);
    assert.equal(isDegenerateProject('/tmp/whatever'), true);
  });

  it('accepts real user project roots', () => {
    assert.equal(isDegenerateProject('/Users/lord/Documents/Claude/Projects/Claudeye/claudeye'), false);
    assert.equal(isDegenerateProject('/home/dev/work/app'), false);
    assert.equal(isDegenerateProject('/opt/projects/x'), false);
    // a project that merely contains "var/folders" deeper in the path is fine
    assert.equal(isDegenerateProject('/Users/lord/var/folders-archive/proj'), false);
  });
});
