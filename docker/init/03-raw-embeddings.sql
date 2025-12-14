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

-- Create index for vector similarity search (if doesn't exist)
-- Uses vchordrq from vchord extension for fast approximate nearest neighbor search
CREATE INDEX IF NOT EXISTS idx_raw_content_embedding
ON raw_content USING vchordrq (embedding vector_l2_ops);

DO $$ BEGIN RAISE NOTICE 'Raw content embeddings migration complete'; END $$;
