#!/usr/bin/env node
/**
 * scripts/digest-scheduler.js — Install/uninstall weekly digest launchd agent
 *
 * Creates a macOS LaunchAgent that runs `claudeye digest --generate` weekly
 * (every Sunday at 20:00) and sends a macOS notification when done.
 */

import { writeFileSync, unlinkSync, existsSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { homedir } from 'os';
import { join } from 'path';

const LABEL    = 'com.claudeye.weekly-digest';
const PLIST    = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const LOG_DIR  = join(homedir(), '.claudeye', 'logs');
const LOG_OUT  = join(LOG_DIR, 'digest-stdout.log');
const LOG_ERR  = join(LOG_DIR, 'digest-stderr.log');

/**
 * Find the absolute path to the `claudeye` CLI binary.
 */
function findClaudeyeBin() {
  try {
    return execSync('which claudeye', { encoding: 'utf8' }).trim();
  } catch {
    // Fallback: npm global or local link
    const local = join(homedir(), '.npm-global', 'bin', 'claudeye');
    if (existsSync(local)) return local;
    throw new Error('claudeye CLI not found in PATH. Run: npm link');
  }
}

export function install() {
  const bin = findClaudeyeBin();

  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });

  // Wrapper script: run digest + send macOS notification
  const wrapperPath = join(homedir(), '.claudeye', 'digest-runner.sh');
  const wrapper = `#!/bin/bash
${bin} digest --generate 2>>${LOG_ERR}
if [ $? -eq 0 ]; then
  osascript -e 'display notification "Weekly digest generated. Run: claudeye digest" with title "Claudeye"'
else
  osascript -e 'display notification "Digest generation failed. Check logs." with title "Claudeye" subtitle "Error"'
fi
`;
  writeFileSync(wrapperPath, wrapper, { mode: 0o755 });

  // LaunchAgent plist — runs every Sunday at 20:00
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${wrapperPath}</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Weekday</key>
    <integer>0</integer>
    <key>Hour</key>
    <integer>20</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${LOG_OUT}</string>
  <key>StandardErrorPath</key>
  <string>${LOG_ERR}</string>
  <key>RunAtLoad</key>
  <false/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin:${join(homedir(), '.npm-global', 'bin')}</string>
  </dict>
</dict>
</plist>
`;

  // Unload first if already loaded
  try { execSync(`launchctl unload ${PLIST} 2>/dev/null`); } catch {}

  writeFileSync(PLIST, plist);
  execSync(`launchctl load ${PLIST}`);

  return { plist: PLIST, wrapper: wrapperPath, schedule: 'Every Sunday at 20:00' };
}

export function uninstall() {
  if (!existsSync(PLIST)) {
    return { removed: false, message: 'LaunchAgent not installed' };
  }
  try { execSync(`launchctl unload ${PLIST}`); } catch {}
  unlinkSync(PLIST);

  // Clean up wrapper
  const wrapperPath = join(homedir(), '.claudeye', 'digest-runner.sh');
  try { unlinkSync(wrapperPath); } catch {}

  return { removed: true, message: 'LaunchAgent removed' };
}

export function status() {
  if (!existsSync(PLIST)) return { installed: false };
  try {
    const out = execSync(`launchctl list ${LABEL} 2>&1`, { encoding: 'utf8' });
    return { installed: true, loaded: !out.includes('Could not find'), plist: PLIST };
  } catch {
    return { installed: true, loaded: false, plist: PLIST };
  }
}
