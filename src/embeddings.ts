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
 * Generate embedding for a synthesis node
 * Combines one_liner and summary for better searchability
 */
export async function generateSynthesisEmbedding(
  oneLiner: string,
  summary: string,
  nodeType: string
): Promise<number[]> {
  // Combine fields for richer embedding
  const combined = `[${nodeType}] ${oneLiner}\n\n${summary}`;
  return generateEmbedding(combined);
}
