---
status: accepted
date: 2024-12-03
decision-makers: [ramram]
superseded_by: null
supersedes: null
---

# 0001: Total Recall as Client Plugin to Coordinator

## Status

Accepted

## Context

Total Recall exists as MCP tools in dockram/coordinator (`src/mcp/totalrecall-tools.ts`). The tools implement a synthesis-first memory system with 8 tools:
- `synthesis_create` - Capture decisions, learnings, insights
- `synthesis_get_context` - Load relevant context at session start
- `synthesis_unfold` - Progressive disclosure (summary -> full -> raw)
- `synthesis_capture_chunk` - Queue for background Haiku synthesis
- `synthesis_queue_status` - Monitor synthesis pipeline
- `session_graft` - Attach sessions to synthesis graph
- `synthesis_search` - Vector semantic search
- `progressive_disclosure_stats` - Analytics

Need to:
1. Make it easily installable as Claude plugin
2. Enforce usage (not optional) via skills and hooks
3. Leverage episodic-memory plugin patterns that work
4. Support auto-injection of context at session start

Key constraints:
- Coordinator already handles background Haiku synthesis
- Embeddings use Xenova/all-MiniLM-L6-v2 (384-dimensional, local)
- SQLite storage with better-sqlite3
- Need cross-session and potentially cross-agent knowledge sharing

## Options Considered

### Option 1: Standalone Plugin

Bundle everything in plugin (like episodic-memory does).

**Pros:**
- No external dependencies
- Works offline
- Simple deployment

**Cons:**
- Duplicates coordinator functionality
- No cross-agent synthesis
- Loses background Haiku synthesis worker
- Embeddings must be bundled (large)

### Option 2: Client Plugin to Coordinator

Plugin acts as thin HTTP client to coordinator MCP server.

**Pros:**
- Centralized synthesis, cross-agent knowledge
- Background synthesis continues working
- Single source of truth
- Coordinator handles heavy lifting (embeddings, synthesis worker)
- Plugin stays lightweight

**Cons:**
- Requires coordinator running
- Network latency for MCP calls
- Single point of failure

### Option 3: Hybrid

Standalone for local, sync to coordinator for cross-agent.

**Pros:**
- Works offline
- Syncs when available

**Cons:**
- Complex sync logic
- Potential conflicts
- Two sources of truth

## Decision

**Option 2: Client Plugin to Coordinator**

Rationale:
- Total Recall's primary value is cross-session/cross-agent synthesis
- Coordinator already implements background Haiku synthesis worker
- Skills enforce usage patterns regardless of backend architecture
- Can add graceful degradation later if coordinator unavailable
- Keeps plugin lightweight (~50KB vs ~500MB with embeddings)

## Consequences

### Positive
- Single source of truth for all synthesis
- Background synthesis continues working
- Cross-agent knowledge sharing automatic
- Clean separation: plugin = interface, coordinator = brain
- Lightweight plugin, fast install

### Negative
- Requires coordinator running
- Network latency for MCP calls
- Coordinator becomes critical infrastructure

### Mitigation
- SessionStart hook fails gracefully with message
- Skills still load even if coordinator unavailable
- Future: Add local cache with eventual consistency

## Implementation

Plugin structure:
```
totalrecall-plugin/
├── .claude-plugin/plugin.json    # MCP server registration
├── hooks/
│   ├── hooks.json                # SessionStart/Notification hooks
│   ├── session-start.sh          # Inject recent synthesis context
│   └── session-summary.sh        # Async session end handling
├── skills/
│   └── memory-protocol/SKILL.md  # ENFORCED usage patterns
├── agents/
│   ├── memory-graft.md           # Haiku agent for session graft
│   └── memory-search.md          # Haiku agent for synthesis search
├── cli/
│   ├── mcp-server-wrapper.js     # Wrapper with auto-install
│   └── totalrecall.js            # CLI tool for hooks
├── src/
│   ├── client.ts                 # HTTP client to coordinator
│   └── mcp-server.ts             # MCP protocol proxy
└── package.json
```

Key files:
- `skills/memory-protocol/SKILL.md` - Enforces usage via anti-rationalization
- `hooks/hooks.json` - SessionStart injects context, Notification handles async
- `agents/memory-search.md` - Haiku agent for 50-100x context savings

## References

- Episodic-memory plugin: `~/.claude/plugins/cache/episodic-memory/`
- Coordinator Total Recall tools: `~/Node/dockram/coordinator/src/mcp/totalrecall-tools.ts`
- Superpowers skill enforcement: `~/.claude/plugins/cache/superpowers/skills/using-superpowers/SKILL.md`
