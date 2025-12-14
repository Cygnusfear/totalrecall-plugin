# Epic 6: DevOps & Infrastructure

**Epic ID:** TR3-EPIC-006
**Priority:** P1
**Dependencies:** Can run in parallel with Phase 5

## Epic Description

Establish production-grade infrastructure for deployment, monitoring, and continuous integration. This ensures Total Recall v3 is ready for production use.

## Why This Matters

- **Consistent Deployment:** Docker enables reproducible environments
- **Safe Migrations:** Schema changes need proper migration framework
- **Quality Gates:** CI/CD prevents regressions
- **Observability:** Production debugging requires structured logging

## Sub-Issues

| # | Title | Complexity | Dependencies |
|---|-------|------------|--------------|
| 6.1 | Create Docker configuration for Total Recall | M | None |
| 6.2 | Create database initialization and schema migration system | M | 5.2, 5.4 |
| 6.3 | Implement GitHub Actions CI/CD pipeline | M | 7.1 |
| 6.4 | Add structured logging, metrics, and tracing | M | None |
| 6.5 | Create comprehensive documentation and operational runbooks | M | All other issues |

## Docker Architecture

```
totalrecall-plugin/
├── Dockerfile              # Production build
├── Dockerfile.dev          # Development with hot reload
├── docker-compose.yml      # Multi-service setup
├── docker-compose.dev.yml  # Development overrides
├── docker-compose.pg.yml   # PostgreSQL/VectorChord variant
└── .dockerignore
```

## Migration Framework

```
migrations/
├── 001_initial_schema.sql
├── 001_initial_schema.down.sql
├── 002_add_fts5.sql
├── 002_add_fts5.down.sql
├── 003_temporal_columns.sql
├── 003_temporal_columns.down.sql
├── 004_core_memory.sql
├── 004_core_memory.down.sql
├── 005_archive_table.sql
└── 005_archive_table.down.sql
```

## CI Pipeline

```yaml
name: CI
on: [push, pull_request]
jobs:
  test:
    strategy:
      matrix:
        os: [ubuntu-latest, macos-latest]
        bun-version: [1.0, 1.1]
    steps:
      - checkout
      - setup-bun
      - install dependencies
      - run lint
      - run typecheck
      - run tests
      - upload coverage
```

## Observability

- Structured JSON logging
- Log levels: debug, info, warn, error
- Performance metrics: search_latency_ms, synthesis_duration_ms
- Optional Prometheus endpoint
- Optional OpenTelemetry traces
- Sensitive data redaction

## Acceptance Criteria

- [ ] `docker-compose up` starts working Total Recall
- [ ] `totalrecall migrate` handles schema changes
- [ ] CI runs on all PRs
- [ ] Structured logs with context
- [ ] Documentation complete

---

*Part of [Total Recall v3 Architecture RFC](https://github.com/Cygnusfear/dockram/issues/233)*
