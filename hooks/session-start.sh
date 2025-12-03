#!/bin/bash
# Total Recall Session Start Hook
# Queries recent syntheses and injects as context for progressive disclosure

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(dirname "$(dirname "$0")")}"
TOTALRECALL_URL="${TOTALRECALL_BASE_URL:-http://localhost:3847}"

# Query recent synthesis nodes via coordinator API
# Falls back gracefully if coordinator is unavailable
RECENT=$(curl -s --max-time 2 "${TOTALRECALL_URL}/api/synthesis/recent?limit=5" 2>/dev/null || echo '[]')

# Check if we got valid JSON
if ! echo "$RECENT" | jq empty 2>/dev/null; then
  RECENT='[]'
fi

# Format synthesis nodes for context injection
if [ "$RECENT" = "[]" ]; then
  CONTEXT_MSG="No recent synthesis nodes found. Start capturing decisions and learnings with synthesis_create."
else
  # Format as one-liners for quick scanning
  FORMATTED=$(echo "$RECENT" | jq -r '.[] | "- [\(.node_type)] \(.one_liner)"' 2>/dev/null || echo "")
  CONTEXT_MSG="Recent memories:
${FORMATTED}

Use synthesis_unfold(node_id) to expand any node for more detail.
Use synthesis_search(query) to find specific context."
fi

# Output hook response with injected context
cat <<EOF
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "<total_recall_context>\n${CONTEXT_MSG}\n\nREMINDER: You MUST use the memory-protocol skill. Capture decisions with synthesis_create.\n</total_recall_context>"
  }
}
EOF
