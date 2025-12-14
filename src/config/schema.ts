/**
 * Total Recall v3 - Configuration Schema
 * Defines all configuration options with Zod validation
 */

import { z } from 'zod';

/**
 * Database backend selection
 */
export const DbBackendSchema = z.enum(['sqlite', 'postgres']);
export type DbBackend = z.infer<typeof DbBackendSchema>;

/**
 * Search mode for queries
 */
export const SearchModeSchema = z.enum(['vector', 'bm25', 'trigram', 'hybrid']);
export type SearchMode = z.infer<typeof SearchModeSchema>;

/**
 * Vector embedding dimensions supported
 */
export const VectorDimensionSchema = z.enum(['384', '768', '1536']).transform(Number);
export type VectorDimension = 384 | 768 | 1536;

/**
 * Search weights configuration
 */
export const SearchWeightsSchema = z.object({
  vector: z.number().min(0).max(10).default(1.0),
  bm25: z.number().min(0).max(10).default(1.0),
  trigram: z.number().min(0).max(10).default(0.5),
});
export type SearchWeights = z.infer<typeof SearchWeightsSchema>;

/**
 * Full configuration schema
 */
export const TotalRecallConfigSchema = z.object({
  // Database backend selection
  dbBackend: DbBackendSchema.default('sqlite'),

  // SQLite options
  sqliteDbPath: z.string().optional(),

  // PostgreSQL options
  postgresUrl: z.string().url().optional(),
  postgresPoolSize: z.number().int().min(1).max(100).default(10),
  postgresPoolTimeout: z.number().int().min(1000).max(60000).default(30000),
  postgresConnectionTimeout: z.number().int().min(1000).max(30000).default(5000),

  // VectorChord options (PostgreSQL only)
  vectorchordProbes: z.number().int().min(1).max(100).default(10),
  vectorchordDimension: z.union([
    z.literal(384),
    z.literal(768),
    z.literal(1536),
  ]).default(384),

  // Search options
  searchMode: SearchModeSchema.default('hybrid'),
  searchWeights: SearchWeightsSchema.default({
    vector: 1.0,
    bm25: 1.0,
    trigram: 0.5,
  }),
  rrfK: z.number().int().min(1).max(1000).default(60),

  // Feature flags
  enableHybridSearch: z.boolean().default(true),
  enableCoreMemory: z.boolean().default(false),
  enableProgressiveDisclosure: z.boolean().default(true),

  // Synthesis worker options
  synthesisWorkerEnabled: z.boolean().default(true),
  synthesisWorkerInterval: z.number().int().min(1000).max(60000).default(5000),
  synthesisMaxRetries: z.number().int().min(0).max(10).default(3),

  // Logging
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  logSensitiveValues: z.boolean().default(false),
});

export type TotalRecallConfig = z.infer<typeof TotalRecallConfigSchema>;

/**
 * Partial config for merging with defaults
 */
export type PartialConfig = Partial<TotalRecallConfig>;

/**
 * Validate configuration and return typed result
 */
export function validateConfig(config: unknown): TotalRecallConfig {
  return TotalRecallConfigSchema.parse(config);
}

/**
 * Safe validate that returns errors instead of throwing
 */
export function safeValidateConfig(
  config: unknown
): { success: true; data: TotalRecallConfig } | { success: false; error: z.ZodError } {
  const result = TotalRecallConfigSchema.safeParse(config);
  return result;
}
