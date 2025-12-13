# Delphi Synthesis: Message Enrichment for Total Recall

**Synthesis Date:** 2025-12-11  
**Oracles Consulted:** 3  
**Synthesis Author:** Claude (Opus 4.5)

---

## Executive Summary

Three independent oracle investigations converged on the same core findings regarding message enrichment for Total Recall. The current implementation injects context only at `SessionStart` via the `session-graft.ts` command, which provides approximately 50-100 tokens of recent synthesis node one-liners. **No per-message enrichment exists.**

All three oracles independently identified the `UserPromptSubmit` hook as the correct mechanism for implementing per-message enrichment. This hook fires before Claude processes each user message and supports the same `additionalContext` JSON output format already used by the SessionStart hook. The vector search infrastructure (sqlite-vec, all-MiniLM-L6-v2 embeddings) is fully operational and ready to support semantic relevance-based context injection.

The recommended implementation is straightforward: create a new `prompt-enrich` CLI command that performs semantic search against the user's message and returns approximately 200 tokens (3-4 one-liners) of relevant synthesis nodes. The primary challenges are cold-start latency for the embedding model and ensuring relevance accuracy through appropriate similarity thresholds and multi-signal scoring.

---

## Convergent Findings

These findings were independently confirmed by all three oracles, representing the highest confidence conclusions:

### 1. Current State: Session-Only Context Injection

**All oracles confirmed:** Total Recall currently injects context ONLY at `SessionStart`, not per-message.

**Evidence:**
- `/Users/alexander/Projects/totalrecall-plugin/hooks/hooks.json` - No `UserPromptSubmit` hook configured
- `/Users/alexander/Projects/totalrecall-plugin/src/cli/session-graft.ts:36-49` - Only hook implementation

**Current output format:**
```
<total_recall_context>
Recent memories:
- [decision] One-liner 1
- [learning] One-liner 2
...
Use synthesis_unfold(node_id) to expand any node.
Use synthesis_search(query) to find specific context.
</total_recall_context>
```

### 2. UserPromptSubmit is the Correct Hook

**All oracles independently identified:** `UserPromptSubmit` as the mechanism for per-message enrichment.

**Key characteristics confirmed by all:**
- Fires on EVERY user message submission
- Runs BEFORE Claude processes the prompt
- Can output `additionalContext` via JSON (same format as SessionStart)
- Configurable timeout (recommend 3 seconds)
- Exit code 0 adds context, exit code 2 blocks prompt

### 3. Vector Search Infrastructure is Ready

**All oracles confirmed:** The semantic search capability is fully operational.

**Evidence:**
- `/Users/alexander/Projects/totalrecall-plugin/src/db.ts:293-344` - `searchByVector()` method
- `/Users/alexander/Projects/totalrecall-plugin/src/embeddings.ts` - `all-MiniLM-L6-v2` (384-dim)
- `/Users/alexander/Projects/totalrecall-plugin/src/mcp-server.ts:441-519` - `synthesis_search` tool

**Capabilities:**
- sqlite-vec for fast vector similarity search (<10ms)
- Configurable `minScore` threshold
- Node type filtering available
- Returns `node_id`, `one_liner`, `score`, `node_type`

### 4. Token Budget Alignment

**All oracles agreed:** ~200 tokens = 3-4 synthesis one-liners

**Breakdown:**
- Each `one_liner`: ~50 tokens
- Each `summary`: ~200 tokens
- Each `full_synthesis`: 300-500 tokens

**Recommended allocation:** 3-4 one-liners (~150-200 tokens) + instruction hint (~50 tokens)

### 5. Dead Ends (Confirmed Non-Paths)

**All oracles independently discovered these don't work:**

| Dead End | Finding |
|----------|---------|
| Assistant Response Hook | No such hook exists in Claude Code |
| PostToolUse for Context Injection | Wrong timing - fires AFTER tool execution, not at response generation |
| Shell-based Hooks | Legacy implementation; TypeScript CLI is the current pattern |
| Transcript-Based Analysis | Expensive and creates circular dependencies |

---

## Divergent Findings

### 1. Similarity Threshold

| Oracle | Recommended Threshold |
|--------|----------------------|
| Oracle 1 | 0.5 (firm minimum) |
| Oracle 2 | 0.5+ |
| Oracle 3 | 0.4-0.5 (starting range) |

**Analysis:** Minor divergence. All agree the current default of 0.3 is too permissive and will produce false positives. Oracle 3's lower bound of 0.4 may catch more relevant context but risks noise. 

**Resolution:** Start with 0.5, tune based on empirical feedback. Add configuration option for user control.

### 2. How to Access User Message in Hook

| Oracle | Method |
|--------|--------|
| Oracle 1 | JSON on stdin with `prompt` field |
| Oracle 2 | JSON on stdin with `prompt` field |
| Oracle 3 | Read from transcript file |

**Analysis:** Oracles 1 and 2 believe the prompt is passed directly via stdin JSON. Oracle 3 suggests reading the transcript file. This is a documentation interpretation difference.

**Resolution:** The official Claude Code hooks documentation indicates stdin JSON contains the prompt. However, the hook also receives `transcript_path` as fallback. Implementation should try stdin first, transcript as fallback.

### 3. Cold Start Emphasis

| Oracle | Cold Start Concern Level |
|--------|-------------------------|
| Oracle 1 | HIGH - identified as main challenge |
| Oracle 2 | MEDIUM - mentioned as caveat |
| Oracle 3 | LOW - noted embeddings are pre-loaded |

**Analysis:** Different emphasis but consistent understanding. Embeddings ARE pre-loaded during MCP server startup (`initEmbeddings()`), but the CLI command runs in a separate process from the MCP server.

**Resolution:** This is a real concern. Mitigations include:
1. Pre-load embeddings at session start (background process)
2. Warm process architecture with IPC
3. Accept first-message latency as acceptable trade-off
4. Use heuristic fallback (keyword/recency) if embedding times out

---

## Unique Discoveries

### Oracle 1: Multi-Signal Relevance Scoring

Proposed sophisticated relevance scoring formula:
```typescript
function scoreRelevance(node, semanticScore, prompt) {
  let score = semanticScore;
  
  // Recency boost (decay over 24h)
  const ageHours = (Date.now() - node.last_updated) / (1000 * 60 * 60);
  const recencyBoost = Math.max(0, 1 - (ageHours / 24)) * 0.2;
  
  // Frequency boost
  const accessBoost = Math.min(node.access_count / 100, 0.15);
  
  // Session affinity
  const sessionBoost = node.source_session_id === currentSession ? 0.1 : 0;
  
  // Type matching
  const typeBoost = matchesPromptIntent(node.node_type, prompt) ? 0.1 : 0;
  
  return score + recencyBoost + accessBoost + sessionBoost + typeBoost;
}
```

**Unique insights:**
- Staleness detection via `contradicts` edges
- "Warm process architecture" for eliminating cold starts
- Background Service with Cache as scalable option

### Oracle 2: Implementation Detail Focus

**Most detailed implementation code:**
- Complete `prompt-enrich.ts` pseudo-implementation
- Stdin reading with timeout fallback
- Alternative performance optimization with pre-computed embedding clusters

**Unique insights:**
- Deduplication concern between SessionStart and UserPromptSubmit context
- LLM-Based Relevance Filtering (use Haiku to pick 2-3 most relevant from 10 candidates)
- Two-Phase Enrichment (broad at SessionStart, narrow per-message)

### Oracle 3: Systematic Hook Analysis

**Comprehensive hook comparison table:**

| Hook | When | Useful for |
|------|------|------------|
| SessionStart | Session starts/resumes | Initial context (existing) |
| UserPromptSubmit | User submits prompt | User message enrichment (NEW) |
| PreToolUse | Before tool execution | Tool-specific context |
| PostToolUse | After tool completion | Follow-up context |
| Stop | Agent finishes responding | Capture output for synthesis (existing) |
| SessionEnd | Session ends | Summary creation (existing) |

**Unique insights:**
- PostToolUse for tool-specific context (file-specific past decisions)
- ADR analysis confirming per-message enrichment wasn't in original design
- Hybrid approach: minimal hook injection + MCP tool for Claude to request more

---

## Composite Answer

### Question 1: Do we already do this in the totalrecall-plugin codebase?

**NO.** The codebase currently implements context injection at `SessionStart` only. The `session-graft.ts` command queries the 5 most recent synthesis nodes and outputs them as one-liners (~50-100 tokens) wrapped in `<total_recall_context>` tags. This happens ONCE per session, not per message. There is no `UserPromptSubmit` hook configured, and no per-message enrichment implementation exists.

### Question 2: How can we best implement this using hooks?

**Recommended Implementation:**

1. **Create `prompt-enrich.ts` CLI command:**
   - Read hook input from stdin (JSON with `prompt` field)
   - Generate embedding for user's message
   - Search for relevant synthesis nodes (limit 5, minScore 0.5)
   - Format top 3-4 results as one-liners (~200 tokens)
   - Output JSON with `additionalContext`

2. **Update `hooks/hooks.json`:**
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

3. **Add CLI entry point** in `cli/totalrecall.js`

4. **Output format:**
   ```
   <total_recall_relevant>
   Relevant memories for your query:
   - [decision] One-liner 1 (node_id)
   - [learning] One-liner 2 (node_id)
   - [entity] One-liner 3 (node_id)
   
   Use synthesis_unfold(node_id) for more detail.
   </total_recall_relevant>
   ```

### Question 3: How do we ensure accuracy/relevance of the injected context?

**Multi-Layer Relevance Strategy:**

1. **Primary: Semantic Similarity**
   - Use embedding similarity with minimum threshold 0.5
   - Sort by score, not recency

2. **Secondary: Multi-Signal Scoring**
   - Recency boost (decay over 24h): +0.2 max
   - Access frequency boost: +0.15 max
   - Session affinity boost: +0.1
   - Node type matching boost: +0.1

3. **Quality Safeguards**
   - Fallback to nothing if no good matches (avoid noise)
   - Staleness detection via `contradicts` edges
   - User control toggle: `TOTALRECALL_ENRICH=false`

4. **Progressive Disclosure**
   - Inject one-liners only
   - Include "Use synthesis_unfold(node_id) for details"
   - Let Claude request more if needed

5. **Deduplication**
   - Track nodes injected at SessionStart
   - Avoid re-injecting same nodes per-message

6. **Feedback Loop**
   - Track which injected nodes lead to `synthesis_unfold` calls
   - Use progressive_disclosure_events table for analytics

---

## Confidence Assessment

### High Confidence (All Oracles Agree)
- `UserPromptSubmit` is the correct hook mechanism
- Current implementation has NO per-message enrichment
- Vector search infrastructure is ready and fast (<100ms)
- ~200 token budget aligns with 3-4 one-liners
- The implementation approach is straightforward

### Medium Confidence (Most Oracles Agree)
- 3-second timeout is achievable with optimization
- Pre-loaded embeddings will mitigate cold start
- Multi-signal relevance scoring will improve accuracy
- Deduplication between SessionStart and UserPromptSubmit is needed

### Low Confidence (Speculation/Needs Testing)
- Optimal similarity threshold (0.4 vs 0.5 vs 0.6)
- User-perceived latency impact
- Whether repeated injection becomes noise vs signal
- Performance on large synthesis graphs (>10k nodes)
- Whether stdin reliably contains prompt or transcript parsing is needed

### Unknown (Requires Experimentation)
- Optimal relevance scoring weights
- Whether users find injected context helpful
- Best token allocation strategy
- Impact on Claude's response quality

---

## Recommended Actions

### Phase 1: MVP Implementation (Immediate)

1. **Create `src/cli/prompt-enrich.ts`**
   - Basic semantic search on user prompt
   - Output 3-4 one-liners (~200 tokens)
   - 3-second timeout safety

2. **Update `hooks/hooks.json`**
   - Add `UserPromptSubmit` hook calling `prompt-enrich`

3. **Update `cli/totalrecall.js`**
   - Register `prompt-enrich` command

4. **Add toggle**
   - `TOTALRECALL_ENRICH=true/false` environment variable

### Phase 2: Quality Improvements (Short-term)

5. **Implement multi-signal scoring**
   - Add recency, access frequency, session affinity boosts

6. **Add deduplication**
   - Track SessionStart nodes, skip in UserPromptSubmit

7. **Add metrics tracking**
   - Log enrichment latency, match scores, unfold correlation

8. **Tune similarity threshold**
   - Test 0.4, 0.5, 0.6 empirically

### Phase 3: Scalability (Medium-term)

9. **Warm process architecture**
   - Background daemon with IPC for instant embedding

10. **Query optimization**
    - Index tuning for large graphs

11. **Feedback loop**
    - Analyze which injections lead to unfolds

12. **User configuration**
    - Allow customization of token budget, threshold

---

## Appendix: Oracle Contributions

### Oracle 1 Contribution
- **Focus:** Architecture and implementation patterns
- **Unique value:** Multi-signal relevance scoring formula, warm process architecture, detailed alternative implementations
- **Key insight:** Cold start latency is the main technical challenge

### Oracle 2 Contribution
- **Focus:** Detailed implementation code and performance
- **Unique value:** Complete pseudo-implementation, deduplication concern, LLM-based filtering alternative
- **Key insight:** Need to handle deduplication between SessionStart and UserPromptSubmit

### Oracle 3 Contribution
- **Focus:** Systematic hook analysis and trade-offs
- **Unique value:** Comprehensive hook comparison table, ADR context, hybrid approach recommendation
- **Key insight:** PostToolUse could enable tool-specific context injection

---

## Key Files Referenced

| File | Purpose |
|------|---------|
| `/Users/alexander/Projects/totalrecall-plugin/hooks/hooks.json` | Current hook configuration (no UserPromptSubmit) |
| `/Users/alexander/Projects/totalrecall-plugin/src/cli/session-graft.ts` | Current SessionStart context injection |
| `/Users/alexander/Projects/totalrecall-plugin/src/db.ts:293-344` | `searchByVector()` implementation |
| `/Users/alexander/Projects/totalrecall-plugin/src/embeddings.ts` | Embedding generation with all-MiniLM-L6-v2 |
| `/Users/alexander/Projects/totalrecall-plugin/src/mcp-server.ts:441-519` | `synthesis_search` MCP tool |
| `/Users/alexander/Projects/totalrecall-plugin/src/db.ts:700-731` | Progressive disclosure events tracking |

---

*Delphi Synthesis Complete*
