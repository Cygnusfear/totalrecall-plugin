/**
 * Total Recall v3 - Database Module
 * Re-exports all database types and factory functions
 */

// Core database interface and types
export type {
  ISynthesisDatabase,
  NodeQueryFilters,
  SynthesisQueueFilters,
  QueueStats,
  ProgressiveDisclosureAnalytics,
  RelatedNode,
  HybridSearchOptions,
  HybridSearchResult,
} from './interface.js';

// Re-export Core Memory types from schema (needed by consumers)
export type { CoreMemoryBlock, CoreMemoryBlockType } from '../schema.js';

// Type guard for hybrid search support
export { supportsHybridSearch } from './interface.js';

// Database implementations
export { SQLiteSynthesisDatabase } from './sqlite-db.js';
// PostgreSQL implementation exists but is not yet fully integrated (async/await)
// export { PostgresSynthesisDatabase } from './postgres-db.js';

// Factory functions - the main API
export {
  createDatabase,
  getDatabase,
  resetDatabase,
  getDatabaseWithBackend,
  isBackendAvailable,
  createSQLiteDatabase,
  createPostgresDatabase,
} from './factory.js';
