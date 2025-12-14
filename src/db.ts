/**
 * Total Recall Database - Main Entry Point
 *
 * This file maintains backwards compatibility while delegating to the new
 * database abstraction layer (SQLite or PostgreSQL via factory).
 *
 * For v3 migration, most code should use the new API from db/index.ts:
 * - import { getDatabase } from './db/index.js';
 *
 * This file exists to support legacy imports:
 * - import { SynthesisDatabase, getDatabase } from './db.js';
 */

import { getDatabase as getDbFromFactory, resetDatabase as resetDbFromFactory } from './db/index.js';
import type { ISynthesisDatabase } from './db/index.js';

/**
 * Legacy class name alias for backwards compatibility
 * @deprecated Use ISynthesisDatabase interface from './db/index.js' instead
 */
export type SynthesisDatabase = ISynthesisDatabase;

/**
 * Get the singleton database instance
 * Uses the factory to select backend based on configuration
 */
export function getDatabase(): ISynthesisDatabase {
  return getDbFromFactory();
}

/**
 * Reset database singleton (for testing)
 */
export function resetDatabase(): void {
  resetDbFromFactory();
}

// Re-export everything from the new db module for convenience
export * from './db/index.js';
