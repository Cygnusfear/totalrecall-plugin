# Oracle #1: Message Enrichment Investigation

## Initial Hypotheses

At the start of this investigation, I formed the following hypotheses:

1. **Current State Hypothesis**: Total Recall likely already injects some context at session start via hooks, but probably NOT on every message. The system appears to be session-level, not message-level.

2. **Hook Architecture Hypothesis**: Claude Code's hook system should support `UserPromptSubmit` hooks that could enrich individual messages. There may also be an "assistant-response" hook or similar.

3. **Implementation Path Hypothesis**: The cleanest approach would be to leverage the existing `synthesis_search` vector search to find ~200 tokens of relevant context per message.

4. **Relevance Challenge Hypothesis**: The key technical challenge will be determining WHAT context is relevant - semantic search alone may not be sufficient.

---

## Research Path

### Avenue 1: Understanding Current Implementation

**Files Examined:**
- `/Users/alexander/Projects/totalrecall-plugin/src/mcp-server.ts` (lines 1-1002)
- `/Users/alexander/Projects/totalrecall-plugin/src/db.ts` (lines 1-793)
- `/Users/alexander/Projects/totalrecall-plugin/src/schema.ts` (lines 1-103)
- `/Users/alexander/Projects/totalrecall-plugin/src/embeddings.ts` (lines 1-99)
- `/Users/alexander/Projects/totalrecall-plugin/hooks/hooks.json` (lines 1-44)
- `/Users/alexander/Projects/totalrecall-plugin/src/cli/session-graft.ts` (lines 1-62)

**Key Findings:**

1. **Current context injection happens ONLY at session start**, not per-message:
   - `SessionStart` hook calls `session-graft` which queries recent nodes and outputs `additionalContext`
   - The context is wrapped in `<total_recall_context>` tags
   - This provides ~50-100 tokens of one-liners from recent synthesis nodes

2. **No `UserPromptSubmit` hook exists currently**:
   - `hooks.json` only defines: `SessionStart`, `Stop`, `SessionEnd`
   - No per-message enrichment implemented

3. **Vector search infrastructure exists and is performant**:
   - `synthesis_search` tool in `mcp-server.ts:441-519`
   - Uses `all-MiniLM-L6-v2` (384-dim embeddings) via `@xenova/transformers`
   - Search latency logged for analytics (target: <100ms)
   - Returns scored results with `node_id`, `one_liner`, `node_type`

---

### Avenue 2: Claude Code Hook Capabilities

**Research Method:** WebSearch + WebFetch on official documentation

**Key Findings:**

1. **`UserPromptSubmit` hook is fully supported**:
   - Fires when user submits a prompt, BEFORE Claude processes it
   - Input JSON includes: `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `prompt`
   - Output can include `additionalContext` to enrich the message

2. **Two methods for context injection**:
   ```json
   // Method 1: Plain text stdout (simpler)
   echo "Context here"
   exit 0
   
   // Method 2: JSON with additionalContext (structured)
   {
     "hookSpecificOutput": {
       "hookEventName": "UserPromptSubmit",
       "additionalContext": "Context to inject"
     }
   }
   ```

3. **No explicit assistant-response hook exists**:
   - `Stop` hook fires when main agent finishes
   - `SubagentStop` fires when subagent finishes
   - `PostToolUse` fires after tool execution
   - None of these provide a clean way to enrich Claude's response BEFORE it's shown

4. **Critical insight**: Context injection is APPEND-only for UserPromptSubmit. There's no "prepend" capability. This means context will appear AFTER the user's prompt in the conversation flow.

---

### Avenue 3: Exploring Synthesis Node Structure

**Files Examined:**
- `/Users/alexander/Projects/totalrecall-plugin/src/schema.ts`
- `/Users/alexander/Projects/totalrecall-plugin/src/llm-synthesis.ts` (lines 1-671)
- `/Users/alexander/Projects/totalrecall-plugin/skills/memory-protocol/SKILL.md`

**Key Findings:**

1. **Synthesis nodes have 3-tier progressive disclosure**:
   - `one_liner`: ~50 tokens, for scanning
   - `summary`: ~200 tokens, key points
   - `full_synthesis`: 300-500 tokens, complete context

2. **The 200-token target aligns perfectly with `summary` field**:
   - Each synthesis node already has a `summary` field designed for this exact purpose
   - Returning 1 node's `summary` = ~200 tokens
   - Or 3-4 `one_liner` results = ~150-200 tokens

3. **Node types provide semantic categorization**:
   - `decision`, `learning`, `entity`, `event`, `task`, `summary`
   - Could filter by type based on prompt analysis

---

### Avenue 4: Relevance & Accuracy Strategies

**Research Method:** Analysis of existing search infrastructure + best practices

**Key Findings:**

1. **Vector search is the primary relevance mechanism**:
   - `searchByVector()` in `db.ts:293-344`
   - Returns `score` (cosine similarity) for each result
   - `min_score` parameter (default 0.3) filters low-relevance noise

2. **Current recency bias in SessionStart**:
   - `session-graft.ts:27` queries by `last_updated DESC`
   - No semantic filtering - just most recent

3. **Potential relevance enhancement strategies**:
   - **Semantic search on user prompt**: Generate embedding of user message, search synthesis
   - **Hybrid scoring**: Combine semantic similarity + recency + access_count
   - **Type filtering**: Match decision-type prompts with decision nodes
   - **Session affinity**: Boost nodes from current session
   - **Entity extraction**: If prompt mentions specific entities, boost matching nodes

4. **Accuracy concerns**:
   - False positives: Semantically similar but irrelevant context
   - Stale context: Old decisions that have been superseded
   - Context pollution: Injecting noise degrades Claude's performance

---

### Avenue 5: Implementation Architecture Options

**Analysis of Trade-offs:**

**Option A: Synchronous CLI Hook (Simple)**
```json
{
  "hooks": {
    "UserPromptSubmit": [{
      "hooks": [{
        "type": "command",
        "command": "${CLAUDE_PLUGIN_ROOT}/cli/totalrecall.js enrich-prompt",
        "timeout": 2
      }]
    }]
  }
}
```

**Pros:**
- Simple implementation
- Reads prompt from stdin, searches, outputs context

**Cons:**
- Cold start latency (~1-2s for embedding model)
- Blocks user prompt processing
- 2s timeout is tight for embedding generation

**Option B: Pre-loaded MCP Tool Call (Complex)**
- Claude calls `synthesis_get_context(task_context=<prompt>)` automatically
- Requires skill/prompt engineering to enforce

**Pros:**
- No cold start (MCP server already running)
- More control over what context to fetch

**Cons:**
- Relies on Claude following instructions
- Uses Claude's context budget for tool call

**Option C: Background Service with Cache (Scalable)**
- Separate daemon pre-computes context suggestions
- Hook fetches from cache instead of computing

**Pros:**
- Fast response (<50ms)
- Can pre-compute on session start

**Cons:**
- Complex architecture
- Stale cache risk

---

## Dead Ends Encountered

### Dead End 1: Assistant Response Hook
Initially searched for a hook that fires AFTER Claude generates a response. This would have allowed enriching Claude's responses with memory context. **Finding: No such hook exists in Claude Code.** The `Stop` hook fires when Claude stops, but doesn't provide a mechanism to modify or annotate the response.

### Dead End 2: PostToolUse for Context Injection
Explored whether `PostToolUse` could be used to inject context. **Finding: While PostToolUse supports `additionalContext`, it only fires AFTER tool execution, not at response generation.** It could theoretically inject context into the conversation, but the timing is wrong for enriching every message.

### Dead End 3: Transcript-Based Context
Considered reading the full transcript (`TRANSCRIPT_PATH`) to understand conversation flow and inject relevant context. **Finding: While technically possible, this would be expensive (parse JSONL, analyze full conversation) and creates circular dependency problems.**

---

## Key Discoveries

### Discovery 1: `UserPromptSubmit` is the Right Hook
The `UserPromptSubmit` hook provides exactly the capability needed:
- Fires on every user message
- Can access the prompt text
- Can inject `additionalContext` 
- Timeout configurable (default 60s, can set lower)

Evidence: Official docs confirm this hook type and `additionalContext` behavior.

### Discovery 2: Cold Start is the Main Challenge
The embedding model (`all-MiniLM-L6-v2`) takes ~1-2 seconds to load on first call. For a synchronous hook with 2-5 second timeout, this is problematic.

**Mitigation strategies identified:**
1. Pre-load embeddings at session start (already done in `initEmbeddings()`)
2. Keep a warm process running (daemon)
3. Use text-based heuristics as fallback
4. Cache recent embeddings

### Discovery 3: 200 Token Budget Aligns with Summary Field
The system already stores ~200 token `summary` fields for each synthesis node. This means:
- Returning 1 highly relevant node's summary = perfect fit
- Or 3-4 one-liners for broader coverage

### Discovery 4: Accuracy Requires Multi-Signal Relevance
Pure semantic search can surface false positives. Recommended signals:
1. **Semantic similarity** (primary) - cosine score from vector search
2. **Recency** - boost recently updated nodes
3. **Access frequency** - nodes accessed often are likely important
4. **Session affinity** - current session nodes are more relevant
5. **Type matching** - match prompt intent to node type

---

## Synthesis: Answer to Core Question

### Q1: Do we already do this in the totalrecall-plugin codebase?

**NO.** Current implementation only injects context at `SessionStart`, not per-message. The existing hook (`session-graft.ts`) queries recent nodes and outputs:

```
<total_recall_context>
Recent memories:
- [decision] One-liner 1
- [learning] One-liner 2
...
</total_recall_context>
```

This happens ONCE at session start, not on every user message.

### Q2: How can we best implement this using hooks?

**Recommended Implementation:**

1. **Add `UserPromptSubmit` hook** to `hooks.json`:
```json
{
  "hooks": {
    "UserPromptSubmit": [{
      "hooks": [{
        "type": "command",
        "command": "${CLAUDE_PLUGIN_ROOT}/cli/totalrecall.js enrich-message",
        "timeout": 3
      }]
    }],
    // ... existing hooks
  }
}
```

2. **Create `enrich-message.ts` CLI command**:
```typescript
// Pseudo-implementation
async function main() {
  // Read prompt from stdin
  const input = JSON.parse(await readStdin());
  const prompt = input.prompt;
  
  // Generate embedding (use cached model)
  const embedding = await generateEmbedding(prompt);
  
  // Search for relevant synthesis
  const results = db.searchByVector(embedding, 3, 0.5);
  
  // Format context (~200 tokens)
  const context = formatContext(results);
  
  // Output for hook
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: context
    }
  }));
}
```

3. **Consider warm process optimization**:
   - Session-start spawns background process
   - `enrich-message` communicates via IPC/socket
   - Avoids cold-start embedding latency

### Q3: How do we ensure accuracy/relevance of the injected context?

**Multi-Signal Relevance Scoring:**

```typescript
function scoreRelevance(node: SynthesisNode, semanticScore: number, prompt: string): number {
  let score = semanticScore;
  
  // Boost recent nodes (decay over 24h)
  const ageHours = (Date.now() - node.last_updated) / (1000 * 60 * 60);
  const recencyBoost = Math.max(0, 1 - (ageHours / 24)) * 0.2;
  
  // Boost frequently accessed nodes
  const accessBoost = Math.min(node.access_count / 100, 0.15);
  
  // Boost same-session nodes
  const sessionBoost = node.source_session_id === currentSession ? 0.1 : 0;
  
  // Type matching (if detectable from prompt)
  const typeBoost = matchesPromptIntent(node.node_type, prompt) ? 0.1 : 0;
  
  return score + recencyBoost + accessBoost + sessionBoost + typeBoost;
}
```

**Quality Safeguards:**
1. **Minimum score threshold**: Only inject if score > 0.5
2. **Fallback to none**: If no good matches, inject nothing (avoid noise)
3. **Staleness detection**: Check if nodes have `contradicts` edges
4. **User control**: Allow disabling via env var `TOTALRECALL_ENRICH=false`

---

## Confidence Assessment

### High Confidence:
- `UserPromptSubmit` hook is the correct mechanism for per-message enrichment
- Current implementation does NOT do per-message enrichment
- The `summary` field (~200 tokens) is the right granularity
- Vector search infrastructure is ready to use

### Medium Confidence:
- Cold start latency can be mitigated with warm process
- Multi-signal relevance scoring will improve accuracy
- 2-3 second timeout is achievable with optimization

### Low Confidence:
- Optimal relevance scoring weights (need experimentation)
- Whether users will find injected context helpful vs noisy
- Performance impact on large synthesis graphs (>10k nodes)

---

## Divergent Possibilities

### Alternative 1: Claude-Initiated Search
Instead of hook-based injection, rely on Claude calling `synthesis_search` proactively. Enforce via skill instructions.

**Tradeoff:** Less consistent but avoids hook latency. Relies on Claude compliance.

### Alternative 2: Contextual Sidebar (UI-based)
Instead of injecting into prompt, show relevant context in a sidebar/panel that user can reference.

**Tradeoff:** Requires Claude Code UI changes. Not achievable via plugin alone.

### Alternative 3: Selective Enrichment
Only enrich prompts that "look like" they need context (questions, debugging, decisions).

**Tradeoff:** Reduces noise but may miss important enrichment opportunities.

### Alternative 4: Two-Phase Enrichment
1. Quick heuristic pass (recency + keywords) for immediate context
2. Async semantic search that adds context in follow-up

**Tradeoff:** Complex but avoids blocking on embedding generation.

---

## Recommended Actions

### Immediate (MVP):
1. **Create `enrich-message.ts`** CLI command with basic semantic search
2. **Add `UserPromptSubmit` hook** to `hooks.json` with 3s timeout
3. **Test latency** on cold and warm starts
4. **Add `TOTALRECALL_ENRICH` toggle** for user control

### Short-term (Quality):
1. **Implement multi-signal relevance scoring**
2. **Add embedding cache** for common queries
3. **Track analytics** via `progressive_disclosure_events` table
4. **Add staleness detection** for contradicted nodes

### Medium-term (Scalability):
1. **Warm process architecture** to eliminate cold starts
2. **Query optimization** for large graphs
3. **User feedback loop** to tune relevance

---

## File Evidence Summary

| Finding | Evidence Location |
|---------|-------------------|
| No per-message enrichment | `/Users/alexander/Projects/totalrecall-plugin/hooks/hooks.json:1-44` |
| SessionStart injects context | `/Users/alexander/Projects/totalrecall-plugin/src/cli/session-graft.ts:26-48` |
| Vector search ready | `/Users/alexander/Projects/totalrecall-plugin/src/db.ts:293-344` |
| Embeddings available | `/Users/alexander/Projects/totalrecall-plugin/src/embeddings.ts:22-36` |
| Summary field ~200 tokens | `/Users/alexander/Projects/totalrecall-plugin/src/mcp-server.ts:58-60` |
| Progressive disclosure events | `/Users/alexander/Projects/totalrecall-plugin/src/db.ts:700-731` |

---

*Oracle #1 investigation complete. Ready for Delphi synthesis.*
