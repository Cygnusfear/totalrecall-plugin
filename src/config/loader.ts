/**
 * Total Recall v3 - Configuration Loader
 * Loads config from environment variables, config file, and defaults
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import {
  type TotalRecallConfig,
  type PartialConfig,
  validateConfig,
  safeValidateConfig,
} from './schema.js';
import { DEFAULT_CONFIG, ENV_VAR_MAP, SENSITIVE_KEYS } from './defaults.js';

/**
 * Get XDG config directory path
 */
function getConfigDir(): string {
  return process.env.XDG_CONFIG_HOME || join(homedir(), '.config', 'totalrecall');
}

/**
 * Get XDG data directory path (for SQLite database)
 */
function getDataDir(): string {
  return process.env.XDG_DATA_HOME || join(homedir(), '.config', 'totalrecall');
}

/**
 * Get default SQLite database path
 */
function getDefaultSqlitePath(): string {
  return join(getDataDir(), 'synthesis.sqlite');
}

/**
 * Load config from JSON file if it exists
 */
function loadConfigFile(): PartialConfig {
  const configPath = join(getConfigDir(), 'config.json');

  if (!existsSync(configPath)) {
    return {};
  }

  try {
    const content = readFileSync(configPath, 'utf-8');
    return JSON.parse(content) as PartialConfig;
  } catch (error) {
    console.warn(`[config] Failed to load config file: ${configPath}`, error);
    return {};
  }
}

/**
 * Parse boolean from environment variable
 */
function parseEnvBool(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const lower = value.toLowerCase();
  if (lower === 'true' || lower === '1' || lower === 'yes') return true;
  if (lower === 'false' || lower === '0' || lower === 'no') return false;
  return undefined;
}

/**
 * Parse integer from environment variable
 */
function parseEnvInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const num = parseInt(value, 10);
  return isNaN(num) ? undefined : num;
}

/**
 * Load config from environment variables
 */
function loadEnvConfig(): PartialConfig {
  const config: PartialConfig = {};

  // Database backend
  if (process.env.TOTALRECALL_DB_BACKEND) {
    const backend = process.env.TOTALRECALL_DB_BACKEND.toLowerCase();
    if (backend === 'sqlite' || backend === 'postgres') {
      config.dbBackend = backend;
    }
  }

  // SQLite path
  if (process.env.TOTALRECALL_SQLITE_PATH) {
    config.sqliteDbPath = process.env.TOTALRECALL_SQLITE_PATH;
  }

  // PostgreSQL URL (check both env vars)
  config.postgresUrl =
    process.env.TOTALRECALL_PG_URL || process.env.DATABASE_URL || undefined;

  // PostgreSQL pool settings
  const poolSize = parseEnvInt(process.env.TOTALRECALL_PG_POOL_SIZE);
  if (poolSize !== undefined) config.postgresPoolSize = poolSize;

  const poolTimeout = parseEnvInt(process.env.TOTALRECALL_PG_POOL_TIMEOUT);
  if (poolTimeout !== undefined) config.postgresPoolTimeout = poolTimeout;

  const connectTimeout = parseEnvInt(process.env.TOTALRECALL_PG_CONNECT_TIMEOUT);
  if (connectTimeout !== undefined) config.postgresConnectionTimeout = connectTimeout;

  // VectorChord settings
  const probes = parseEnvInt(process.env.TOTALRECALL_VCHORD_PROBES);
  if (probes !== undefined) config.vectorchordProbes = probes;

  const dimension = parseEnvInt(process.env.TOTALRECALL_VCHORD_DIMENSION);
  if (dimension === 384 || dimension === 768 || dimension === 1536) {
    config.vectorchordDimension = dimension;
  }

  // Search mode
  if (process.env.TOTALRECALL_SEARCH_MODE) {
    const mode = process.env.TOTALRECALL_SEARCH_MODE.toLowerCase();
    if (mode === 'vector' || mode === 'bm25' || mode === 'trigram' || mode === 'hybrid') {
      config.searchMode = mode;
    }
  }

  // Search weights
  const vectorWeight = parseFloat(process.env.TOTALRECALL_SEARCH_VECTOR_WEIGHT || '');
  const bm25Weight = parseFloat(process.env.TOTALRECALL_SEARCH_BM25_WEIGHT || '');
  const trigramWeight = parseFloat(process.env.TOTALRECALL_SEARCH_TRIGRAM_WEIGHT || '');

  if (!isNaN(vectorWeight) || !isNaN(bm25Weight) || !isNaN(trigramWeight)) {
    config.searchWeights = {
      vector: isNaN(vectorWeight) ? 1.0 : vectorWeight,
      bm25: isNaN(bm25Weight) ? 1.0 : bm25Weight,
      trigram: isNaN(trigramWeight) ? 0.5 : trigramWeight,
    };
  }

  const rrfK = parseEnvInt(process.env.TOTALRECALL_RRF_K);
  if (rrfK !== undefined) config.rrfK = rrfK;

  // Feature flags
  const hybridSearch = parseEnvBool(process.env.TOTALRECALL_HYBRID_SEARCH);
  if (hybridSearch !== undefined) config.enableHybridSearch = hybridSearch;

  const coreMemory = parseEnvBool(process.env.TOTALRECALL_CORE_MEMORY);
  if (coreMemory !== undefined) config.enableCoreMemory = coreMemory;

  const progressiveDisclosure = parseEnvBool(process.env.TOTALRECALL_PROGRESSIVE_DISCLOSURE);
  if (progressiveDisclosure !== undefined) config.enableProgressiveDisclosure = progressiveDisclosure;

  // Worker settings
  const workerEnabled = parseEnvBool(process.env.TOTALRECALL_WORKER_ENABLED);
  if (workerEnabled !== undefined) config.synthesisWorkerEnabled = workerEnabled;

  const workerInterval = parseEnvInt(process.env.TOTALRECALL_WORKER_INTERVAL);
  if (workerInterval !== undefined) config.synthesisWorkerInterval = workerInterval;

  const maxRetries = parseEnvInt(process.env.TOTALRECALL_MAX_RETRIES);
  if (maxRetries !== undefined) config.synthesisMaxRetries = maxRetries;

  // Logging
  if (process.env.TOTALRECALL_LOG_LEVEL) {
    const level = process.env.TOTALRECALL_LOG_LEVEL.toLowerCase();
    if (level === 'debug' || level === 'info' || level === 'warn' || level === 'error') {
      config.logLevel = level;
    }
  }

  const logSensitive = parseEnvBool(process.env.TOTALRECALL_LOG_SENSITIVE);
  if (logSensitive !== undefined) config.logSensitiveValues = logSensitive;

  return config;
}

/**
 * Merge configs with precedence: env > file > defaults
 */
function mergeConfigs(
  defaults: TotalRecallConfig,
  fileConfig: PartialConfig,
  envConfig: PartialConfig
): TotalRecallConfig {
  return {
    ...defaults,
    ...fileConfig,
    ...envConfig,
    // Deep merge search weights
    searchWeights: {
      ...defaults.searchWeights,
      ...fileConfig.searchWeights,
      ...envConfig.searchWeights,
    },
  };
}

/**
 * Singleton config instance
 */
let _config: TotalRecallConfig | null = null;

/**
 * Load and validate configuration
 * Returns cached config on subsequent calls
 */
export function loadConfig(): TotalRecallConfig {
  if (_config !== null) {
    return _config;
  }

  // Load from all sources
  const fileConfig = loadConfigFile();
  const envConfig = loadEnvConfig();

  // Set default SQLite path if not specified
  const defaults: TotalRecallConfig = {
    ...DEFAULT_CONFIG,
    sqliteDbPath: getDefaultSqlitePath(),
  };

  // Merge with precedence
  const merged = mergeConfigs(defaults, fileConfig, envConfig);

  // Validate
  const result = safeValidateConfig(merged);
  if (!result.success) {
    console.error('[config] Invalid configuration:');
    result.error.errors.forEach((err) => {
      console.error(`  - ${err.path.join('.')}: ${err.message}`);
    });
    throw new Error('Invalid Total Recall configuration');
  }

  _config = result.data;
  return _config;
}

/**
 * Reset cached config (for testing)
 */
export function resetConfig(): void {
  _config = null;
}

/**
 * Get current config without reloading
 */
export function getConfig(): TotalRecallConfig {
  if (_config === null) {
    return loadConfig();
  }
  return _config;
}

/**
 * Format config for display (hiding sensitive values)
 */
export function formatConfigForDisplay(config: TotalRecallConfig): Record<string, unknown> {
  const display: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(config)) {
    if (SENSITIVE_KEYS.has(key as keyof TotalRecallConfig) && !config.logSensitiveValues) {
      display[key] = value ? '[REDACTED]' : undefined;
    } else {
      display[key] = value;
    }
  }

  return display;
}

/**
 * Export config paths for external use
 */
export { getConfigDir, getDataDir, getDefaultSqlitePath };
