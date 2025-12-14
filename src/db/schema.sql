-- Total Recall v3 - PostgreSQL Schema with VectorChord Suite
--
-- This schema maps the existing SQLite tables to PostgreSQL equivalents,
-- using VectorChord for vector storage (replacing sqlite-vec) and
-- VectorChord-BM25 for keyword search.
--
-- Dimension: 384 (MiniLM-L6-v2 embeddings)
--
-- Run after extensions are enabled (see docker/init/01-extensions.sql)

-- ============================================================================
-- SYNTHESIS NODES - Core knowledge storage
-- ============================================================================

CREATE TABLE IF NOT EXISTS synthesis_nodes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    node_type TEXT NOT NULL CHECK (node_type IN ('decision', 'learning', 'entity', 'event', 'task', 'summary')),
    one_liner TEXT NOT NULL,
    summary TEXT NOT NULL,
    full_synthesis TEXT NOT NULL,

    -- Entity-specific fields
    entity_name TEXT,
    entity_aliases TEXT,  -- JSON array stored as text for compatibility

    -- Temporal tracking
    temporal_context TEXT,
    first_seen BIGINT NOT NULL,
    last_updated BIGINT NOT NULL,

    -- Task-specific fields (optional)
    status TEXT,
    assigned_agent TEXT,
    priority INTEGER,

    -- Source tracking
    source_session_id TEXT,
    source_agent_id TEXT,
    source_repo TEXT,

    -- Access analytics
    access_count INTEGER DEFAULT 0,
    last_accessed BIGINT,

    -- Timestamps (Unix ms)
    created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
    updated_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,

    -- Vector embedding for semantic search (VectorChord)
    -- 384 dimensions for MiniLM-L6-v2, can be upgraded to 768/1536 later
    embedding vector(384),

    -- BM25 vector for keyword search (populated by tokenizer)
    bm25 bm25_catalog.bm25vector
);

-- Standard B-tree indexes for common lookups
CREATE INDEX IF NOT EXISTS idx_nodes_last_updated ON synthesis_nodes(last_updated DESC);
CREATE INDEX IF NOT EXISTS idx_nodes_session ON synthesis_nodes(source_session_id);
CREATE INDEX IF NOT EXISTS idx_nodes_type ON synthesis_nodes(node_type);
CREATE INDEX IF NOT EXISTS idx_nodes_created ON synthesis_nodes(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_nodes_entity_name ON synthesis_nodes(entity_name) WHERE entity_name IS NOT NULL;

-- VectorChord index for vector similarity search
-- Using vchordrq (RaBitQ quantization) for memory efficiency
-- probes controls recall/speed tradeoff (default 10, increase for higher recall)
CREATE INDEX IF NOT EXISTS idx_nodes_embedding ON synthesis_nodes
    USING vchordrq (embedding vector_l2_ops);

-- Trigram indexes for code identifier fuzzy search
CREATE INDEX IF NOT EXISTS idx_nodes_entity_name_trgm ON synthesis_nodes
    USING gin (entity_name gin_trgm_ops)
    WHERE entity_name IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_nodes_one_liner_trgm ON synthesis_nodes
    USING gin (one_liner gin_trgm_ops);

-- ============================================================================
-- SYNTHESIS EDGES - Graph relationships between nodes
-- ============================================================================

CREATE TABLE IF NOT EXISTS synthesis_edges (
    id SERIAL PRIMARY KEY,
    from_node_id UUID NOT NULL REFERENCES synthesis_nodes(id) ON DELETE CASCADE,
    to_node_id UUID NOT NULL REFERENCES synthesis_nodes(id) ON DELETE CASCADE,
    edge_type TEXT NOT NULL CHECK (edge_type IN ('relates_to', 'caused', 'preceded', 'contains', 'contradicts')),
    weight REAL DEFAULT 1.0,
    context TEXT,
    created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,

    -- Prevent duplicate edges
    UNIQUE(from_node_id, to_node_id, edge_type)
);

CREATE INDEX IF NOT EXISTS idx_edges_from ON synthesis_edges(from_node_id);
CREATE INDEX IF NOT EXISTS idx_edges_to ON synthesis_edges(to_node_id);
CREATE INDEX IF NOT EXISTS idx_edges_type ON synthesis_edges(edge_type);

-- ============================================================================
-- RAW CONTENT - Conversation chunk storage for synthesis input
-- ============================================================================

CREATE TABLE IF NOT EXISTS raw_content (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    synthesis_node_id UUID REFERENCES synthesis_nodes(id) ON DELETE SET NULL,
    content_type TEXT NOT NULL CHECK (content_type IN ('message', 'tool_call', 'tool_result', 'conversation')),
    content TEXT NOT NULL,
    agent_id TEXT,
    timestamp BIGINT NOT NULL,
    message_index INTEGER,
    created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
);

CREATE INDEX IF NOT EXISTS idx_raw_content_session_time ON raw_content(session_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_raw_content_synthesis_time ON raw_content(synthesis_node_id, timestamp ASC);
CREATE INDEX IF NOT EXISTS idx_raw_content_timestamp ON raw_content(timestamp DESC);

-- ============================================================================
-- SYNTHESIS QUEUE - Background processing queue for synthesis worker
-- ============================================================================

CREATE TABLE IF NOT EXISTS synthesis_queue (
    id SERIAL PRIMARY KEY,
    session_id TEXT NOT NULL,
    agent_id TEXT,
    chunk_type TEXT NOT NULL CHECK (chunk_type IN ('session_start', 'session_chunk', 'session_end')),
    raw_content_ids TEXT NOT NULL,  -- JSON array of raw_content IDs
    context TEXT,
    message_count INTEGER,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
    retry_count INTEGER DEFAULT 0,
    error TEXT,
    synthesis_node_id UUID REFERENCES synthesis_nodes(id) ON DELETE SET NULL,
    created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
    started_at BIGINT,
    completed_at BIGINT
);

CREATE INDEX IF NOT EXISTS idx_synthesis_queue_status ON synthesis_queue(status, created_at);
CREATE INDEX IF NOT EXISTS idx_synthesis_queue_session ON synthesis_queue(session_id);
CREATE INDEX IF NOT EXISTS idx_synthesis_queue_session_time ON synthesis_queue(session_id, created_at DESC);

-- ============================================================================
-- PROGRESSIVE DISCLOSURE EVENTS - Analytics for search/expand behavior
-- ============================================================================

CREATE TABLE IF NOT EXISTS progressive_disclosure_events (
    id SERIAL PRIMARY KEY,
    event_type TEXT NOT NULL CHECK (event_type IN ('search', 'inject', 'expand', 'skip')),
    session_id TEXT,
    agent_id TEXT,
    query_text TEXT,
    search_latency_ms INTEGER,
    results_count INTEGER,
    node_ids TEXT,  -- JSON array
    injection_tokens INTEGER,
    expanded_node_id UUID,
    expansion_tokens INTEGER,
    message_tokens INTEGER,
    created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
);

CREATE INDEX IF NOT EXISTS idx_pd_events_type ON progressive_disclosure_events(event_type);
CREATE INDEX IF NOT EXISTS idx_pd_events_session ON progressive_disclosure_events(session_id);
CREATE INDEX IF NOT EXISTS idx_pd_events_created ON progressive_disclosure_events(created_at DESC);

-- ============================================================================
-- BM25 TOKENIZER CONFIGURATION
-- ============================================================================

-- Create a tokenizer for BM25 using BERT wordpiece
-- Uses bert_base_uncased model for good English text handling
SELECT tokenizer_catalog.create_tokenizer('totalrecall_tokenizer', 'model = "bert_base_uncased"');

-- Create BM25 index using the custom tokenizer
-- Note: Index is created on the bm25 column, not a text expression
CREATE INDEX IF NOT EXISTS idx_nodes_bm25 ON synthesis_nodes
    USING bm25 (bm25 bm25_catalog.bm25_ops);

-- ============================================================================
-- HELPER FUNCTIONS
-- ============================================================================

-- Function to update timestamps on node modification
CREATE OR REPLACE FUNCTION update_node_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger for automatic timestamp updates
DROP TRIGGER IF EXISTS trg_node_updated ON synthesis_nodes;
CREATE TRIGGER trg_node_updated
    BEFORE UPDATE ON synthesis_nodes
    FOR EACH ROW
    EXECUTE FUNCTION update_node_timestamp();

-- Function to tokenize and set bm25vector on insert/update
CREATE OR REPLACE FUNCTION update_node_bm25()
RETURNS TRIGGER AS $$
DECLARE
    combined_text TEXT;
    token_array INTEGER[];
BEGIN
    -- Combine searchable text fields for BM25 indexing
    combined_text := COALESCE(NEW.one_liner, '') || ' ' ||
                     COALESCE(NEW.summary, '') || ' ' ||
                     COALESCE(NEW.full_synthesis, '');

    -- Tokenize the combined text
    token_array := tokenizer_catalog.tokenize(combined_text, 'totalrecall_tokenizer');

    -- Cast to bm25vector
    NEW.bm25 := token_array::bm25_catalog.bm25vector;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger for automatic BM25 vector updates
DROP TRIGGER IF EXISTS trg_node_bm25 ON synthesis_nodes;
CREATE TRIGGER trg_node_bm25
    BEFORE INSERT OR UPDATE ON synthesis_nodes
    FOR EACH ROW
    EXECUTE FUNCTION update_node_bm25();

-- ============================================================================
-- SEARCH FUNCTIONS
-- ============================================================================

-- Hybrid search combining vector, BM25, and trigram results
-- Uses Reciprocal Rank Fusion (RRF) for score fusion
CREATE OR REPLACE FUNCTION hybrid_search(
    query_text TEXT,
    query_embedding vector(384),
    max_results INTEGER DEFAULT 10,
    min_score REAL DEFAULT 0.3,
    vector_weight REAL DEFAULT 1.0,
    bm25_weight REAL DEFAULT 1.0,
    trigram_weight REAL DEFAULT 0.5,
    rrf_k INTEGER DEFAULT 60
)
RETURNS TABLE (
    node_id UUID,
    one_liner TEXT,
    node_type TEXT,
    score REAL,
    vector_rank INTEGER,
    bm25_rank INTEGER,
    trigram_rank INTEGER
) AS $$
WITH
-- Vector search results with ranking
vector_results AS (
    SELECT
        id,
        one_liner,
        node_type,
        1 - (embedding <-> query_embedding) AS similarity,
        ROW_NUMBER() OVER (ORDER BY embedding <-> query_embedding) AS rank
    FROM synthesis_nodes
    WHERE embedding IS NOT NULL
    ORDER BY embedding <-> query_embedding
    LIMIT max_results * 3
),
-- BM25 search results with ranking
-- Note: BM25 scores are negative (more negative = more relevant), so we order ASC
bm25_results AS (
    SELECT
        id,
        one_liner,
        node_type,
        bm25 <&> bm25_catalog.to_bm25query('idx_nodes_bm25'::regclass,
            tokenizer_catalog.tokenize(query_text, 'totalrecall_tokenizer')::bm25_catalog.bm25vector) AS bm25_raw,
        ROW_NUMBER() OVER (ORDER BY bm25 <&> bm25_catalog.to_bm25query('idx_nodes_bm25'::regclass,
            tokenizer_catalog.tokenize(query_text, 'totalrecall_tokenizer')::bm25_catalog.bm25vector) ASC) AS rank
    FROM synthesis_nodes
    WHERE bm25 IS NOT NULL
    ORDER BY bm25_raw ASC
    LIMIT max_results * 3
),
-- Trigram search results with ranking
trigram_results AS (
    SELECT
        id,
        one_liner,
        node_type,
        GREATEST(
            similarity(entity_name, query_text),
            similarity(one_liner, query_text)
        ) AS trgm_sim,
        ROW_NUMBER() OVER (ORDER BY GREATEST(
            similarity(entity_name, query_text),
            similarity(one_liner, query_text)
        ) DESC) AS rank
    FROM synthesis_nodes
    WHERE
        entity_name % query_text
        OR one_liner % query_text
    ORDER BY trgm_sim DESC
    LIMIT max_results * 3
),
-- Combine all unique node IDs
all_nodes AS (
    SELECT DISTINCT id, one_liner, node_type FROM vector_results
    UNION
    SELECT DISTINCT id, one_liner, node_type FROM bm25_results
    UNION
    SELECT DISTINCT id, one_liner, node_type FROM trigram_results
),
-- Calculate RRF scores
rrf_scores AS (
    SELECT
        a.id,
        a.one_liner,
        a.node_type,
        COALESCE(v.rank, 1000) AS v_rank,
        COALESCE(b.rank, 1000) AS b_rank,
        COALESCE(t.rank, 1000) AS t_rank,
        (
            vector_weight * (1.0 / (rrf_k + COALESCE(v.rank, 1000))) +
            bm25_weight * (1.0 / (rrf_k + COALESCE(b.rank, 1000))) +
            trigram_weight * (1.0 / (rrf_k + COALESCE(t.rank, 1000)))
        ) AS rrf_score
    FROM all_nodes a
    LEFT JOIN vector_results v ON a.id = v.id
    LEFT JOIN bm25_results b ON a.id = b.id
    LEFT JOIN trigram_results t ON a.id = t.id
)
SELECT
    id AS node_id,
    one_liner,
    node_type,
    rrf_score::REAL AS score,
    v_rank::INTEGER AS vector_rank,
    b_rank::INTEGER AS bm25_rank,
    t_rank::INTEGER AS trigram_rank
FROM rrf_scores
WHERE rrf_score >= min_score * 0.01  -- Adjust threshold for RRF scale
ORDER BY rrf_score DESC
LIMIT max_results;
$$ LANGUAGE SQL STABLE;

-- ============================================================================
-- STATISTICS
-- ============================================================================

-- View for database statistics
CREATE OR REPLACE VIEW synthesis_stats AS
SELECT
    (SELECT COUNT(*) FROM synthesis_nodes) AS total_nodes,
    (SELECT COUNT(*) FROM synthesis_nodes WHERE embedding IS NOT NULL) AS nodes_with_embeddings,
    (SELECT COUNT(*) FROM synthesis_nodes WHERE bm25 IS NOT NULL) AS nodes_with_bm25,
    (SELECT COUNT(*) FROM synthesis_edges) AS total_edges,
    (SELECT COUNT(*) FROM raw_content) AS total_raw_content,
    (SELECT COUNT(*) FROM synthesis_queue WHERE status = 'pending') AS queue_pending,
    (SELECT COUNT(*) FROM synthesis_queue WHERE status = 'processing') AS queue_processing,
    (SELECT COUNT(*) FROM synthesis_queue WHERE status = 'failed') AS queue_failed;
