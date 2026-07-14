/**
 * scripts/install-hooks.js — Safely patches ~/.claude/settings.json
 * to register the three hooks. Non-destructive: merges with existing config.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import chalk from 'chalk';

const CLAUDE_DIR      = join(homedir(), '.claude');
const SETTINGS_PATH   = join(CLAUDE_DIR, 'settings.json');
const HOOKS_DIR       = new URL('../hooks/', import.meta.url).pathname;

// Filenames of the three Claudeye hooks — used to recognise (and replace) our
// own entries when merging, without touching hooks from other plugins.
export const CLAUDEYE_HOOK_FILES = ['save-hook', 'inject-hook', 'summary-hook'];

/** True if a settings hook entry belongs to Claudeye (matches by hook filename). */
export function isClaudeyeHook(entry) {
  const cmds = (entry?.hooks || []).map(h => h.command || '');
  return cmds.some(c => CLAUDEYE_HOOK_FILES.some(f => c.includes(f)));
}

/**
 * True if a hook command is ABI-pinned (#127): it must invoke an *absolute*
 * node interpreter, never bare `node`, which resolves via PATH to whatever
 * node version happens to be active (e.g. fnm Node 25, ABI 141) and silently
 * fails to open the native better-sqlite3 binary built under a different ABI.
 */
export function isNodePinned(command) {
  // Absolute path (/opt/homebrew/bin/node) or quoted absolute path, then a space.
  return /^"?\//.test(command || '') && !/^"?node[\s"]/.test(command || '');
}

/**
 * Pure builder for the three Claudeye hook config blocks. Kept side-effect free
 * so the ABI-pin drift-guard (#127) can be unit-tested without touching $HOME.
 *
 * @param {object}  opts
 * @param {string}  opts.nodeBin      absolute path to the node interpreter
 * @param {string}  opts.hooksDir     directory containing the hook .js files
 */
export function buildHookEntries({ nodeBin, hooksDir }) {
  const cmd = (file) => `"${nodeBin}" "${join(hooksDir, file)}"`;
  return {
    PostToolUse: {
      matcher: '*',
      hooks: [{ type: 'command', command: cmd('save-hook.js'), timeout: 30 }],
    },
    UserPromptSubmit: {
      hooks: [{ type: 'command', command: cmd('inject-hook.js'), timeout: 15 }],
    },
    Stop: {
      hooks: [{ type: 'command', command: cmd('summary-hook.js'), timeout: 60 }],
    },
  };
}

export default async function installHooks() {
  console.log(chalk.bold('\n🔧 Installing Claude Code hooks...\n'));

  if (!existsSync(CLAUDE_DIR)) mkdirSync(CLAUDE_DIR, { recursive: true });

  let settings = {};
  if (existsSync(SETTINGS_PATH)) {
    try {
      settings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'));
    } catch {
      console.error(chalk.red('  ✗ Could not parse ~/.claude/settings.json — check for syntax errors'));
      process.exit(1);
    }
  }

  // ABI-pin (#127): hooks MUST run under the same node that built the native
  // better-sqlite3 binary. Bare `node` in settings.json resolves to whatever is
  // on the user's PATH and silently fails to open the DB when the binary was
  // built under a different node ABI, losing every observation with exit 0.
  // install-hooks runs via the claudeye CLI, which is itself pinned to the
  // homebrew node, so process.execPath is the correct ABI-matched interpreter.
  const entries = buildHookEntries({ nodeBin: process.execPath, hooksDir: HOOKS_DIR });

  // Merge hooks — don't overwrite existing hooks from other plugins
  settings.hooks = settings.hooks || {};

  for (const kind of ['PostToolUse', 'UserPromptSubmit', 'Stop']) {
    settings.hooks[kind] = [
      // Drop any prior Claudeye entry (e.g. an old bare-`node` install) and
      // keep hooks belonging to other plugins.
      ...(settings.hooks[kind] || []).filter(h => !isClaudeyeHook(h)),
      entries[kind],
    ];
  }

  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));

  console.log(chalk.green('  ✓ Hooks installed in ~/.claude/settings.json'));
  console.log(chalk.green(`  ✓ node pinned → ${process.execPath}`));
  console.log(chalk.green('  ✓ PostToolUse  → save-hook.js'));
  console.log(chalk.green('  ✓ UserPromptSubmit → inject-hook.js'));
  console.log(chalk.green('  ✓ Stop         → summary-hook.js'));
  console.log(chalk.bold('\n  Restart Claude Code for hooks to take effect.\n'));
}
