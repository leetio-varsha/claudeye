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
import { readFileSync } from 'fs';
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

// ─── Value-parity guards ─────────────────────────────────────────────────────
// insights-standalone.js can't import src/thresholds.js (it's copied verbatim to
// ~/.claudeye and runs without the project tree), so its WARN value is a literal.
// daily-insights.js hardcoded 150 for months after #124 raised the alarm to 280 —
// the analyzer flagged the drift every run (06-18…07-05). Guard the literal so the
// standalone can't silently diverge from the single source of truth again.
describe('DB-size alarm value parity (#124 follow-up)', () => {
  it('insights-standalone.js mirrors thresholds.js WARN literal', () => {
    const text = readFileSync('scripts/insights-standalone.js', 'utf8');
    assert.ok(
      text.includes(`DB_SIZE_WARN_MB: ${DB_SIZE_WARN_MB}`),
      `insights-standalone.js must contain "DB_SIZE_WARN_MB: ${DB_SIZE_WARN_MB}" (src/thresholds.js) — update the literal`,
    );
  });

  it('daily-insights.js imports the alarm instead of hardcoding it', () => {
    const text = readFileSync('scripts/daily-insights.js', 'utf8');
    assert.ok(
      /import\s*\{[^}]*DB_SIZE_WARN_MB[^}]*\}\s*from\s*'\.\.\/src\/thresholds\.js'/.test(text),
      'daily-insights.js must import DB_SIZE_WARN_MB from ../src/thresholds.js',
    );
    assert.ok(
      !/DB_SIZE_WARN_MB:\s*\d/.test(text),
      'daily-insights.js must not re-hardcode DB_SIZE_WARN_MB',
    );
  });
});
