-- Total Recall v3 - Add embedding column to raw_content table
-- This enables semantic vector search on raw conversation content

-- Add embedding column if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'raw_content' AND column_name = 'embedding'
  ) THEN
    ALTER TABLE raw_content ADD COLUMN embedding vector(384);
    RAISE NOTICE 'Added embedding column to raw_content table';
  ELSE
    RAISE NOTICE 'embedding column already exists on raw_content table';
  END IF;
END $$;

-- Create index for vector similarity search
-- Tries vchordrq (vchord extension) first, falls back to ivfflat (standard pgvector)
DO $$
BEGIN
  -- Check if index already exists
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'idx_raw_content_embedding'
  ) THEN
    -- Try vchordrq first (faster, from vchord extension)
    BEGIN
      EXECUTE 'CREATE INDEX idx_raw_content_embedding ON raw_content USING vchordrq (embedding vector_l2_ops)';
      RAISE NOTICE 'Created vchordrq index for raw_content embeddings';
    EXCEPTION WHEN undefined_object THEN
      -- vchordrq not available, fall back to ivfflat (standard pgvector)
      EXECUTE 'CREATE INDEX idx_raw_content_embedding ON raw_content USING ivfflat (embedding vector_l2_ops) WITH (lists = 100)';
      RAISE NOTICE 'Created ivfflat index for raw_content embeddings (vchordrq not available)';
    END;
  ELSE
    RAISE NOTICE 'idx_raw_content_embedding already exists';
  END IF;
END $$;

DO $$ BEGIN RAISE NOTICE 'Raw content embeddings migration complete'; END $$;
