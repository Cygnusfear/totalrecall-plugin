/**
 * CLI: prompt-enrich
 * Called by UserPromptSubmit hook to inject relevant memory context per-message
 *
 * Supports two modes:
 * - Active Retrieval (ACTIVE_RETRIEVAL_ENABLED=true): Full pipeline with topic inference
 * - Simple Search (default): Direct vector search (faster, simpler)
 *
 * Reads user prompt from stdin, performs search, and outputs
 * formatted context as additionalContext.
 */

import { getDatabase } from '../db.js';
import { generateEmbedding, initEmbeddings } from '../embeddings.js';
import { createActiveRetrievalPipeline } from '../lib/active-retrieval.js';
import { createContextFormatter } from '../lib/context-formatter.js';
import { createCoreMemoryService } from '../lib/core-memory.js';

interface HookInput {
  prompt?: string;
  transcript_path?: string;
}

// Configuration from environment
const ACTIVE_RETRIEVAL_ENABLED = process.env.ACTIVE_RETRIEVAL_ENABLED === 'true';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const DEBUG_LOGGING = process.env.TOTALRECALL_DEBUG === 'true';

// Simple search constants (legacy mode)
const MIN_SCORE = 0.5;
const MAX_RESULTS = 4;
const MIN_PROMPT_LENGTH = 10;

/**
 * Active Retrieval mode - full pipeline with topic inference
 */
async function activeRetrievalEnrich(prompt: string): Promise<string | null> {
  const db = getDatabase();

  try {
    const pipeline = createActiveRetrievalPipeline(
      db,
      generateEmbedding,
      ANTHROPIC_API_KEY,
      {
        topicInferenceEnabled: !!ANTHROPIC_API_KEY,
        maxTopics: 3,
        minScore: 0.3,
        maxResultsPerType: 8,
        verbosity: 'standard',
        maxTokens: 4000,
        includeCoreMemory: true,
        includeNodeIds: true,
        debugLogging: DEBUG_LOGGING,
      }
    );

    const result = await pipeline.retrieve(prompt);

    // Log metrics if debug enabled
    if (DEBUG_LOGGING) {
      console.error(
        `[totalrecall] Active Retrieval: ${result.metrics.totalMs}ms ` +
          `(inference: ${result.metrics.inferenceMs}ms, ` +
          `routing: ${result.metrics.routingMs}ms, ` +
          `format: ${result.metrics.formatMs}ms) ` +
          `topics: ${result.metrics.topicCount}, results: ${result.metrics.resultCount}`
      );
    }

    // Return formatted context or null if empty
    return result.formattedContext || null;
  } finally {
    await db.close();
  }
}

/**
 * Simple search mode - direct vector search (legacy, faster)
 */
async function simpleSearchEnrich(prompt: string): Promise<string | null> {
  const db = getDatabase();

  try {
    const startTime = Date.now();

    // Generate embedding for user's prompt
    const queryEmbedding = await generateEmbedding(prompt);

    // Search for relevant synthesis nodes
    const results = await db.searchByVector(queryEmbedding, MAX_RESULTS, MIN_SCORE);

    if (results.length === 0) {
      return null;
    }

    // Get core memory blocks
    const coreMemoryService = createCoreMemoryService(db);
    const coreMemory = await coreMemoryService.getBlocks();

    // Use the new formatter for consistent output
    const formatter = createContextFormatter();
    const formattedMemories = results.map((r) => ({
      content: r.one_liner,
      type: r.node_type,
      source: 'memory',
      confidence: r.score,
      ageMs: Date.now() - r.created_at,
      nodeId: r.node_id,
      oneLiner: r.one_liner,
    }));

    const formatted = formatter.formatForInjection(formattedMemories, coreMemory, {
      verbosity: 'standard',
      includeCoreMemory: true,
      includeNodeIds: true,
    });

    if (DEBUG_LOGGING) {
      console.error(
        `[totalrecall] Simple search: ${Date.now() - startTime}ms, results: ${results.length}`
      );
    }

    return formatted || null;
  } finally {
    await db.close();
  }
}

async function main() {
  // Check for disable toggle
  if (process.env.TOTALRECALL_ENRICH === 'false') {
    process.exit(0);
  }

  // Read hook input from stdin
  let input: HookInput = {};
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    const stdinData = Buffer.concat(chunks).toString('utf-8').trim();
    if (stdinData) {
      input = JSON.parse(stdinData);
    }
  } catch {
    // No stdin or invalid JSON - skip enrichment
    process.exit(0);
  }

  const prompt = input.prompt;
  if (!prompt || prompt.length < MIN_PROMPT_LENGTH) {
    // Skip very short prompts (likely commands or acknowledgments)
    process.exit(0);
  }

  try {
    // Initialize embeddings (cold start ~1-2s)
    await initEmbeddings();

    // Choose enrichment mode
    let formattedContext: string | null;

    if (ACTIVE_RETRIEVAL_ENABLED) {
      formattedContext = await activeRetrievalEnrich(prompt);
    } else {
      formattedContext = await simpleSearchEnrich(prompt);
    }

    if (!formattedContext) {
      // No relevant context found
      process.exit(0);
    }

    // Output hook response
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: formattedContext,
        },
      })
    );
  } catch (error) {
    // On error, fail silently to not block user prompt
    console.error(`[totalrecall] prompt-enrich error: ${error}`);
    process.exit(0);
  }
}

main();
