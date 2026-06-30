/**
 * test/thresholds.test.js — #124
 *
 * The DB-size ALARM thresholds are the single source of truth shared by
 * `claudeye health` (cli.js) and the INFRA-1 invariant (invariants.js). They
 * must sit ABOVE the ~262 MB retention plateau (#116) so health stops crying
 * "run archive" every run, and the critical level must match the INFRA-1
 * ceiling (#119, 300 MB).
 *
 * Lightweight: no better-sqlite3, so this runs even where the native binding
 * fails to load (ERR_DLOPEN_FAILED in some sandboxes).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DB_SIZE_WARN_MB, DB_SIZE_CRIT_MB } from '../src/thresholds.js';

const PLATEAU_MB = 262; // #116 retention equilibrium (analyzer 06-18…06-30)

describe('DB-size alarm thresholds (#124)', () => {
  it('warn is below crit', () => {
    assert.ok(DB_SIZE_WARN_MB < DB_SIZE_CRIT_MB, 'warn must be below crit');
  });

  it('both alarms sit above the retention plateau (no false alarm at equilibrium)', () => {
    assert.ok(DB_SIZE_WARN_MB > PLATEAU_MB,
      `warn ${DB_SIZE_WARN_MB} must exceed plateau ${PLATEAU_MB}`);
    assert.ok(DB_SIZE_CRIT_MB > PLATEAU_MB,
      `crit ${DB_SIZE_CRIT_MB} must exceed plateau ${PLATEAU_MB}`);
  });

  it('crit matches the INFRA-1 invariant ceiling (300MB, #119)', () => {
    assert.equal(DB_SIZE_CRIT_MB, 300);
  });

  it('a DB at the known plateau triggers neither warn nor crit', () => {
    assert.ok(!(PLATEAU_MB > DB_SIZE_WARN_MB), 'plateau must not warn');
    assert.ok(!(PLATEAU_MB > DB_SIZE_CRIT_MB), 'plateau must not crit');
  });
});
