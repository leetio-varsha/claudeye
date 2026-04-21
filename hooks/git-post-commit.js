#!/usr/bin/env node
/**
 * hooks/git-post-commit.js — Git post-commit hook for Claudeye
 *
 * Automatically imports the latest commit into mem.db after each git commit.
 * Runs silently in the background — never blocks git workflow.
 *
 * Installed via: claudeye install-git-hooks
 * The actual .git/hooks/post-commit calls this script.
 */

import { appendFileSync } from 'fs';
import { join } from 'path';

const LOG_FILE = join(process.env.HOME || '/tmp', '.claudeye', 'post-commit.log');
const repoPath = process.cwd();
const ts = () => new Date().toISOString();

function log(msg) {
  try { appendFileSync(LOG_FILE, `${ts()} ${msg}\n`); } catch {}
}

log(`start repo=${repoPath} node=${process.execPath}`);

try {
  const { importGit } = await import('../src/import.js');
  const result = await importGit(repoPath, { limit: 1, skipAi: true });
  if (result.imported > 0) {
    log(`ok imported=${result.imported}`);
    if (process.env.CLAUDEYE_VERBOSE) {
      process.stderr.write(`[claudeye] Imported ${result.imported} commit\n`);
    }
  } else {
    log(`skip reason=${result.error || 'no new commits'}`);
  }
} catch (err) {
  log(`error ${err.message}`);
  // Never fail — don't break git workflow
}

process.exit(0);
