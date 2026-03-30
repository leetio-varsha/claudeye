/**
 * scripts/install-git-hooks.js — Install/uninstall Claudeye git post-commit hook
 *
 * Adds a post-commit hook to the current (or specified) git repo
 * that auto-imports new commits into mem.db.
 *
 * Non-destructive: if a post-commit hook already exists, appends to it.
 */

import { readFileSync, writeFileSync, existsSync, chmodSync } from 'fs';
import { join, resolve } from 'path';
import { execSync } from 'child_process';
import chalk from 'chalk';

const HOOK_SCRIPT_PATH = resolve(new URL('../hooks/git-post-commit.js', import.meta.url).pathname);

// Marker comments to identify our hook section
const MARKER_START = '# >>> claudeye post-commit hook';
const MARKER_END   = '# <<< claudeye post-commit hook';

/**
 * Get the .git/hooks directory for a repo path.
 */
function getHooksDir(repoPath) {
  try {
    // Support worktrees — git rev-parse --git-common-dir
    const gitDir = execSync('git rev-parse --git-dir', {
      cwd: repoPath,
      encoding: 'utf8',
    }).trim();
    return join(repoPath, gitDir, 'hooks');
  } catch {
    return null;
  }
}

/**
 * Install the post-commit hook in a git repo.
 */
export async function installGitHooks(repoPath) {
  const absPath = resolve(repoPath);
  const hooksDir = getHooksDir(absPath);

  if (!hooksDir) {
    console.log(chalk.red(`  ✗ ${absPath} is not a git repository`));
    return false;
  }

  const hookFile = join(hooksDir, 'post-commit');
  const hookBlock = [
    MARKER_START,
    `node "${HOOK_SCRIPT_PATH}" &`,
    MARKER_END,
  ].join('\n');

  if (existsSync(hookFile)) {
    const existing = readFileSync(hookFile, 'utf8');

    // Already installed?
    if (existing.includes(MARKER_START)) {
      console.log(chalk.yellow(`  ⚠ Claudeye hook already installed in ${absPath}`));
      return true;
    }

    // Append to existing hook
    writeFileSync(hookFile, existing.trimEnd() + '\n\n' + hookBlock + '\n');
    console.log(chalk.green(`  ✓ Appended Claudeye hook to existing post-commit in ${absPath}`));
  } else {
    // Create new hook
    writeFileSync(hookFile, '#!/bin/sh\n\n' + hookBlock + '\n');
    console.log(chalk.green(`  ✓ Created post-commit hook in ${absPath}`));
  }

  chmodSync(hookFile, '755');
  return true;
}

/**
 * Remove the Claudeye section from the post-commit hook.
 */
export async function uninstallGitHooks(repoPath) {
  const absPath = resolve(repoPath);
  const hooksDir = getHooksDir(absPath);

  if (!hooksDir) {
    console.log(chalk.red(`  ✗ ${absPath} is not a git repository`));
    return false;
  }

  const hookFile = join(hooksDir, 'post-commit');

  if (!existsSync(hookFile)) {
    console.log(chalk.yellow(`  ⚠ No post-commit hook found in ${absPath}`));
    return true;
  }

  const content = readFileSync(hookFile, 'utf8');

  if (!content.includes(MARKER_START)) {
    console.log(chalk.yellow(`  ⚠ Claudeye hook not found in ${absPath}`));
    return true;
  }

  // Remove our block
  const regex = new RegExp(
    `\\n?${MARKER_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${MARKER_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n?`,
    'g'
  );
  const cleaned = content.replace(regex, '\n').trim();

  // If only shebang left, remove the file
  if (cleaned === '#!/bin/sh' || cleaned === '#!/bin/bash' || !cleaned) {
    const { unlinkSync } = await import('fs');
    unlinkSync(hookFile);
    console.log(chalk.green(`  ✓ Removed post-commit hook from ${absPath}`));
  } else {
    writeFileSync(hookFile, cleaned + '\n');
    console.log(chalk.green(`  ✓ Removed Claudeye section from post-commit in ${absPath}`));
  }

  return true;
}
