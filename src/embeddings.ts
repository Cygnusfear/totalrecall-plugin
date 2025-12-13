/**
 * Total Recall Embedding Service using Xenova/transformers
 *
 * Uses all-MiniLM-L6-v2 (384-dim) for local embedding generation
 */

import { pipeline, FeatureExtractionPipeline } from '@xenova/transformers';

let embeddingPipeline: FeatureExtractionPipeline | null = null;

export async function initEmbeddings(): Promise<void> {
  if (!embeddingPipeline) {
    console.error('Loading embedding model (first run may download ~23MB)...');
    embeddingPipeline = await pipeline(
      'feature-extraction',
      'Xenova/all-MiniLM-L6-v2'
    );
    console.error('Embedding model loaded');
  }
}

export async function generateEmbedding(text: string): Promise<number[]> {
  if (!embeddingPipeline) {
    await initEmbeddings();
  }

  // Truncate text to avoid token limits (512 tokens max for this model)
  const truncated = text.substring(0, 2000);

  const output = await embeddingPipeline!(truncated, {
    pooling: 'mean',
    normalize: true
  });

  return Array.from(output.data);
}

/**
 * Options for synthesis embedding generation
 */
export interface SynthesisEmbeddingOptions {
  /** Entity name (e.g., "Jungle", "Total Recall") */
  entityName?: string | null;
  /** Entity aliases as JSON array string (e.g., '["jungle", "Epic #183"]') */
  entityAliases?: string | null;
  /** Source repository/project name (e.g., "jungle-backend", "totalrecall-plugin") */
  sourceRepo?: string | null;
}

/**
 * Generate embedding for a synthesis node
 * Combines one_liner, summary, and optional context fields for better searchability
 *
 * Including entity_name, entity_aliases, and source_repo in the embedding allows
 * users to search by project names even when those names aren't in the synthesis text.
 *
 * @example
 * // Node about "Epic #183 backend migration" can be found by searching "jungle"
 * // if entityName or sourceRepo contains "jungle"
 */
export async function generateSynthesisEmbedding(
  oneLiner: string,
  summary: string,
  nodeType: string,
  options?: SynthesisEmbeddingOptions
): Promise<number[]> {
  // Build context parts
  const parts: string[] = [];

  // Add entity/project context if available
  if (options?.entityName) {
    parts.push(`Project: ${options.entityName}`);
  }

  if (options?.entityAliases) {
    try {
      const aliases = JSON.parse(options.entityAliases);
      if (Array.isArray(aliases) && aliases.length > 0) {
        parts.push(`Also known as: ${aliases.join(', ')}`);
      }
    } catch {
      // Invalid JSON, skip aliases
    }
  }

  if (options?.sourceRepo) {
    parts.push(`Repository: ${options.sourceRepo}`);
  }

  // Build the combined text
  let combined = `[${nodeType}] ${oneLiner}\n\n${summary}`;

  if (parts.length > 0) {
    combined += `\n\nContext: ${parts.join(' | ')}`;
  }

  return generateEmbedding(combined);
}
