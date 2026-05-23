#!/usr/bin/env node
/**
 * scripts/agent-daemon-scheduler.js — Install/uninstall local agent daemon (#18)
 *
 * Creates a macOS LaunchAgent (com.claudeye.agent-daemon) that runs
 * agent-daemon-standalone.mjs every hour.
 *
 * Pattern: same as digest-scheduler.js and insights-scheduler.js.
 *   - Copies standalone script to ~/.claudeye/ (TCC-safe, avoids ~/Documents restriction)
 *   - Installs plist to ~/Library/LaunchAgents/
 *   - launchctl load/unload
 */

import { writeFileSync, unlinkSync, existsSync, mkdirSync, copyFileSync } from 'fs';
import { execSync } from 'child_process';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

const LABEL    = 'com.claudeye.agent-daemon';
const PLIST    = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const LOG_DIR  = join(homedir(), '.claudeye', 'logs');
const LOG_OUT  = join(LOG_DIR, 'daemon-stdout.log');
const LOG_ERR  = join(LOG_DIR, 'daemon-stderr.log');

/**
 * Install and start the agent daemon as a launchd LaunchAgent.
 * @param {object} [opts]
 * @param {number} [opts.intervalSeconds=3600]  — run interval (default: 1 hour)
 */
export function install({ intervalSeconds = 3600 } = {}) {
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });

  // Copy standalone script to ~/.claudeye/ (TCC-safe location)
  const standaloneSrc  = join(__dirname, 'agent-daemon-standalone.mjs');
  const standaloneDest = join(homedir(), '.claudeye', 'agent-daemon-standalone.mjs');

  if (!existsSync(standaloneSrc)) {
    throw new Error(`agent-daemon-standalone.mjs not found at ${standaloneSrc}`);
  }
  copyFileSync(standaloneSrc, standaloneDest);

  const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>${standaloneDest}</string>
  </array>

  <key>StartInterval</key>
  <integer>${intervalSeconds}</integer>

  <key>RunAtLoad</key>
  <false/>

  <key>StandardOutPath</key>
  <string>${LOG_OUT}</string>

  <key>StandardErrorPath</key>
  <string>${LOG_ERR}</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${homedir()}</string>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
`;

  writeFileSync(PLIST, plistContent, 'utf8');

  // Load the agent
  try {
    execSync(`launchctl load -w "${PLIST}"`, { stdio: 'pipe' });
  } catch {
    // May already be loaded — try unload+reload
    try { execSync(`launchctl unload "${PLIST}"`, { stdio: 'pipe' }); } catch {}
    execSync(`launchctl load -w "${PLIST}"`, { stdio: 'pipe' });
  }

  return { plist: PLIST, standalone: standaloneDest, intervalSeconds };
}

/**
 * Stop and uninstall the agent daemon.
 */
export function uninstall() {
  if (existsSync(PLIST)) {
    try { execSync(`launchctl unload -w "${PLIST}"`, { stdio: 'pipe' }); } catch {}
    unlinkSync(PLIST);
    return { removed: true, plist: PLIST };
  }
  return { removed: false, reason: 'plist not found' };
}

/**
 * Check launchd status of the agent daemon.
 * @returns {{ installed: boolean, loaded: boolean, plist: string }}
 */
export function status() {
  const installed = existsSync(PLIST);
  let loaded = false;
  if (installed) {
    try {
      const out = execSync(`launchctl list "${LABEL}" 2>/dev/null`, { encoding: 'utf8', stdio: 'pipe' });
      loaded = out.trim().length > 0 && !out.includes('Could not find');
    } catch {
      loaded = false;
    }
  }
  return { installed, loaded, plist: PLIST };
}

// ─── CLI (direct invocation) ──────────────────────────────────────────────────

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cmd = process.argv[2];
  if (cmd === 'install') {
    const result = install();
    console.log('✅ Agent daemon installed:', result);
  } else if (cmd === 'uninstall') {
    const result = uninstall();
    console.log('🛑 Agent daemon uninstalled:', result);
  } else if (cmd === 'status') {
    const result = status();
    console.log('ℹ️  Agent daemon status:', result);
  } else {
    console.log('Usage: node agent-daemon-scheduler.js [install|uninstall|status]');
  }
}
