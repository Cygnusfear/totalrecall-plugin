# Oracle #3: Message Enrichment Investigation

## Initial Hypotheses

When I started this investigation, I formed these hypotheses:

1. **Hypothesis A**: Total Recall likely already has some form of context injection
2. **Hypothesis B**: Claude Code hooks should provide mechanisms for per-message enrichment
3. **Hypothesis C**: The `UserPromptSubmit` hook would be the key for user message enrichment
4. **Hypothesis D**: Assistant message enrichment would be more challenging since there's no direct "assistant output" hook

## Research Path

### Avenue 1: Current Implementation Analysis

**Explored files:**
- `/Users/alexander/Projects/totalrecall-plugin/hooks/hooks.json`
- `/Users/alexander/Projects/totalrecall-plugin/src/cli/session-graft.ts`
- `/Users/alexander/Projects/totalrecall-plugin/README.md`
- `/Users/alexander/Projects/totalrecall-plugin/skills/memory-protocol/SKILL.md`

**Discovery:** Total Recall ALREADY implements context injection, but only at **SessionStart**. The `session-graft.ts` command:
1. Queries the 5 most recent synthesis nodes
2. Formats them as one-liners (~50-100 tokens total)
3. Outputs JSON with `additionalContext` containing `<total_recall_context>`

**Evidence:** `/Users/alexander/Projects/totalrecall-plugin/src/cli/session-graft.ts:36-49`
```typescript
console.log(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: `<total_recall_context>
Recent memories:
${contextMsg}

Use synthesis_unfold(node_id) to expand any node.
Use synthesis_search(query) to find specific context.
</total_recall_context>`,
    },
  })
);
```

**Gap identified:** No per-message enrichment exists. Context is only injected once per session.

### Avenue 2: Claude Code Hooks Documentation

**Sources:**
- Official docs: https://code.claude.com/docs/en/hooks
- Web search for "Claude Code hooks API user-prompt-submit-hook documentation 2025"

**Key Discovery:** The `UserPromptSubmit` hook is the mechanism for per-message enrichment. It:
- Fires when user submits a prompt, BEFORE Claude processes it
- Can add `additionalContext` to the conversation
- Receives session context via stdin JSON

**Available hooks for consideration:**
| Hook | When | Useful for |
|------|------|------------|
| `SessionStart` | Session starts/resumes | **Already used** for initial context |
| `UserPromptSubmit` | User submits prompt | **KEY** for user message enrichment |
| `PreToolUse` | Before tool execution | Could enrich tool calls |
| `PostToolUse` | After tool completion | Could add follow-up context |
| `Stop` | Agent finishes responding | **Capture** Claude's output for synthesis |
| `SessionEnd` | Session ends | Summary creation |

**Evidence from official docs:**
```json
{
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "My additional context here"
  }
}
```

### Avenue 3: Total Recall Data Layer Analysis

**Explored files:**
- `/Users/alexander/Projects/totalrecall-plugin/src/db.ts`
- `/Users/alexander/Projects/totalrecall-plugin/src/embeddings.ts`
- `/Users/alexander/Projects/totalrecall-plugin/src/mcp-server.ts`

**Discovery:** Total Recall has a robust semantic search capability:
1. **Vector embeddings**: Uses `Xenova/all-MiniLM-L6-v2` (384-dimensional)
2. **sqlite-vec**: Local vector search with configurable similarity thresholds
3. **Node types**: decision, learning, entity, event, task, summary
4. **Querying**: `db.searchByVector(queryEmbedding, limit, minScore, nodeTypes)`

**Evidence:** `/Users/alexander/Projects/totalrecall-plugin/src/db.ts:293-344`
The `searchByVector` method already supports:
- Semantic similarity search
- Score thresholds (min_score)
- Node type filtering
- Result limiting

### Avenue 4: Existing Hook Configuration

**Explored file:** `/Users/alexander/Projects/totalrecall-plugin/hooks/hooks.json`

**Current configuration:**
```json
{
  "hooks": {
    "SessionStart": [{
      "matcher": "startup|resume",
      "hooks": [
        { "type": "command", "command": "session-graft", "timeout": 5 },
        { "type": "command", "command": "backfill --background", "async": true }
      ]
    }],
    "Stop": [{
      "hooks": [{ "type": "command", "command": "queue-synthesis", "async": true }]
    }],
    "SessionEnd": [{
      "hooks": [{ "type": "command", "command": "session-complete", "timeout": 30 }]
    }]
  }
}
```

**Gap:** No `UserPromptSubmit` hook configured.

### Avenue 5: Architecture Decision Records

**Explored file:** `/Users/alexander/Projects/totalrecall-plugin/.plans/decisions/0001-plugin-architecture.md`

**Key context:** The plugin was designed as a "Client Plugin to Coordinator" but has been refactored to standalone. The decision highlighted:
- Skills enforce usage patterns
- Hooks provide auto-injection at session start
- Progressive disclosure saves 50-100x context

This confirms the architectural intent but shows the per-message enrichment wasn't part of the original design.

## Dead Ends

### Dead End 1: Looking for existing UserPromptSubmit implementation
**Grep search:** `UserPromptSubmit|PreToolUse|PostToolUse` in the codebase returned **no results**.
**Conclusion:** Per-message hooks are not implemented at all.

### Dead End 2: Enriching assistant messages directly
**Finding:** There's no "AssistantMessageSubmit" or similar hook in Claude Code.
**Conclusion:** Cannot directly enrich Claude's output. Would need to:
- Capture via `Stop` hook after the fact
- Use MCP tool-based approach where Claude explicitly calls for context
- Rely on system prompt instructions

### Dead End 3: Old shell-based hooks
**Files found:** `hooks/session-start.sh`, `hooks/session-summary.sh`
**Conclusion:** These are legacy implementations that talk to the coordinator API. The current standalone implementation uses TypeScript CLI commands instead.

## Key Discoveries

### Discovery 1: UserPromptSubmit is the key mechanism
The `UserPromptSubmit` hook fires for EVERY user message and can inject additionalContext. This is the primary mechanism for per-message enrichment.

**Implementation approach:**
```json
{
  "UserPromptSubmit": [{
    "hooks": [{
      "type": "command",
      "command": "${CLAUDE_PLUGIN_ROOT}/cli/totalrecall.js prompt-enrich",
      "timeout": 3
    }]
  }]
}
```

### Discovery 2: Hook receives message context via stdin
The hook receives a JSON object on stdin containing:
```json
{
  "session_id": "string",
  "transcript_path": "string",
  "cwd": "string",
  "hook_event_name": "UserPromptSubmit"
}
```

The user's message is available in the transcript or can be passed as part of the hook's input.

### Discovery 3: Semantic search can select relevant context
Total Recall already has `synthesis_search` which can:
1. Take a query (user message)
2. Generate embedding
3. Return top-N relevant synthesis nodes
4. Filter by score threshold

**Code location:** `/Users/alexander/Projects/totalrecall-plugin/src/mcp-server.ts:450-518`

### Discovery 4: Performance is critical
The `UserPromptSubmit` hook has a timeout (default 60s, configurable). For good UX:
- Embeddings are pre-loaded (~23MB model)
- sqlite-vec is fast (~<100ms for vector search)
- Should target <500ms total latency

### Discovery 5: Token budgeting is essential
~200 tokens translates to approximately:
- 3-4 synthesis one-liners with brief context
- 1-2 summary-level node expansions
- Need to balance relevance vs quantity

## Synthesis: Answer to Core Questions

### Q1: Do we already do this in the totalrecall-plugin codebase?

**PARTIAL.** Total Recall injects context at `SessionStart` only (~50-100 tokens of recent memories). There is NO per-message enrichment currently implemented.

**Evidence:**
- `hooks/hooks.json`: Only `SessionStart`, `Stop`, `SessionEnd` hooks configured
- `session-graft.ts`: Injects `<total_recall_context>` with recent one-liners
- No `UserPromptSubmit` hook anywhere in the codebase

### Q2: How can we best implement this using hooks?

**Recommended Implementation:**

1. **Add UserPromptSubmit hook** to `hooks/hooks.json`:
```json
{
  "UserPromptSubmit": [{
    "hooks": [{
      "type": "command",
      "command": "${CLAUDE_PLUGIN_ROOT}/cli/totalrecall.js prompt-enrich",
      "timeout": 3
    }]
  }]
}
```

2. **Create `prompt-enrich.ts` CLI command**:
```typescript
// /src/cli/prompt-enrich.ts
async function main() {
  const db = getDatabase();
  await initEmbeddings();
  
  // Read hook input from stdin
  const input = JSON.parse(await readStdin());
  
  // Get the user's latest message from transcript
  const userMessage = await getLatestUserMessage(input.transcript_path);
  
  // Semantic search for relevant context
  const embedding = await generateEmbedding(userMessage);
  const results = db.searchByVector(embedding, 5, 0.4);
  
  // Budget ~200 tokens: 3-4 one-liners with summaries
  const context = results
    .slice(0, 3)
    .map(r => `[${r.node_type}] ${r.one_liner}`)
    .join('\n');
  
  // Output hook response
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: `<total_recall_memories>\n${context}\n</total_recall_memories>`
    }
  }));
  
  db.close();
}
```

3. **For assistant messages**, use a two-pronged approach:
   - **Stop hook**: Capture Claude's response, queue for synthesis (already exists)
   - **System prompt instruction**: Tell Claude to proactively call `synthesis_search` when it needs context

### Q3: How do we ensure accuracy/relevance of the injected context?

**Strategies:**

1. **Semantic relevance scoring**
   - Use embedding similarity (already in place)
   - Set minimum threshold (0.4-0.5) to filter noise
   - Sort by score, not recency

2. **Node type prioritization**
   - Weight `decision` and `learning` types higher
   - Deprioritize `summary` nodes (often redundant)

3. **Recency boost**
   - Apply time decay: recent nodes get bonus
   - Formula: `final_score = similarity * (0.8 + 0.2 * recency_factor)`

4. **Context-aware filtering**
   - Extract keywords/entities from user message
   - Filter by `entity_name` or `source_repo` when relevant

5. **Fallback to recent**
   - If semantic search returns nothing (cold start), fall back to recent nodes
   - This matches current `session-graft` behavior

6. **Progressive disclosure**
   - Inject one-liners (~50 tokens each)
   - Include hint: "Use synthesis_unfold(node_id) for details"
   - Claude can drill down if needed

7. **Token budgeting**
   - Hard limit: 200 tokens
   - Typical allocation: 3 one-liners (150 tokens) + instructions (50 tokens)

## Confidence Assessment

### High Confidence
- `UserPromptSubmit` is the correct hook for user message enrichment
- Current implementation only injects at `SessionStart`
- Semantic search via sqlite-vec is fast enough (<100ms)
- The ~200 token budget is achievable with 3-4 one-liners

### Medium Confidence
- Performance will be acceptable with pre-loaded embeddings
- The relevance scoring approach will work well in practice
- Token counting accuracy (may need tiktoken for precision)

### Low Confidence
- How Claude Code actually passes the user message to hooks (may need to read transcript)
- Whether assistant message enrichment is even necessary if user messages are enriched
- The ideal similarity threshold (0.4-0.5 is a starting guess)

## Divergent Possibilities

### Alternative 1: LLM-based relevance selection
Instead of pure semantic search, use a fast LLM (Haiku) to select the most relevant nodes from a larger candidate set. More accurate but slower and costlier.

### Alternative 2: Pre-computed context per conversation topic
Cluster conversations by topic and pre-compute relevant context. Trade storage for speed.

### Alternative 3: Hybrid approach with MCP tool
- Inject minimal context via hook (~50 tokens)
- Provide `get_enriched_context` MCP tool for Claude to call when needed
- Claude decides when to request more context

### Alternative 4: PostToolUse hook for tool-specific context
When Claude uses certain tools (Edit, Write), inject relevant past decisions about that file/component via PostToolUse hook.

## Recommended Actions

1. **Immediate**: Add `UserPromptSubmit` hook configuration to `hooks/hooks.json`

2. **Create**: New CLI command `prompt-enrich.ts` that:
   - Reads user message from transcript
   - Queries semantic search
   - Returns ~200 tokens of relevant context

3. **Optimize**: Pre-load embeddings during MCP server startup (already done)

4. **Test**: Measure end-to-end latency of hook execution

5. **Iterate**: Tune similarity threshold based on real-world usage

6. **Consider**: Adding relevance feedback mechanism (track when Claude uses `synthesis_unfold` to measure if injected context was useful)

## Implementation Sketch

```
hooks/hooks.json (updated)
├── SessionStart: [session-graft] ← existing
├── UserPromptSubmit: [prompt-enrich] ← NEW
├── Stop: [queue-synthesis] ← existing  
└── SessionEnd: [session-complete] ← existing

src/cli/prompt-enrich.ts (new)
├── Read stdin for hook input
├── Parse transcript for latest user message
├── Generate embedding
├── Search for relevant nodes (limit 5, min_score 0.4)
├── Format top 3 as one-liners (~200 tokens)
└── Output JSON with additionalContext
```

## Files to Modify

1. `/Users/alexander/Projects/totalrecall-plugin/hooks/hooks.json` - Add UserPromptSubmit hook
2. `/Users/alexander/Projects/totalrecall-plugin/src/cli/prompt-enrich.ts` - New file
3. `/Users/alexander/Projects/totalrecall-plugin/cli/totalrecall.js` - Add prompt-enrich command

## Trade-offs

| Approach | Pros | Cons |
|----------|------|------|
| UserPromptSubmit hook | Automatic, every message | Adds latency, may inject irrelevant context |
| MCP tool only | Claude decides when to search | May forget to use it, skill enforcement needed |
| Both (hybrid) | Best of both worlds | Complexity, potential duplicate context |

**Recommendation**: Start with UserPromptSubmit hook + fallback MCP tool. The hook provides baseline context; Claude can search for more if needed.
