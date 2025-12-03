#!/bin/bash
# Total Recall Session Summary Hook (async)
# Creates a session summary synthesis node in the background

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(dirname "$(dirname "$0")")}"
TOTALRECALL_URL="${TOTALRECALL_BASE_URL:-http://localhost:3847}"

# This runs async - don't block the session
# Queue a session summary request to coordinator
curl -s --max-time 5 -X POST "${TOTALRECALL_URL}/api/synthesis/session-end" \
  -H "Content-Type: application/json" \
  -d '{"session_id": "'"${CLAUDE_SESSION_ID:-unknown}"'"}' \
  >/dev/null 2>&1 &

# Exit immediately - let curl run in background
exit 0
