# Epic 2: Hybrid Search (BM25 + Vector + pg_trgm)

**Epic ID:** TR3-EPIC-002
**Priority:** P0 - Critical Path
**Dependencies:** Epic 1 (Storage Migration) must be complete

## Epic Description

Implement hybrid search combining three ranking strategies: VectorChord semantic similarity, VectorChord-BM25 keyword ranking, and pg_trgm trigram matching for code identifiers. Results are fused using Reciprocal Rank Fusion (RRF) to produce a unified ranking.

## Why This Matters

- **Single-hop Precision:** BM25 catches exact keyword matches vector search misses
- **Code Identifiers:** pg_trgm handles camelCase, snake_case, partial matches
- **Industry Standard:** RRF fusion used by major search engines
- **LOCOMO Impact:** Hybrid search significantly improves retrieval quality

## Sub-Issues

| # | Title | Complexity | Dependencies |
|---|-------|------------|--------------|
| 2.1 | Integrate VectorChord-BM25 for keyword search | M | Epic 1 |
| 2.2 | Add pg_trgm trigram search for code identifiers | S | Epic 1 |
| 2.3 | Implement RRF fusion for combining multiple ranking systems | S | None |
| 2.4 | Orchestrate hybrid search combining all ranking systems | M | 2.1, 2.2, 2.3 |
| 2.5 | Update MCP search tools to use hybrid search | M | 2.4 |
| 2.6 | Update CLI search command for hybrid search | S | 2.5 |
| 2.7 | Create backfill script for BM25 vectors on existing data | S | 2.1 |
| 2.8 | Create search quality benchmarks comparing search modes | M | 2.4 |
| 2.9 | Create integration tests for hybrid search | M | 2.4 |

## Tokenizer Configuration

```sql
SELECT create_text_analyzer('memory_system', $$
pre_tokenizer = "unicode_segmentation"
[[character_filters]]
to_lowercase = {}
[[token_filters]]
stopwords = "nltk_english"
[[token_filters]]
stemmer = "english_porter2"
$$);
```

## RRF Formula

```
RRF_score(d) = Σ (weight_i / (k + rank_i(d)))
```

Where:
- d = document
- i = ranking system (vector, bm25, trigram)
- k = constant (typically 60)
- rank_i(d) = position of d in system i's results

## Acceptance Criteria

- [ ] SQLite backend: search works as before (vector only)
- [ ] PostgreSQL backend: hybrid search by default
- [ ] `search_mode: 'vector'` forces vector-only search
- [ ] Hybrid search improves NDCG@5 by >10% over vector-only
- [ ] Query latency <200ms for 10k nodes
- [ ] "handleSynth" matches "handleSynthesisCreate" via trigram

## Query Analysis Heuristics

- If query contains code identifiers (camelCase, snake_case) -> boost trigram
- If query is natural language question -> boost vector
- If query contains quoted "exact phrase" -> boost BM25
- Default: equal weights

---

*Part of [Total Recall v3 Architecture RFC](https://github.com/Cygnusfear/dockram/issues/233)*
