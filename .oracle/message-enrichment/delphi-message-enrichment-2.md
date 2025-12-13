# Oracle Investigation: Message Enrichment with Total Recall Context

**Oracle #2 - Deep Research Agent**
**Date:** 2025-12-11

---

## 1. Initial Hypotheses

Before investigating, I hypothesized:

1. **Total Recall likely already has SOME context injection** - Given the plugin's purpose, there should be existing mechanisms for context injection
2. **Claude Code hooks should support per-message injection** - Based on the mention of `user-prompt-submit-hook`, this seemed likely
3. **Vector search infrastructure exists** - For ~200 token injection, semantic search would be key
4. **Implementation would require new hook configuration** - Current hooks likely focus on session lifecycle, not individual messages

---

## 2. Research Path

### Avenue 1: Codebase Structure Discovery

**Files explored:**
- `hooks/hooks.json` - Found existing hook configuration
- `src/cli/session-graft.ts` - Found current context injection mechanism
- `hooks/session-start.sh` - Alternative shell-based hook (unused in current config)

**Key discovery:** Total Recall already injects context at `SessionStart` via `session-graft.ts`

### Avenue 2: Hook Implementation Analysis

**Files explored:**
- `src/cli/session-graft.ts` (lines 36-49)
- `README.md` - Documentation of hook behavior

**Current implementation:**
```typescript
// From session-graft.ts lines 36-49
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

**Observation:** Injects top 5 recent synthesis nodes as one-liners

### Avenue 3: Claude Code Hooks Documentation Research

**Sources:**
- Official docs at https://code.claude.com/docs/en/hooks
- Web search results for Claude Code hooks 2025

**Critical finding:** `UserPromptSubmit` hook exists and:
- Fires on EVERY user prompt submission
- Runs BEFORE Claude processes the prompt
- Can add `additionalContext` via same JSON format as SessionStart
- Has configurable timeout (default 60s, recommend 5s for enrichment)

### Avenue 4: Vector Search Infrastructure

**Files explored:**
- `src/db.ts` - `searchByVector()` method (lines 293-344)
- `src/embeddings.ts` - Embedding generation with Xenova/all-MiniLM-L6-v2
- `src/cli/search.ts` - CLI search implementation

**Capabilities confirmed:**
- 384-dimensional embeddings (local, no API calls)
- sqlite-vec for fast vector similarity search
- Configurable `minScore` threshold
- Node type filtering available

### Avenue 5: Progressive Disclosure System

**Files explored:**
- `src/mcp-server.ts` - Full MCP tool implementation
- `skills/memory-protocol/SKILL.md` - Enforcement patterns

**Understanding:** The system already tracks injection events and expansion patterns via `progressive_disclosure_events` table

---

## 3. Dead Ends

### Dead End 1: Shell-based Hooks
- `hooks/session-start.sh` exists but is NOT used
- Current hooks.json uses TypeScript CLI commands instead
- Shell approach would work but TypeScript is preferred for consistency

### Dead End 2: PostToolUse Hook for Context
- Considered using `PostToolUse` to inject context after tool execution
- Rejected because: adds context AFTER response generation, not before

### Dead End 3: MCP Tool-Based Enrichment
- Considered having Claude call `synthesis_get_context` manually on each message
- Rejected because: adds latency, wastes tokens on tool call, not automatic

---

## 4. Key Discoveries

### Discovery 1: Current State - Session-Only Injection

**Evidence:** `/Users/alexander/Projects/totalrecall-plugin/hooks/hooks.json`
```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume",
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PLUGIN_ROOT}/cli/totalrecall.js session-graft",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

**Conclusion:** NO `UserPromptSubmit` hook exists. Context is only injected once per session.

### Discovery 2: UserPromptSubmit Hook Capabilities

**Evidence:** Claude Code hooks documentation (WebFetch result)

The hook receives user prompt as JSON on stdin:
```json
{
  "prompt": "The user's message text",
  "session_id": "...",
  "conversation_id": "..."
}
```

Can output context two ways:
1. Plain text to stdout (simplest)
2. JSON with `additionalContext` field (structured)

**Critical:** Exit code 0 adds context, exit code 2 blocks prompt

### Discovery 3: Vector Search Performance

**Evidence:** `/Users/alexander/Projects/totalrecall-plugin/src/db.ts` lines 293-344

```typescript
searchByVector(
  queryEmbedding: number[],
  limit: number,
  minScore: number,
  nodeTypes?: NodeType[]
): SearchResult[]
```

- Uses sqlite-vec MATCH query
- Converts L2 distance to cosine similarity
- Returns `node_id`, `one_liner`, `score`, `node_type`, `created_at`

**Performance:** sqlite-vec is extremely fast (<10ms for searches)

### Discovery 4: Embedding Infrastructure Ready

**Evidence:** `/Users/alexander/Projects/totalrecall-plugin/src/embeddings.ts`

- Model: `Xenova/all-MiniLM-L6-v2` (384 dimensions)
- Loads on first use, cached in memory
- `generateEmbedding(text)` - ~50-100ms after warm-up
- Already pre-loaded during MCP server startup

### Discovery 5: Token Budget Calculation

**Evidence:** `/Users/alexander/Projects/totalrecall-plugin/src/mcp-server.ts` tool definitions

- `one_liner`: ~50 tokens
- `summary`: ~200 tokens  
- `full_synthesis`: 300-500 tokens

**For ~200 token budget:**
- Option A: 4 one-liners (4 x 50 = 200 tokens)
- Option B: 1 summary (200 tokens)
- Option C: Hybrid (2 one-liners + partial summary = ~150 tokens)

---

## 5. Synthesis: Implementation Approach

### Recommended Implementation

**Step 1: Create `prompt-enrich` CLI Command**

New file: `/Users/alexander/Projects/totalrecall-plugin/src/cli/prompt-enrich.ts`

```typescript
/**
 * CLI: prompt-enrich
 * Called by UserPromptSubmit hook to inject relevant context
 */
import { getDatabase } from '../db.js';
import { generateEmbedding, initEmbeddings } from '../embeddings.js';

async function main() {
  // Read prompt from stdin (Claude Code passes JSON)
  const input = await readStdin();
  let promptText: string;
  
  try {
    const parsed = JSON.parse(input);
    promptText = parsed.prompt || '';
  } catch {
    promptText = input; // Plain text fallback
  }
  
  if (!promptText || promptText.length < 10) {
    // No enrichment for very short prompts
    process.exit(0);
  }
  
  const db = getDatabase();
  await initEmbeddings();
  
  // Generate embedding for user prompt
  const embedding = await generateEmbedding(promptText);
  
  // Search for relevant nodes (higher threshold for precision)
  const results = db.searchByVector(embedding, 4, 0.5);
  
  db.close();
  
  if (results.length === 0) {
    process.exit(0); // No relevant context
  }
  
  // Format as one-liners (fits in ~200 tokens)
  const contextLines = results.map(r => 
    `- [${r.node_type}] ${r.one_liner} (${r.node_id.slice(0, 8)})`
  ).join('\n');
  
  // Output hook response
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: `<total_recall_relevant>
Relevant memories for your query:
${contextLines}

Use synthesis_unfold(node_id) for more detail.
</total_recall_relevant>`
    }
  }));
}

async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => data += chunk);
    process.stdin.on('end', () => resolve(data));
    // Timeout after 2s if no stdin
    setTimeout(() => resolve(''), 2000);
  });
}

main().catch(() => process.exit(0)); // Fail silently
```

**Step 2: Update hooks.json**

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume",
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PLUGIN_ROOT}/cli/totalrecall.js session-graft",
            "timeout": 5
          },
          {
            "type": "command",
            "command": "${CLAUDE_PLUGIN_ROOT}/cli/totalrecall.js backfill --background",
            "async": true
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PLUGIN_ROOT}/cli/totalrecall.js prompt-enrich",
            "timeout": 3
          }
        ]
      }
    ],
    "Stop": [...],
    "SessionEnd": [...]
  }
}
```

**Step 3: Add CLI Entry Point**

Update `/Users/alexander/Projects/totalrecall-plugin/cli/totalrecall.js` to include `prompt-enrich` command.

### Alternative Implementation: Performance-Optimized

For even faster response, cache session-relevant nodes:

1. At `SessionStart`, pre-compute embedding clusters for likely topics
2. Store in session-local cache (memory or temp file)
3. At `UserPromptSubmit`, do fast keyword matching against cache
4. Only fall back to full embedding search for cache misses

---

## 6. Confidence & Caveats

### High Confidence

- `UserPromptSubmit` hook exists and works as described
- Current plugin only injects at SessionStart (no per-message)
- Vector search infrastructure is complete and fast
- ~200 token budget is achievable with 4 one-liners

### Medium Confidence

- 3-second timeout should be sufficient (embedding + search)
- Higher `minScore` (0.5+) will improve relevance
- Deduplication with SessionStart context may be needed

### Low Confidence / Uncertain

- Impact on user-perceived latency (need benchmarking)
- Whether stdin reading works reliably in Claude Code hooks
- Optimal `minScore` threshold (needs experimentation)
- Whether repeated injection becomes noise vs signal

### Caveats

1. **Cold start penalty:** First prompt may be slow if embeddings not pre-loaded
2. **Redundancy:** May inject same nodes as SessionStart - needs deduplication
3. **Relevance accuracy:** Semantic search may miss relevant nodes or include irrelevant ones
4. **Token budget pressure:** Every message now has ~200 fewer tokens for actual response

---

## 7. Divergent Possibilities

### Alternative 1: Lazy Enrichment

Only enrich when prompt contains certain keywords:
- "remember", "previous", "earlier", "we discussed"
- Architecture/decision keywords
- Project-specific terms

**Pros:** Less overhead, more targeted
**Cons:** Misses implicit relevance

### Alternative 2: Assistant Message Enrichment

Inject context into Claude's response rather than user message:
- Use `PostToolUse` on Write/Edit tools
- Inject "reminder" context after certain operations

**Pros:** Context closer to action point
**Cons:** Doesn't help with initial understanding

### Alternative 3: Two-Phase Enrichment

1. SessionStart: Broad context (~500 tokens)
2. UserPromptSubmit: Narrow, prompt-specific (~100 tokens)

**Pros:** Better balance, less redundancy
**Cons:** More complex, two formats to maintain

### Alternative 4: LLM-Based Relevance Filtering

Use Haiku to filter search results before injection:
- Search returns 10 candidates
- Haiku picks 2-3 most relevant
- Only those get injected

**Pros:** Higher precision
**Cons:** Adds latency and cost

---

## 8. Recommended Actions

### Immediate (Implement Now)

1. **Create `prompt-enrich.ts`** - Core enrichment logic
2. **Update hooks.json** - Add UserPromptSubmit hook
3. **Update CLI entry point** - Register new command
4. **Test with short timeout (3s)** - Verify performance

### Short-term (After Initial Implementation)

5. **Add deduplication** - Track injected nodes per session in memory
6. **Tune minScore** - Experiment with 0.4, 0.5, 0.6 thresholds
7. **Add metrics** - Track enrichment latency and relevance
8. **Test edge cases** - Very short prompts, no matches, slow embedding

### Medium-term (Optimization)

9. **Implement caching** - Pre-compute session-relevant embeddings
10. **Add node type filtering** - Match query type to node types
11. **Progressive disclosure tracking** - Log which injected nodes get unfolded

---

## Summary

**Q: Do we already do this in the totalrecall-plugin codebase?**

**A:** Partially. We inject ~200 tokens of context at `SessionStart` only. There is NO per-message enrichment currently implemented. The infrastructure (vector search, embeddings, hook output format) is fully in place.

**Q: How can we best implement this using hooks?**

**A:** Use the `UserPromptSubmit` hook:
1. Create `prompt-enrich` CLI command
2. Read user prompt from stdin, generate embedding
3. Search for relevant synthesis nodes (minScore 0.5+)
4. Output 4 one-liners in `additionalContext` (~200 tokens)
5. Add hook to hooks.json with 3-second timeout

**Q: How do we ensure accuracy/relevance of the injected context?**

**A:** Multiple strategies:
1. **Higher similarity threshold** (0.5+ instead of 0.3)
2. **Node type filtering** based on prompt keywords
3. **Session deduplication** - don't re-inject SessionStart nodes
4. **Progressive disclosure** - inject one-liners, let Claude unfold
5. **Metrics tracking** - monitor which injections lead to unfolds

---

*Oracle #2 Investigation Complete*
