# Epic 4: Memory Types System

**Epic ID:** TR3-EPIC-004
**Priority:** P0
**Dependencies:** Epic 3 (Active Retrieval) Issues 3.1-3.3 complete

## Epic Description

Implement specialized memory types inspired by MIRIX's memory taxonomy, adapted for code conversation context. This includes Core Memory (always-visible persona/human blocks), Episodic Memory (temporal events), and Semantic Memory (entity deduplication).

## Why This Matters

- **Core Memory:** Always-injected context prevents Claude from "forgetting" user preferences
- **Episodic Memory:** Structured temporal events for "what happened last week?" queries
- **Semantic Memory:** Entity deduplication prevents knowledge fragmentation
- **MIRIX Gap:** We're missing 4 of 6 memory types from MIRIX

## Memory Type Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      MEMORY TYPES                               │
├─────────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────────────┐   │
│  │            CORE MEMORY (Always Visible)                 │   │
│  │  ┌─────────────────┐  ┌─────────────────────────────┐  │   │
│  │  │     Persona     │  │           Human            │  │   │
│  │  │ - Agent config  │  │ - User preferences        │  │   │
│  │  │ - Behavior      │  │ - Project contexts        │  │   │
│  │  │ - Constraints   │  │ - Team/org knowledge      │  │   │
│  │  └─────────────────┘  └─────────────────────────────┘  │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │           EPISODIC MEMORY (Temporal Events)             │   │
│  │  - Time-ordered events with temporal_order index        │   │
│  │  - Session boundaries and milestones                    │   │
│  │  - Cross-session temporal links                         │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │           SEMANTIC MEMORY (Entities/Concepts)           │   │
│  │  - Deduplicated entity nodes                           │   │
│  │  - Alias resolution (JWT → JSON Web Token)             │   │
│  │  - Knowledge consolidation                             │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │           SYNTHESIS MEMORY (Existing Types)             │   │
│  │  - decision, learning, task, summary                   │   │
│  │  - Enhanced with type-specific handlers                │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

## Sub-Issues

| # | Title | Complexity | Dependencies |
|---|-------|------------|--------------|
| 4.1 | Implement Core Memory table with always-inject behavior | M | Epic 1-2 |
| 4.2 | Implement Episodic Memory with temporal ordering and event tracking | L | Epic 1-2, 4.1 |
| 4.3 | Implement Semantic Memory with entity deduplication and alias resolution | L | 4.1 |
| 4.4 | Create unified memory type handler architecture | M | 4.1, 4.2, 4.3 |
| 4.5 | Comprehensive test suite for Memory Types system | M | 4.1-4.4 |

## MCP Tools

```typescript
// Set Core Memory block
synthesis_core_memory_set({
  block_type: "persona",
  content: "Always use TypeScript strict mode. Prefer functional programming."
})

// Read Core Memory blocks
synthesis_core_memory_get()
```

## Entity Resolution Algorithm

1. Check exact alias match
2. Check embedding similarity to existing entities (threshold: 0.9)
3. If high match, add as alias
4. If no match, create new entity

## Acceptance Criteria

- [ ] Core Memory injection in 100% of sessions
- [ ] Entity deduplication rate >30% (fewer duplicate entities)
- [ ] Temporal query support with <100ms latency
- [ ] "What happened before X?" queries work
- [ ] "JWT" and "JSON Web Token" resolve to same entity

---

*Part of [Total Recall v3 Architecture RFC](https://github.com/Cygnusfear/dockram/issues/233)*
