/**
 * Total Recall v3 - Default Configuration Values
 */

import type { TotalRecallConfig } from './schema.js';

/**
 * Default configuration values
 * These are used when no config file or environment variables are set
 */
export const DEFAULT_CONFIG: TotalRecallConfig = {
  // Database backend selection - SQLite for backwards compatibility
  dbBackend: 'sqlite',

  // SQLite options - uses XDG path by default (set in loader)
  sqliteDbPath: undefined,

  // PostgreSQL options
  postgresUrl: undefined,
  postgresPoolSize: 10,
  postgresPoolTimeout: 30000, // 30s
  postgresConnectionTimeout: 5000, // 5s

  // VectorChord options
  vectorchordProbes: 10,
  vectorchordDimension: 384, // MiniLM-L6-v2

  // Search options
  searchMode: 'hybrid',
  searchWeights: {
    vector: 1.0,
    bm25: 1.0,
    trigram: 0.5,
  },
  rrfK: 60,

  // Feature flags
  enableHybridSearch: true,
  enableCoreMemory: false,
  enableProgressiveDisclosure: true,

  // Synthesis worker
  synthesisWorkerEnabled: true,
  synthesisWorkerInterval: 5000, // 5s
  synthesisMaxRetries: 3,

  // Logging
  logLevel: 'info',
  logSensitiveValues: false,
};

/**
 * Environment variable mapping
 * Maps environment variable names to config keys
 */
export const ENV_VAR_MAP: Record<string, keyof TotalRecallConfig> = {
  // Database backend
  TOTALRECALL_DB_BACKEND: 'dbBackend',

  // SQLite
  TOTALRECALL_SQLITE_PATH: 'sqliteDbPath',

  // PostgreSQL
  TOTALRECALL_PG_URL: 'postgresUrl',
  DATABASE_URL: 'postgresUrl', // Fallback for common convention
  TOTALRECALL_PG_POOL_SIZE: 'postgresPoolSize',
  TOTALRECALL_PG_POOL_TIMEOUT: 'postgresPoolTimeout',
  TOTALRECALL_PG_CONNECT_TIMEOUT: 'postgresConnectionTimeout',

  // VectorChord
  TOTALRECALL_VCHORD_PROBES: 'vectorchordProbes',
  TOTALRECALL_VCHORD_DIMENSION: 'vectorchordDimension',

  // Search
  TOTALRECALL_SEARCH_MODE: 'searchMode',
  TOTALRECALL_SEARCH_VECTOR_WEIGHT: 'searchWeights', // Special handling
  TOTALRECALL_SEARCH_BM25_WEIGHT: 'searchWeights', // Special handling
  TOTALRECALL_SEARCH_TRIGRAM_WEIGHT: 'searchWeights', // Special handling
  TOTALRECALL_RRF_K: 'rrfK',

  // Features
  TOTALRECALL_HYBRID_SEARCH: 'enableHybridSearch',
  TOTALRECALL_CORE_MEMORY: 'enableCoreMemory',
  TOTALRECALL_PROGRESSIVE_DISCLOSURE: 'enableProgressiveDisclosure',

  // Worker
  TOTALRECALL_WORKER_ENABLED: 'synthesisWorkerEnabled',
  TOTALRECALL_WORKER_INTERVAL: 'synthesisWorkerInterval',
  TOTALRECALL_MAX_RETRIES: 'synthesisMaxRetries',

  // Logging
  TOTALRECALL_LOG_LEVEL: 'logLevel',
  TOTALRECALL_LOG_SENSITIVE: 'logSensitiveValues',
};

/**
 * Sensitive configuration keys that should not be logged
 */
export const SENSITIVE_KEYS: Set<keyof TotalRecallConfig> = new Set([
  'postgresUrl',
]);
