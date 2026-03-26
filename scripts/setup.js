/**
 * scripts/setup.js — Interactive first-time setup
 */

import { createInterface } from 'readline';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import chalk from 'chalk';

const DATA_DIR     = join(homedir(), '.claudeye');
const SETTINGS_PATH = join(DATA_DIR, 'settings.json');

function prompt(rl, question) {
  return new Promise(res => rl.question(question, res));
}

export default async function setup() {
  console.log(chalk.bold('\n🧠 Claude Mem — Setup\n'));

  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

  const existing = existsSync(SETTINGS_PATH)
    ? JSON.parse(require('fs').readFileSync(SETTINGS_PATH, 'utf8'))
    : {};

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  console.log(chalk.gray('  You need an Anthropic API key for AI compression.'));
  console.log(chalk.gray('  An OpenAI key is optional but improves embedding quality.\n'));

  const anthropicKey = await prompt(rl,
    `  Anthropic API key${existing.anthropicApiKey ? ' (leave blank to keep current)' : ''}: `
  );

  const openaiKey = await prompt(rl,
    `  OpenAI API key (optional, for embeddings)${existing.openaiApiKey ? ' (leave blank to keep current)' : ''}: `
  );

  rl.close();

  const settings = {
    ...existing,
    ...(anthropicKey.trim() ? { anthropicApiKey: anthropicKey.trim() } : {}),
    ...(openaiKey.trim()    ? { openaiApiKey:    openaiKey.trim()    } : {}),
  };

  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), { mode: 0o600 });

  console.log(chalk.green('\n  ✓ Settings saved to ~/.claudeye/settings.json (mode 600)\n'));
  console.log(chalk.bold('  Next steps:'));
  console.log(chalk.gray('    1. Run: cmem install-hooks'));
  console.log(chalk.gray('    2. Restart Claude Code\n'));
}
