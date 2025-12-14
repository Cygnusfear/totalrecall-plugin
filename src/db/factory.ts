/**
 * Total Recall v3 - Database Factory
 * Selects and instantiates the appropriate database backend
 */

import { getConfig, type TotalRecallConfig } from '../config/index.js';
import type { ISynthesisDatabase } from './interface.js';
import { SQLiteSynthesisDatabase } from './sqlite-db.js';
// PostgreSQL implementation is async and not yet fully integrated
// import { PostgresSynthesisDatabase } from './postgres-db.js';

/**
 * Singleton database instance
 */
let _db: ISynthesisDatabase | null = null;

/**
 * Create database instance based on configuration
 */
export function createDatabase(config?: TotalRecallConfig): ISynthesisDatabase {
  const cfg = config || getConfig();

  if (cfg.dbBackend === 'postgres') {
    throw new Error(
      'PostgreSQL backend is not yet fully implemented. ' +
      'The async PostgreSQL implementation exists but requires the application to be updated for async/await support. ' +
      'SQLite is currently the only supported backend. ' +
      'Track https://github.com/Cygnusfear/totalrecall-plugin/issues for PostgreSQL support progress.'
    );
    // TODO: Complete PostgreSQL implementation in future Epic
    // if (!cfg.postgresUrl) {
    //   throw new Error(
    //     'PostgreSQL backend selected but TOTALRECALL_PG_URL or DATABASE_URL not configured'
    //   );
    // }
    // return new PostgresSynthesisDatabase({
    //   connectionString: cfg.postgresUrl,
    //   poolSize: cfg.postgresPoolSize,
    //   poolTimeout: cfg.postgresPoolTimeout,
    //   connectionTimeout: cfg.postgresConnectionTimeout,
    //   vectorchordProbes: cfg.vectorchordProbes,
    //   vectorDimension: cfg.vectorchordDimension,
    //   });
  }

  // Default: SQLite
  if (!cfg.sqliteDbPath) {
    throw new Error('SQLite backend selected but sqliteDbPath not configured');
  }

  return new SQLiteSynthesisDatabase(cfg.sqliteDbPath);
}

/**
 * Get singleton database instance
 * Creates one if it doesn't exist
 */
export function getDatabase(): ISynthesisDatabase {
  if (_db === null) {
    _db = createDatabase();
  }
  return _db;
}

/**
 * Reset database singleton (for testing)
 */
export function resetDatabase(): void {
  if (_db !== null) {
    _db.close();
    _db = null;
  }
}

/**
 * Get database with explicit backend (for testing/migration)
 */
export function getDatabaseWithBackend(
  backend: 'sqlite' | 'postgres',
  options: {
    sqlitePath?: string;
    postgresUrl?: string;
    poolSize?: number;
    vectorchordProbes?: number;
    vectorDimension?: 384 | 768 | 1536;
  }
): ISynthesisDatabase {
  if (backend === 'postgres') {
    throw new Error('PostgreSQL backend not yet supported - use SQLite for now');
    // TODO: Enable when async support is complete
    // if (!options.postgresUrl) {
    //   throw new Error('PostgreSQL URL required for postgres backend');
    // }
    // return new PostgresSynthesisDatabase({
    //   connectionString: options.postgresUrl,
    //   poolSize: options.poolSize,
    //   vectorchordProbes: options.vectorchordProbes,
    //   vectorDimension: options.vectorDimension,
    // });
  }

  if (!options.sqlitePath) {
    throw new Error('SQLite path required for sqlite backend');
  }

  return new SQLiteSynthesisDatabase(options.sqlitePath);
}

/**
 * Check if a backend is available
 */
/**
 * Check if a backend is available
 * For postgres, this only checks if the package is installed, not if the server is reachable
 */
export function isBackendAvailable(backend: 'sqlite' | 'postgres'): boolean {
  if (backend === 'sqlite') {
    return true; // Always available
  }

  if (backend === 'postgres') {
    try {
      // Check if postgres package is available
      require.resolve('postgres');
      return true;
    } catch {
      return false;
    }
  }

  return false;
}
