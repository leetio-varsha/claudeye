#!/usr/bin/env node
/**
 * hooks/git-post-commit.js — Git post-commit hook for Claudeye
 *
 * Automatically imports the latest commit into mem.db after each git commit.
 * Runs silently in the background — never blocks git workflow.
 *
 * Installed via: cmem install-git-hooks
 * The actual .git/hooks/post-commit calls this script.
 */

import { importGit } from '../src/import.js';

const repoPath = process.cwd();

try {
  const result = await importGit(repoPath, { limit: 1, skipAi: true });
  if (result.imported > 0) {
    // Silent success — don't pollute git output
    // Use stderr only in verbose mode
    if (process.env.CLAUDEYE_VERBOSE) {
      process.stderr.write(`[claudeye] Imported ${result.imported} commit\n`);
    }
  }
} catch {
  // Never fail — don't break git workflow
}

process.exit(0);
