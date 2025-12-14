#!/bin/bash
# Total Recall Pre-Compact Hook
# Injects prompt for Claude to dump important memories before context compaction

# Read hook input from stdin
read -r INPUT

# Extract trigger type (auto or manual)
TRIGGER=$(echo "$INPUT" | jq -r '.trigger // "unknown"')
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // "unknown"')

# Build the memory dump instruction
# This gets injected as context that Claude will see and act on
MEMORY_DUMP_PROMPT="<total_recall_pre_compact_instruction>
IMPORTANT: Context compaction is about to happen (trigger: ${TRIGGER}).

BEFORE compaction proceeds, you MUST dump critical session context to Total Recall. Use synthesis_create to preserve:

1. **Active Decisions** - Any architectural/implementation decisions made this session
2. **Key Learnings** - Important insights about the codebase, bugs discovered, patterns identified
3. **Task Context** - What you were working on, current state, blockers, next steps
4. **Important Context** - Anything that would be lost and painful to rediscover

For each memory, use the appropriate node_type:
- decision: Choices made and why
- learning: Insights and discoveries
- task: Work items and their status
- summary: Session state and context

Be AGGRESSIVE about capturing context. After compaction, you will only have summaries - capture the details NOW.

Example synthesis_create call:
{
  \"node_type\": \"summary\",
  \"one_liner\": \"Session context before compaction: [brief description]\",
  \"summary\": \"[200 tokens of key details]\",
  \"full_synthesis\": \"[Complete context with specifics]\",
  \"session_id\": \"${SESSION_ID}\"
}

PROCEED: Create synthesis nodes for important context, then compaction can continue.
</total_recall_pre_compact_instruction>"

# Output hook response with injected instructions
cat <<EOF
{
  "hookSpecificOutput": {
    "hookEventName": "PreCompact",
    "additionalContext": $(echo "$MEMORY_DUMP_PROMPT" | jq -Rs .)
  }
}
EOF
