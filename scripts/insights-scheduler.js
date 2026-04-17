#!/usr/bin/env node
/**
 * scripts/insights-scheduler.js — Install/uninstall daily insights launchd agent (#82)
 *
 * Creates a macOS LaunchAgent that runs insights-standalone.mjs daily at 09:00
 * and logs heartbeat to ~/.claudeye/logs/insights-*.log.
 *
 * Background: the `insights` table went silent between 2026-04-12 and 2026-04-17
 * because no scheduler was registered for daily-insights.js. Only weekly-digest
 * had a plist. This fixes that gap.
 */

import { writeFileSync, unlinkSync, existsSync, mkdirSync, copyFileSync } from 'fs';
import { execSync } from 'child_process';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

const LABEL    = 'com.claudeye.daily-insights';
const PLIST    = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const LOG_DIR  = join(homedir(), '.claudeye', 'logs');
const LOG_OUT  = join(LOG_DIR, 'insights-stdout.log');
const LOG_ERR  = join(LOG_DIR, 'insights-stderr.log');

export function install({ hour = 9, minute = 0 } = {}) {
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });

  // Copy standalone insights script to ~/.claudeye/ (TCC-safe, like digest)
  const standaloneSrc  = join(__dirname, 'insights-standalone.js');
  const standaloneDest = join(homedir(), '.claudeye', 'insights-standalone.mjs');

  if (existsSync(standaloneSrc)) {
    copyFileSync(standaloneSrc, standaloneDest);
  }

  // Wrapper: logs start/finish, runs standalone, forwards stderr
  const wrapperPath = join(homedir(), '.claudeye', 'insights-runner.sh');
  const wrapper = `#!/bin/bash
# Heartbeat: always record that the scheduler fired, even if the script errors.
# Without this we can't distinguish "scheduler never ran" from "script crashed silently".
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [runner] start" >> ${LOG_DIR}/insights-heartbeat.log
/opt/homebrew/bin/node ${standaloneDest} 2>>${LOG_ERR}
rc=$?
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [runner] exit rc=$rc" >> ${LOG_DIR}/insights-heartbeat.log
exit $rc
`;
  writeFileSync(wrapperPath, wrapper, { mode: 0o755 });

  // LaunchAgent plist — daily at ${hour}:${minute}
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
    <key>Hour</key>
    <integer>${hour}</integer>
    <key>Minute</key>
    <integer>${minute}</integer>
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

  return {
    plist: PLIST,
    wrapper: wrapperPath,
    schedule: `Daily at ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
    standalone: standaloneDest,
  };
}

export function uninstall() {
  if (!existsSync(PLIST)) {
    return { removed: false, message: 'LaunchAgent not installed' };
  }
  try { execSync(`launchctl unload ${PLIST}`); } catch {}
  unlinkSync(PLIST);

  const wrapperPath = join(homedir(), '.claudeye', 'insights-runner.sh');
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

// Standalone invocation: `node scripts/insights-scheduler.js install|uninstall|status`
const isMain = process.argv[1]?.endsWith('insights-scheduler.js');
if (isMain) {
  const cmd = process.argv[2] || 'status';
  switch (cmd) {
    case 'install':
      console.log(JSON.stringify(install(), null, 2));
      break;
    case 'uninstall':
      console.log(JSON.stringify(uninstall(), null, 2));
      break;
    case 'status':
      console.log(JSON.stringify(status(), null, 2));
      break;
    default:
      console.error('Usage: insights-scheduler.js install|uninstall|status');
      process.exit(1);
  }
}
