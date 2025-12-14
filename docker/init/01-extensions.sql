-- Total Recall v3 - Enable VectorChord Suite Extensions
-- This script runs automatically on first container start

-- VectorChord for vector similarity search (replaces pgvector)
CREATE EXTENSION IF NOT EXISTS vchord CASCADE;

-- VectorChord-BM25 for keyword search with BM25 ranking
CREATE EXTENSION IF NOT EXISTS vchord_bm25 CASCADE;

-- pg_tokenizer for custom tokenization (used by BM25)
CREATE EXTENSION IF NOT EXISTS pg_tokenizer CASCADE;

-- pg_trgm for trigram-based fuzzy matching (code identifiers)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Verify extensions are installed
DO $$
BEGIN
  RAISE NOTICE 'VectorChord Suite extensions enabled successfully';
  RAISE NOTICE 'Available extensions:';
  RAISE NOTICE '  - vchord: vector similarity search';
  RAISE NOTICE '  - vchord_bm25: BM25 keyword ranking';
  RAISE NOTICE '  - pg_tokenizer: custom tokenization';
  RAISE NOTICE '  - pg_trgm: trigram fuzzy matching';
END $$;
