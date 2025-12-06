/**
 * Standalone synthesis worker entry point
 * Runs independently of the MCP server to process synthesis queue
 */

import { getDatabase, type SynthesisDatabase } from './db.js';
import { initEmbeddings } from './embeddings.js';
import { LLMSynthesisClient } from './llm-synthesis.js';
import { SynthesisWorker } from './synthesis-worker.js';

// Configuration from environment
interface WorkerConfig {
  apiKey: string;
  batchSize: number;
  pollInterval: number;
  stuckTimeout: number;
  maxRetries: number;
}

function loadConfig(): WorkerConfig {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    console.error('ERROR: ANTHROPIC_API_KEY environment variable is required');
    process.exit(1);
  }

  return {
    apiKey,
    batchSize: Number(process.env.SYNTHESIS_BATCH_SIZE) || 10,
    pollInterval: Number(process.env.SYNTHESIS_POLL_INTERVAL) || 10000,
    stuckTimeout: Number(process.env.SYNTHESIS_STUCK_TIMEOUT) || 300000,
    maxRetries: Number(process.env.SYNTHESIS_MAX_RETRIES) || 3,
  };
}

let db: SynthesisDatabase | null = null;
let worker: SynthesisWorker | null = null;

async function shutdown(signal: string): Promise<void> {
  console.log(`\nReceived ${signal}, shutting down gracefully...`);

  if (worker) {
    await worker.stop();
    worker = null;
  }

  if (db) {
    db.close();
    db = null;
  }

  console.log('Shutdown complete');
  process.exit(0);
}

async function main(): Promise<void> {
  const config = loadConfig();

  // Log configuration on startup
  console.log('Starting Total Recall Synthesis Worker');
  console.log('Configuration:');
  console.log(`  Batch Size: ${config.batchSize}`);
  console.log(`  Poll Interval: ${config.pollInterval}ms`);
  console.log(`  Stuck Timeout: ${config.stuckTimeout}ms`);
  console.log(`  Max Retries: ${config.maxRetries}`);

  // Initialize database
  db = getDatabase();
  console.log('Database initialized');

  // Pre-load embeddings
  try {
    await initEmbeddings();
  } catch (error) {
    console.error('Warning: Failed to pre-load embedding model:', error);
  }

  // Reset stuck items
  const recovered = db.resetStuckSynthesisItems(config.stuckTimeout);
  if (recovered > 0) {
    console.log(`Recovered ${recovered} stuck synthesis items`);
  }

  // Create LLM client and worker
  const llmClient = new LLMSynthesisClient(config.apiKey);
  worker = new SynthesisWorker(db, llmClient, {
    batchSize: config.batchSize,
    pollInterval: config.pollInterval,
    maxRetries: config.maxRetries,
  });

  // Setup graceful shutdown handlers
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Start worker
  await worker.start();
  console.log('Synthesis worker is now running');
}

main().catch((error) => {
  console.error('Fatal error starting synthesis worker:', error);
  process.exit(1);
});
