# Epic 3: Active Retrieval System

**Epic ID:** TR3-EPIC-003
**Priority:** P0
**Dependencies:** Epic 2 (Hybrid Search) should be substantially complete

## Epic Description

Implement MIRIX-inspired Active Retrieval pattern to improve context relevance. The core insight from MIRIX is that topic inference before search significantly improves retrieval precision. Current Total Recall performs direct vector search on user prompts, which can miss relevant context when queries are indirect or conversational.

## Why This Matters

- **+22 pts LOCOMO:** Active retrieval is the biggest factor in MIRIX's multi-hop score
- **Conversational Queries:** User says "the auth thing we discussed" - topic inference extracts ["authentication", "session management", "JWT decision"]
- **Memory Type Routing:** Different queries should target different memory types

## Target Architecture

```
User Prompt → Topic Inference (Haiku) → Query Generation
                                             ↓
                                   Route to Memory Types
                                             ↓
                        ┌────────────────────┼────────────────────┐
                        ↓                    ↓                    ↓
                   Core Memory         Synthesis Memory      Episodic Memory
                        ↓                    ↓                    ↓
                        └────────────────────┼────────────────────┘
                                             ↓
                               Merge + Deduplicate + Score
                                             ↓
                               Tag Results by Source Type
                                             ↓
                               Inject into Context
```

## Sub-Issues

| # | Title | Complexity | Dependencies |
|---|-------|------------|--------------|
| 3.1 | Implement topic generation service using Haiku for query inference | M | None |
| 3.2 | Implement query router to dispatch searches across memory types | M | 3.1, 4.4 |
| 3.3 | Implement source attribution tags for injected context | S | None |
| 3.4 | Refactor prompt-enrich to use Active Retrieval pipeline | L | 3.1, 3.2, 3.3, 4.1 |
| 3.5 | Comprehensive test suite for Active Retrieval pipeline | M | 3.1-3.4 |

## Context Injection Format

**Current:**
```xml
<total_recall_relevant>
Relevant memories for your query:
- [decision] JWT tokens should expire after 1 hour (abc123)
</total_recall_relevant>
```

**Target:**
```xml
<total_recall_context>
<core_memory type="persona">
You prefer TypeScript with strict mode enabled.
</core_memory>

<retrieved_memories>
<memory type="decision" source="session:xyz789" confidence="0.92" age="2d">
JWT tokens should expire after 1 hour
</memory>
</retrieved_memories>
</total_recall_context>
```

## Acceptance Criteria

- [ ] Topic inference runs in <200ms via Haiku
- [ ] Query router dispatches to appropriate memory types
- [ ] Core memory always injected (if exists)
- [ ] Total latency target: <500ms
- [ ] Graceful degradation to simple search if pipeline fails
- [ ] Topic inference accuracy >80% (manual evaluation)

---

*Part of [Total Recall v3 Architecture RFC](https://github.com/Cygnusfear/dockram/issues/233)*
