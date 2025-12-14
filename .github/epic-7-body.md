# Epic 7: Testing & Quality

**Epic ID:** TR3-EPIC-007
**Priority:** P0
**Dependencies:** Can run in parallel with other epics

## Epic Description

Establish comprehensive test coverage and quality benchmarks to ensure reliability. This includes unit tests, integration tests, LOCOMO benchmarks, and performance testing.

## Why This Matters

- **Confidence:** Tests enable safe iteration
- **Validation:** LOCOMO benchmark validates retrieval quality
- **Performance:** Latency constraints must be verified
- **Migrations:** Schema changes need testing framework

## Sub-Issues

| # | Title | Complexity | Dependencies |
|---|-------|------------|--------------|
| 7.1 | Expand unit test coverage to 80%+ for core modules | L | None |
| 7.2 | Enhance integration tests with realistic scenarios | M | 5.1, 5.3 |
| 7.3 | Implement LOCOMO benchmark subset for quality validation | L | 5.1, 5.2 |
| 7.4 | Create performance benchmarks for latency and throughput | M | None |
| 7.5 | Create test framework for database migrations | M | 6.2 |

## Test Structure

```
test/
├── unit/
│   ├── db.test.ts
│   ├── embeddings.test.ts
│   ├── synthesis-worker.test.ts
│   ├── relationship-builder.test.ts
│   ├── llm-synthesis.test.ts
│   └── mcp-handlers.test.ts
├── integration/
│   └── integration.ts (existing)
├── e2e/
│   └── mcp-server.test.ts
├── fixtures/
│   ├── sample-nodes.json
│   └── sample-conversations.json
└── mocks/
    ├── llm-client.mock.ts
    └── database.mock.ts
```

## LOCOMO Benchmark Targets

| Category | Target Score |
|----------|-------------|
| Single-hop | 70%+ |
| Multi-hop | 50%+ |
| Temporal | 60%+ |

## Performance Targets

```
Search Latency (1000 queries):
  p50:  <30ms
  p95:  <100ms
  p99:  <200ms

Synthesis Throughput:
  Rate: >10 nodes/minute

Memory Usage:
  Peak: <256MB
```

## Integration Test Scenarios

1. **New user onboarding:** Empty DB, first session, Core Memory setup
2. **Multi-session project:** 3 sessions, cross-references, temporal queries
3. **High volume:** 100+ nodes, search performance
4. **Conflict detection and resolution**
5. **Memory decay and archival**

## Acceptance Criteria

- [ ] 80% line coverage, 70% branch coverage
- [ ] All integration scenarios pass
- [ ] LOCOMO scores meet targets
- [ ] P95 latency <100ms for search
- [ ] Migration tests cover upgrade paths

---

*Part of [Total Recall v3 Architecture RFC](https://github.com/Cygnusfear/dockram/issues/233)*
