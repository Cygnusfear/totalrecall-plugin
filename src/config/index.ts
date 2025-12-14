/**
 * Total Recall v3 - Configuration Module
 * Re-exports all configuration utilities
 */

export {
  type TotalRecallConfig,
  type PartialConfig,
  type DbBackend,
  type SearchMode,
  type VectorDimension,
  type SearchWeights,
  validateConfig,
  safeValidateConfig,
} from './schema.js';

export {
  DEFAULT_CONFIG,
  ENV_VAR_MAP,
  SENSITIVE_KEYS,
} from './defaults.js';

export {
  loadConfig,
  getConfig,
  resetConfig,
  formatConfigForDisplay,
  getConfigDir,
  getDataDir,
  getDefaultSqlitePath,
} from './loader.js';
