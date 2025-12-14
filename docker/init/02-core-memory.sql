-- Total Recall v3 - Core Memory Table (Epic 4)
-- Stores persistent persona and human context blocks that are always-injected

CREATE TABLE IF NOT EXISTS core_memory (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  block_type TEXT NOT NULL UNIQUE CHECK(block_type IN ('persona', 'human')),
  content TEXT NOT NULL,
  token_estimate INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL DEFAULT (extract(epoch from now()) * 1000)::bigint,
  updated_at BIGINT NOT NULL DEFAULT (extract(epoch from now()) * 1000)::bigint
);

CREATE INDEX IF NOT EXISTS idx_core_memory_type ON core_memory(block_type);

-- Add comment for documentation
COMMENT ON TABLE core_memory IS 'Core Memory blocks for always-inject context. Part of Total Recall v3 Epic 4.';
COMMENT ON COLUMN core_memory.block_type IS 'Either persona (agent behavior/preferences) or human (user facts/project context)';
COMMENT ON COLUMN core_memory.token_estimate IS 'Estimated token count for context budget management';
