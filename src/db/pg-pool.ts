/**
 * Total Recall v3 - PostgreSQL Connection Pool
 * Manages PostgreSQL connections using the postgres package
 */

import postgres from 'postgres';

/**
 * PostgreSQL pool configuration
 */
export interface PostgresPoolConfig {
  connectionString: string;
  poolSize?: number;
  poolTimeout?: number;
  connectionTimeout?: number;
  idleTimeout?: number;
}

/**
 * Connection pool manager
 * Singleton that manages a postgres connection pool
 */
class PostgresPoolManager {
  private pool: postgres.Sql | null = null;
  private config: PostgresPoolConfig | null = null;

  /**
   * Initialize the pool with configuration
   */
  init(config: PostgresPoolConfig): postgres.Sql {
    if (this.pool !== null) {
      // Already initialized with same config
      if (this.config?.connectionString === config.connectionString) {
        return this.pool;
      }
      // Different config - close old pool and create new one
      this.close();
    }

    this.config = config;
    this.pool = postgres(config.connectionString, {
      max: config.poolSize ?? 10,
      idle_timeout: config.idleTimeout ?? 30,
      connect_timeout: (config.connectionTimeout ?? 5000) / 1000, // Convert to seconds
      prepare: false, // Disable prepared statements for better compatibility
      onnotice: () => {}, // Suppress NOTICE messages
    });

    return this.pool;
  }

  /**
   * Get the current pool instance
   * Throws if not initialized
   */
  getPool(): postgres.Sql {
    if (this.pool === null) {
      throw new Error('PostgreSQL pool not initialized. Call init() first.');
    }
    return this.pool;
  }

  /**
   * Check if pool is initialized
   */
  isInitialized(): boolean {
    return this.pool !== null;
  }

  /**
   * Close the pool and clean up connections
   */
  async close(): Promise<void> {
    if (this.pool !== null) {
      await this.pool.end();
      this.pool = null;
      this.config = null;
    }
  }

  /**
   * Execute a raw SQL query with automatic connection handling
   *
   * ⚠️ SECURITY WARNING: This method uses `unsafe()` which does NOT escape parameters.
   * Only use this for trusted SQL strings. NEVER pass user input directly.
   * Prefer using the tagged template literal syntax via getPool() for safe queries.
   *
   * @deprecated Use getPool() with tagged template literals instead for safe queries
   * @example
   * // SAFE - use this instead:
   * const pool = connectionPool.getPool();
   * const results = await pool`SELECT * FROM users WHERE id = ${userId}`;
   *
   * // UNSAFE - avoid this:
   * await connectionPool.query(`SELECT * FROM users WHERE id = ${userId}`);
   */
  async query<T = any>(
    sql: string,
    params: any[] = []
  ): Promise<any> {
    const pool = this.getPool();
    // Note: unsafe() is required for dynamic SQL but caller must ensure params are sanitized
    return pool.unsafe(sql, params);
  }

  /**
   * Execute a transaction
   */
  async transaction<T>(
    callback: (sql: postgres.Sql) => Promise<T>
  ): Promise<T> {
    const pool = this.getPool();
    return pool.begin(callback) as Promise<T>;
  }

  /**
   * Health check - test the connection
   */
  async healthCheck(): Promise<boolean> {
    try {
      const pool = this.getPool();
      await pool`SELECT 1 as health`;
      return true;
    } catch (error) {
      return false;
    }
  }
}

// Singleton instance
const poolManager = new PostgresPoolManager();

/**
 * Initialize the PostgreSQL pool
 */
export function initPool(config: PostgresPoolConfig): postgres.Sql {
  return poolManager.init(config);
}

/**
 * Get the current pool instance
 */
export function getPool(): postgres.Sql {
  return poolManager.getPool();
}

/**
 * Check if pool is initialized
 */
export function isPoolInitialized(): boolean {
  return poolManager.isInitialized();
}

/**
 * Close the pool
 */
export async function closePool(): Promise<void> {
  await poolManager.close();
}

/**
 * Execute a query
 */
export async function query(
  sql: string,
  params: any[] = []
): Promise<any> {
  return poolManager.query(sql, params);
}

/**
 * Execute a transaction
 */
export async function transaction<T>(
  callback: (sql: postgres.Sql) => Promise<T>
): Promise<T> {
  return poolManager.transaction(callback);
}

/**
 * Health check
 */
export async function healthCheck(): Promise<boolean> {
  return poolManager.healthCheck();
}
