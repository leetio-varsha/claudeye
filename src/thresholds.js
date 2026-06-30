/**
 * src/thresholds.js — single source of truth for DB-size *alarm* thresholds.
 *
 * #124 (follow-up #119). The working set sits on a ~262 MB plateau (#116
 * retention equilibrium, +0.02 MB/day). User-facing alarms must sit ABOVE that
 * plateau or they cry wolf every run — exactly the drift the analyzer flagged
 * for 13 straight runs (06-18…06-30): `claudeye health` printed
 * "🔴 >250MB — run claudeye archive" every prompt while the real ceiling was
 * 300 MB and growth was effectively zero. #119 already raised the hard INFRA-1
 * RED 150→300 for this reason; this collapses the health-display thresholds
 * onto the same reality so a single number governs every user-facing alarm.
 *
 * IMPORTANT — these are ALARMS, not maintenance triggers. The background
 * retention sweep (`db.js autoCleanup`, 150 MB) and auto-archive
 * (`agent-daemon.js`, 250 MB) triggers are deliberately LOWER: they keep the
 * plateau in equilibrium and run silently, so they are not user-facing and must
 * NOT be aligned to these constants. Changing those is a behavioral change;
 * changing these is only about when to alarm the user.
 *
 * This module intentionally has zero heavy dependencies (no better-sqlite3) so
 * both `cli.js` and `invariants.js` can import it without pulling the native
 * SQLite binding (which fails to load in some sandboxes).
 */

/** Advisory alarm: DB is approaching the hard ceiling. Above the ~262 MB plateau. */
export const DB_SIZE_WARN_MB = 280;

/** Hard ceiling alarm — matches the INFRA-1 invariant RED threshold (#119). */
export const DB_SIZE_CRIT_MB = 300;
