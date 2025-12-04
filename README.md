# Total Recall Claude Plugin

Enforced synthesis-first memory system for Claude Code. Captures decisions, learnings, and context across sessions with progressive disclosure.

## Architecture

Total Recall v2.0 is a **standalone plugin** with self-contained storage and processing:

- **SQLite + sqlite-vec** for local vector search (no external dependencies)
- **Xenova/all-MiniLM-L6-v2** embeddings (runs locally)
- **Background Haiku synthesis** worker (optional, requires ANTHROPIC_API_KEY)
- **Progressive disclosure** analytics for context optimization

The plugin provides:
- MCP tools for Claude to call
- Skills for enforcement
- Hooks for automatic context injection
- Agents for context-efficient searches

## Installation

```bash
# From plugin directory
cd ~/projects/totalrecall-plugin
npm install
npm run build

# Install as Claude plugin
claude plugin install ~/projects/totalrecall-plugin
```

## Prerequisites

**Required:** Node.js 18+

**Optional:** Set `ANTHROPIC_API_KEY` for background synthesis worker (auto-synthesizes conversation chunks using Haiku)

## How It Works

### Automatic (via hooks)

1. **SessionStart** - `session-graft` grafts session to synthesis graph, injects relevant context as `<total_recall_context>`
2. **SessionStart (async)** - `backfill --background` processes any unsynced conversations
3. **Stop** - `queue-synthesis` queues current session chunk for background synthesis
4. **SessionEnd** - `session-complete` creates session summary synthesis

### Manual (via MCP tools)

- `synthesis_create` - Capture decisions, learnings, insights
- `synthesis_search` - Find by semantic similarity (vector search)
- `synthesis_unfold` - Progressive disclosure (summary -> full -> raw)
- `synthesis_get_context` - Load session context
- `session_graft` - Attach session to synthesis graph
- `synthesis_capture_chunk` - Queue content for background synthesis
- `synthesis_queue_status` - Check synthesis queue status
- `progressive_disclosure_stats` - Get analytics on context savings

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
  subagent_type: "totalrecall:memory-search"
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
# Hook commands (called automatically by Claude Code)
totalrecall session-graft      # Graft session to synthesis graph
totalrecall session-complete   # Complete session with summary
totalrecall queue-synthesis    # Queue session for background synthesis
totalrecall backfill           # Backfill unprocessed conversations
totalrecall backfill --background  # Run in background

# User commands
totalrecall recent             # Get recent synthesis nodes
totalrecall recent --limit=10 --format=json
totalrecall search "authentication decisions"  # Semantic search
totalrecall status             # Check system status
```

**Environment variables:**
- `ANTHROPIC_API_KEY` - Required for background synthesis worker
- `TRANSCRIPT_PATH` - Set automatically by Claude Code hooks

## Directory Structure

```
totalrecall-plugin/
├── .claude-plugin/
│   └── plugin.json           # Plugin manifest
├── hooks/
│   └── hooks.json            # Hook definitions (SessionStart, Stop, SessionEnd)
├── skills/
│   └── memory-protocol/
│       └── SKILL.md          # Enforcement skill (MANDATORY)
├── agents/
│   ├── memory-graft.md       # Session graft agent
│   └── memory-search.md      # Search agent (use instead of direct tools)
├── cli/
│   ├── mcp-server-wrapper.js # MCP server launcher
│   └── totalrecall.js        # CLI entry point
├── src/
│   ├── mcp-server.ts         # MCP server with all tools
│   ├── db.ts                 # SQLite + sqlite-vec database
│   ├── embeddings.ts         # Xenova transformer embeddings
│   ├── llm-synthesis.ts      # Haiku synthesis client
│   ├── synthesis-worker.ts   # Background synthesis processor
│   ├── schema.ts             # TypeScript types
│   ├── paths.ts              # Path resolution
│   └── cli/                  # CLI command implementations
│       ├── session-graft.ts
│       ├── session-complete.ts
│       ├── queue-synthesis.ts
│       ├── backfill.ts
│       ├── recent.ts
│       ├── search.ts
│       └── status.ts
├── test/
│   └── integration.ts        # Integration tests
└── .plans/
    └── decisions/
        └── 0001-plugin-architecture.md
```

**Data location:** `~/.config/totalrecall/synthesis.sqlite`

## License

MIT
