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

  const saveHook    = join(HOOKS_DIR, 'save-hook.js');
  const injectHook  = join(HOOKS_DIR, 'inject-hook.js');
  const summaryHook = join(HOOKS_DIR, 'summary-hook.js');

  // Merge hooks — don't overwrite existing hooks from other plugins
  settings.hooks = settings.hooks || {};

  // Check if any nested hook command matches our hook files
  const isClaudeyeHook = (entry) => {
    const cmds = (entry.hooks || []).map(h => h.command || '');
    return cmds.some(c => c.includes('save-hook') || c.includes('inject-hook') || c.includes('summary-hook'));
  };

  settings.hooks.PostToolUse = [
    // Keep any existing non-claudeye hooks
    ...(settings.hooks.PostToolUse || []).filter(h => !isClaudeyeHook(h)),
    {
      matcher: '*',
      hooks: [{ type: 'command', command: `node "${saveHook}"`, timeout: 30 }],
    },
  ];

  settings.hooks.UserPromptSubmit = [
    ...(settings.hooks.UserPromptSubmit || []).filter(h => !isClaudeyeHook(h)),
    {
      hooks: [{ type: 'command', command: `node "${injectHook}"`, timeout: 15 }],
    },
  ];

  settings.hooks.Stop = [
    ...(settings.hooks.Stop || []).filter(h => !isClaudeyeHook(h)),
    {
      hooks: [{ type: 'command', command: `node "${summaryHook}"`, timeout: 60 }],
    },
  ];

  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));

  console.log(chalk.green('  ✓ Hooks installed in ~/.claude/settings.json'));
  console.log(chalk.green('  ✓ PostToolUse  → save-hook.js'));
  console.log(chalk.green('  ✓ UserPromptSubmit → inject-hook.js'));
  console.log(chalk.green('  ✓ Stop         → summary-hook.js'));
  console.log(chalk.bold('\n  Restart Claude Code for hooks to take effect.\n'));
}
