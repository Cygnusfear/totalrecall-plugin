# Epic 1: Storage Migration (SQLite to PostgreSQL + VectorChord)

**Epic ID:** TR3-EPIC-001
**Priority:** P0 - Critical Path
**Dependencies:** None (foundation epic)

## Epic Description

Migrate Total Recall's storage layer from SQLite + sqlite-vec to PostgreSQL with the VectorChord Suite (VectorChord, VectorChord-BM25, pg_tokenizer.rs). This includes schema design, connection management, data migration tooling, and backwards-compatible API preservation.

## Why This Matters

- **Shared State:** Multiple agents on bhakti can't reliably share SQLite state
- **VectorChord:** 5x faster queries and 16x higher insert throughput vs pgvector
- **RaBitQ Quantization:** Enables 100M vectors in 32GB memory
- **Foundation:** Required for all subsequent phases

## Sub-Issues

| # | Title | Complexity | Dependencies |
|---|-------|------------|--------------|
| 1.1 | Design PostgreSQL schema with VectorChord Suite extensions | M | None |
| 1.2 | Create Docker Compose configuration for VectorChord Suite | S | None |
| 1.3 | Implement PostgreSQL connection pool with transaction support | M | 1.2 |
| 1.4 | Create database abstraction layer supporting both SQLite and PostgreSQL | L | 1.3 |
| 1.5 | Implement VectorChord vector operations replacing sqlite-vec | M | 1.4 |
| 1.6 | Create SQLite to PostgreSQL data migration tooling | L | 1.4, 1.5 |
| 1.7 | Implement configuration system for multi-backend support | M | None |
| 1.8 | Create comprehensive integration tests for storage migration | M | 1.4 |

## Critical Path

```
1.2 (Docker) -> 1.3 (Pool) -> 1.4 (Abstraction) -> 1.5 (Vector)
                                      |
1.1 (Schema) -------------------------+
                                      |
                     1.6 (Migration) -+-> Epic 1 Complete
                                      |
                     1.7 (Config) ----+
                     1.8 (Tests) -----+
```

## Docker Stack

```bash
docker run --name vchord-suite \
  -e POSTGRES_PASSWORD=postgres \
  -p 5432:5432 \
  -d tensorchord/vchord-suite:pg18-latest
```

## Acceptance Criteria

- [ ] PostgreSQL backend available as alternative to SQLite
- [ ] All MCP tool APIs maintain same signatures
- [ ] Migration script handles 100k+ node databases
- [ ] SQLite backend remains supported for existing users
- [ ] Search returns identical results (±0.01 score tolerance)

## Migration Strategy

1. SQLite backend remains supported for existing users
2. All MCP tool APIs maintain same signatures
3. Configuration defaults to SQLite if no PostgreSQL configured
4. Original SQLite file preserved as backup during migration

---

*Part of [Total Recall v3 Architecture RFC](https://github.com/Cygnusfear/dockram/issues/233)*
