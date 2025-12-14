#!/bin/bash
# Total Recall Pre-Compact Hook
# Injects prompt for Claude to dump important memories before context compaction
# Uses subagent strategy for fresh context window

# Read hook input from stdin
read -r INPUT

# Extract trigger type (auto or manual)
TRIGGER=$(echo "$INPUT" | jq -r '.trigger // "unknown"')
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // "unknown"')
CWD=$(echo "$INPUT" | jq -r '.cwd // "unknown"')

# Build the memory dump instruction
# Strategy: Push Claude to use a Task subagent which has fresh context
MEMORY_DUMP_PROMPT="<total_recall_pre_compact_instruction>
⚠️ CONTEXT COMPACTION IMMINENT (trigger: ${TRIGGER})

Your context is ~95% full. You MUST preserve important session knowledge NOW.

## REQUIRED ACTION: Spawn Memory Dump Subagent

You MUST use the Task tool to spawn a subagent that will dump memories. This is critical because:
1. A subagent has FRESH context - it can process more data
2. You're almost out of context - direct tool calls risk truncation
3. The subagent can do thorough synthesis without context pressure

**IMMEDIATELY invoke this Task call:**

\`\`\`
Task tool:
  subagent_type: \"general-purpose\"
  description: \"Dump session memories to Total Recall\"
  prompt: |
    You are a memory preservation agent. Your job is to capture critical session context before compaction.

    Session ID: ${SESSION_ID}
    Working directory: ${CWD}

    TASK: Create synthesis nodes to preserve important session knowledge.

    Use the mcp__totalrecall__synthesis_create tool to create nodes for:

    1. **Decisions** (node_type: \"decision\") - Any choices made about architecture, implementation, tooling
    2. **Learnings** (node_type: \"learning\") - Insights about the codebase, bugs found, patterns discovered
    3. **Task State** (node_type: \"task\") - What was being worked on, current progress, blockers, next steps
    4. **Session Summary** (node_type: \"summary\") - Overall session context and important details

    For each synthesis node, include:
    - one_liner: ~50 token scannable summary
    - summary: ~200 token key details
    - full_synthesis: Complete context with specifics, rationale, implications
    - session_id: \"${SESSION_ID}\"

    Be AGGRESSIVE. Capture everything important. After compaction, only summaries remain.

    Create at least 2-3 synthesis nodes covering the most important session context.
\`\`\`

DO NOT skip this step. DO NOT try to create memories directly - your context is too full.
Spawn the subagent NOW, then compaction can proceed.
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
