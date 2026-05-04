#!/bin/bash
# Unified scheduler dispatcher (#87). One launchd agent → N subcommands.
HEARTBEAT="/Users/lord/.claudeye/logs/insights-heartbeat.log"
DOW=$(date +%u)   # 1=Mon ... 7=Sun
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [runner] start (dow=$DOW)" >> "$HEARTBEAT"

# Always: Cowork session import (#88)
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [dispatch] import-cowork" >> "$HEARTBEAT"
/opt/homebrew/bin/claudeye import cowork >>/Users/lord/.claudeye/logs/insights-stdout.log 2>>/Users/lord/.claudeye/logs/insights-stderr.log
rc_cowork=$?
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [dispatch] import-cowork exit=$rc_cowork" >> "$HEARTBEAT"

# Always: daily rule-based insights (standalone, no ~/Documents access — #82)
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [dispatch] insights-standalone" >> "$HEARTBEAT"
/opt/homebrew/bin/node /Users/lord/.claudeye/insights-standalone.mjs 2>>/Users/lord/.claudeye/logs/insights-stderr.log
rc_insights=$?
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [dispatch] insights-standalone exit=$rc_insights" >> "$HEARTBEAT"

# Monday: Claude-powered behavioral advisor (standalone — TCC fix for #87)
if [ "$DOW" = "1" ]; then
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [dispatch] behavioral-standalone start" >> "$HEARTBEAT"
  /opt/homebrew/bin/node /Users/lord/.claudeye/behavioral-standalone.mjs --days 14 >>/Users/lord/.claudeye/logs/insights-stdout.log 2>>/Users/lord/.claudeye/logs/insights-stderr.log
  rc_beh=$?
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [dispatch] behavioral-standalone exit=$rc_beh" >> "$HEARTBEAT"
fi

echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [runner] exit rc=$rc_insights" >> "$HEARTBEAT"
exit $rc_insights
