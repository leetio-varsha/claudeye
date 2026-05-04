/**
 * test/_template-regression.test.js — Skeleton for regression tests (#100).
 *
 * Copy this file to `test/issue-N.test.js` when fixing a bug from issue #N.
 * The test MUST fail on the bug's baseline behavior — that's the point.
 *
 * Convention:
 *   1. Name file `issue-<number>.test.js` or `regression-<topic>.test.js`.
 *   2. Reference the issue URL in the JSDoc block.
 *   3. Each `it(...)` describes the *symptom* in plain language.
 *   4. Setup constructs the minimal state that reproduces the bug.
 *   5. Assertion verifies the *fixed* behavior — running this test against
 *      the pre-fix codebase should fail with a clear message.
 *
 * Replace this file's content; do not delete it. The template stays.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('issue #N — short title', () => {
  it('symptom: …', () => {
    // Arrange — minimal state that reproduces the bug
    // Act — call the function under test
    // Assert — verify fixed behavior; pre-fix code should fail this
    assert.ok(true, 'replace with real assertion');
  });
});
