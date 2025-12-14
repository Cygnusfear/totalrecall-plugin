# Epic 5: Consolidation & Advanced Features

**Epic ID:** TR3-EPIC-005
**Priority:** P1
**Dependencies:** Epics 1-4 complete

## Epic Description

Implement multi-hop fact merging, temporal queries, conflict detection, and memory decay to complete the advanced memory capabilities. These features address the remaining LOCOMO benchmark gaps.

## Why This Matters

- **Multi-hop Reasoning:** +22 pts on LOCOMO multi-hop questions
- **Temporal Reasoning:** 73% human gap for temporal questions - key differentiator
- **Memory Health:** Prevent unbounded growth, detect contradictions
- **Production Ready:** Dashboard for operators

## Sub-Issues

| # | Title | Complexity | Dependencies |
|---|-------|------------|--------------|
| 5.1 | Implement multi-hop fact merging for complex queries | L | Epic 2, 4 |
| 5.2 | Add temporal query support for time-based memory retrieval | L | Epic 1 |
| 5.3 | Implement entity deduplication and contradiction detection | M | Epic 3 |
| 5.4 | Implement memory decay scoring and archival mechanisms | M | Epic 4 |
| 5.5 | Add consolidation analytics and memory health dashboard | S | 5.3, 5.4 |

## Multi-hop Consolidation

When user asks "What decisions led to the current architecture?":
1. Identify seed nodes from initial query
2. Follow edges to related nodes (1-2 hops)
3. Merge and rank facts by relevance
4. Generate consolidated response

## Temporal Query Syntax

```
after:YYYY-MM-DD
before:YYYY-MM-DD
during:YYYY-MM
last_week
this_month
past_30_days
```

## Memory Decay Formula

```
relevance = base_score * e^(-lambda * days_since_access)
```

- Configurable lambda
- Core Memory exempt from decay
- Archival threshold configurable

## Conflict Detection

- Identify when nodes contradict each other
- Resolution options: supersede, merge, keep_both, archive_older
- Audit trail for resolutions

## Acceptance Criteria

- [ ] Multi-hop consolidation returns coherent merged answers
- [ ] Temporal queries work: "What was I working on last week?"
- [ ] Contradictions detected and flagged
- [ ] Memory decay prevents unbounded growth
- [ ] Health dashboard shows graph stats, decay status, conflicts

---

*Part of [Total Recall v3 Architecture RFC](https://github.com/Cygnusfear/dockram/issues/233)*
