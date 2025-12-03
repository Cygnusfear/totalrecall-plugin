# Total Recall Claude Plugin

Enforced synthesis-first memory system for Claude Code. Captures decisions, learnings, and context across sessions with progressive disclosure.

## Architecture

This plugin is a **client** to the Total Recall coordinator (`~/Node/dockram/coordinator`). The coordinator handles:
- Background Haiku synthesis
- Vector embeddings (Xenova/all-MiniLM-L6-v2)
- SQLite storage
- Cross-agent knowledge sharing

The plugin provides:
- MCP tools for Claude to call
- Skills for enforcement
- Hooks for auto-injection
- Agents for context-efficient searches

## Installation

```bash
# From plugin directory
cd ~/Node/totalrecall-plugin
npm install
npm run build

# Install as Claude plugin
claude plugin install ~/Node/totalrecall-plugin
```

## Prerequisites

The coordinator must be running:

```bash
cd ~/Node/dockram/coordinator
npm start
```

Default URL: `http://localhost:3847`

Set `TOTALRECALL_BASE_URL` environment variable if different.

## How It Works

### Automatic (via hooks)

1. **SessionStart** - `session-start.sh` queries recent synthesis and injects as `<total_recall_context>`
2. **Notification** - `session-summary.sh` runs async to handle session end

### Manual (via tools)

- `synthesis_create` - Capture decisions, learnings, insights
- `synthesis_search` - Find by semantic similarity
- `synthesis_unfold` - Progressive disclosure (summary -> full -> raw)
- `synthesis_get_context` - Load session context
- `session_graft` - Attach session to synthesis graph

### Enforcement (via skills)

The `memory-protocol` skill makes memory usage **mandatory**:
- Must capture decisions as they happen
- Must use memory-search agent (not direct tools) for lookups
- Anti-rationalization blocks common excuses

## Usage

### Capture a Decision

```
mcp__totalrecall__synthesis_create({
  node_type: "decision",
  one_liner: "Chose Zustand over Redux for state management",
  summary: "Zustand has less boilerplate, better TypeScript support...",
  full_synthesis: "After evaluating state management options...",
  session_id: "session-123"
})
```

### Search Memory

Use the memory-search agent (not direct tool):

```
Task tool:
  description: "Search for auth decisions"
  prompt: "Find decisions about authentication implementation"
  subagent_type: "memory-search"
  model: "haiku"
```

### Progressive Disclosure

```
# Start with one-liners (from hook injection)
# Unfold to summary for more detail
mcp__totalrecall__synthesis_unfold({
  node_id: "syn_abc123",
  depth: "summary"
})

# Unfold to full only when needed
mcp__totalrecall__synthesis_unfold({
  node_id: "syn_abc123",
  depth: "full"
})
```

## CLI

```bash
# Recent synthesis (for debugging hooks)
totalrecall recent --limit=5 --format=json

# Search
totalrecall search "authentication decisions"

# Graft session
totalrecall graft --session=my-session "implementing auth"

# Create synthesis
totalrecall create --type=decision "Chose X over Y"

# Check coordinator status
totalrecall status
```

## Directory Structure

```
totalrecall-plugin/
├── .claude-plugin/
│   └── plugin.json         # Plugin manifest
├── hooks/
│   ├── hooks.json          # Hook definitions
│   ├── session-start.sh    # Context injection
│   └── session-summary.sh  # Async end handling
├── skills/
│   └── memory-protocol/
│       └── SKILL.md        # Enforcement skill
├── agents/
│   ├── memory-graft.md     # Session graft agent
│   └── memory-search.md    # Search agent
├── cli/
│   ├── mcp-server-wrapper.js
│   └── totalrecall.js
├── src/
│   ├── client.ts           # HTTP client
│   └── mcp-server.ts       # MCP proxy server
└── .plans/decisions/
    └── 0001-plugin-architecture.md
```

## License

MIT
