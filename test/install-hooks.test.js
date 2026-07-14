/**
 * test/install-hooks.test.js — ABI-pin drift-guard (#127)
 *
 * The 2026-07-08 incident: live hooks were dead for 27 days because
 * ~/.claude/settings.json invoked bare `node`, which resolved to a node whose
 * ABI did not match the compiled better-sqlite3 binary — every observation was
 * silently dropped with exit 0. The manual settings.json patch fixed the live
 * hooks, but install-hooks.js still emitted bare `node`, so any reinstall
 * reverted the pin. This suite guards the builder so the drift can't recur.
 *
 * Pure functions only (no DB, no $HOME writes) → runs anywhere.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildHookEntries,
  isClaudeyeHook,
  isNodePinned,
} from '../scripts/install-hooks.js';

const NODE = '/opt/homebrew/bin/node';
const HOOKS = '/Users/x/claudeye/hooks';

// ─── buildHookEntries ────────────────────────────────────────────────────────

test('buildHookEntries: covers all three hook kinds', () => {
  const e = buildHookEntries({ nodeBin: NODE, hooksDir: HOOKS });
  assert.deepEqual(Object.keys(e).sort(), ['PostToolUse', 'Stop', 'UserPromptSubmit']);
});

test('buildHookEntries: every command is ABI-pinned to the absolute node, never bare `node`', () => {
  const e = buildHookEntries({ nodeBin: NODE, hooksDir: HOOKS });
  for (const kind of Object.keys(e)) {
    for (const h of e[kind].hooks) {
      assert.ok(h.command.startsWith(`"${NODE}"`), `${kind} pinned to abs node: ${h.command}`);
      assert.ok(isNodePinned(h.command), `${kind} passes pin guard: ${h.command}`);
      assert.doesNotMatch(h.command, /^node[\s"]/, `${kind} is not bare node`);
    }
  }
});

test('buildHookEntries: each hook points at its own hook file with a timeout', () => {
  const e = buildHookEntries({ nodeBin: NODE, hooksDir: HOOKS });
  assert.match(e.PostToolUse.hooks[0].command, /save-hook\.js/);
  assert.equal(e.PostToolUse.matcher, '*');
  assert.match(e.UserPromptSubmit.hooks[0].command, /inject-hook\.js/);
  assert.match(e.Stop.hooks[0].command, /summary-hook\.js/);
  for (const kind of Object.keys(e)) {
    assert.equal(typeof e[kind].hooks[0].timeout, 'number');
  }
});

// ─── isNodePinned (drift-guard predicate) ────────────────────────────────────

test('isNodePinned: rejects bare node, accepts absolute paths', () => {
  assert.equal(isNodePinned('node "/x/save-hook.js"'), false);
  assert.equal(isNodePinned('"node" "/x/save-hook.js"'), false);
  assert.equal(isNodePinned('"/opt/homebrew/bin/node" "/x/save-hook.js"'), true);
  assert.equal(isNodePinned('/usr/local/bin/node /x/inject-hook.js'), true);
});

// ─── isClaudeyeHook (merge filter) ───────────────────────────────────────────

test('isClaudeyeHook: recognises our hooks and ignores foreign ones', () => {
  const ours = buildHookEntries({ nodeBin: NODE, hooksDir: HOOKS }).PostToolUse;
  assert.equal(isClaudeyeHook(ours), true);
  const foreign = { hooks: [{ command: '"/opt/homebrew/bin/node" "/other/plugin.js"' }] };
  assert.equal(isClaudeyeHook(foreign), false);
  assert.equal(isClaudeyeHook({}), false);
});
