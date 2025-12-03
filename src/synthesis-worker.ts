/**
 * Background worker for processing synthesis queue
 */

import type { SynthesisDatabase } from './db.js';
import type { SynthesisQueue } from './schema.js';
import { LLMSynthesisClient, type ConversationChunk } from './llm-synthesis.js';
import { generateSynthesisEmbedding } from './embeddings.js';

export interface SynthesisWorkerConfig {
  pollInterval?: number; // ms, default 30000 (30s)
  batchSize?: number; // Process N items per poll, default 5
  maxRetries?: number; // Max retries per item, default 3
}

export class SynthesisWorker {
  private running = false;
  private pollInterval: number;
  private batchSize: number;
  private maxRetries: number;
  private pollTimeout: NodeJS.Timeout | null = null;

  constructor(
    private db: SynthesisDatabase,
    private llmClient: LLMSynthesisClient,
    config: SynthesisWorkerConfig = {}
  ) {
    this.pollInterval = config.pollInterval || 30000;
    this.batchSize = config.batchSize || 5;
    this.maxRetries = config.maxRetries || 3;
  }

  async start(): Promise<void> {
    if (this.running) {
      console.warn('[SynthesisWorker] Already running');
      return;
    }

    this.running = true;
    console.log(
      `[SynthesisWorker] Started (poll: ${this.pollInterval}ms, batch: ${this.batchSize})`
    );

    const connected = await this.llmClient.testConnection();
    if (!connected) {
      console.error('[SynthesisWorker] LLM client connection test failed');
    }

    this.poll();
  }

  async stop(): Promise<void> {
    console.log('[SynthesisWorker] Stopping...');
    this.running = false;

    if (this.pollTimeout) {
      clearTimeout(this.pollTimeout);
      this.pollTimeout = null;
    }

    console.log('[SynthesisWorker] Stopped');
  }

  private poll(): void {
    if (!this.running) return;

    this.processNextBatch()
      .catch((error) => {
        console.error('[SynthesisWorker] Batch processing error:', error);
      })
      .finally(() => {
        if (this.running) {
          this.pollTimeout = setTimeout(() => this.poll(), this.pollInterval);
        }
      });
  }

  private async processNextBatch(): Promise<void> {
    const items = this.db.getPendingSynthesisQueue({ limit: this.batchSize });

    if (items.length === 0) {
      return;
    }

    console.log(`[SynthesisWorker] Processing ${items.length} items`);

    const results = await Promise.allSettled(
      items.map((item) => this.processSynthesisItem(item))
    );

    const succeeded = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.filter((r) => r.status === 'rejected').length;

    if (failed > 0) {
      console.warn(`[SynthesisWorker] Batch: ${succeeded} succeeded, ${failed} failed`);
    } else {
      console.log(`[SynthesisWorker] Batch complete: ${succeeded} processed`);
    }
  }

  private async processSynthesisItem(item: SynthesisQueue): Promise<void> {
    console.log(
      `[SynthesisWorker] Processing queue item ${item.id} (session: ${item.session_id})`
    );

    this.db.updateSynthesisQueueStatus(item.id, 'processing');

    try {
      const rawContentIds: string[] = JSON.parse(item.raw_content_ids);
      const rawContent = this.db.getRawContentByIds(rawContentIds);

      if (rawContent.length === 0) {
        throw new Error('No raw content found for synthesis');
      }

      const alreadySynthesized = rawContent.filter((rc) => rc.synthesis_node_id !== null);
      if (alreadySynthesized.length === rawContent.length) {
        console.log(`[SynthesisWorker] Content already synthesized for item ${item.id}`);
        this.db.updateSynthesisQueueStatus(item.id, 'completed');
        return;
      }

      const chunks: ConversationChunk[] = rawContent.map((rc) => ({
        id: rc.id,
        content: rc.content,
        timestamp: rc.timestamp,
        agent_id: rc.agent_id,
      }));

      const context = {
        session_id: item.session_id,
        task_context: item.context || undefined,
        repo: undefined,
      };

      console.log(`[SynthesisWorker] Calling LLM for synthesis (${chunks.length} chunks)`);
      const synthesis = await this.llmClient.synthesize(chunks, context);

      const now = Date.now();
      const node = this.db.createNode({
        node_type: synthesis.node_type,
        one_liner: synthesis.one_liner,
        summary: synthesis.summary,
        full_synthesis: synthesis.full_synthesis,
        entity_name: synthesis.entity_name || null,
        entity_aliases: null,
        temporal_context: synthesis.temporal_context || null,
        first_seen: now,
        last_updated: now,
        status: null,
        assigned_agent: item.agent_id,
        priority: null,
        source_session_id: item.session_id,
        source_agent_id: item.agent_id,
        source_repo: null,
      });

      // Generate embedding for new node
      try {
        const embedding = await generateSynthesisEmbedding(
          synthesis.one_liner,
          synthesis.summary,
          synthesis.node_type
        );
        this.db.insertEmbedding(node.id, embedding);
      } catch (e) {
        console.error('[SynthesisWorker] Failed to generate embedding:', e);
      }

      console.log(`[SynthesisWorker] Created synthesis node ${node.id}`);

      this.db.linkRawContentToSynthesis(rawContentIds, node.id);
      this.db.updateSynthesisQueueStatus(item.id, 'completed', node.id);

      console.log(`[SynthesisWorker] Queue item ${item.id} completed`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[SynthesisWorker] Failed item ${item.id}:`, errorMessage);

      if (item.retry_count < this.maxRetries) {
        console.log(`[SynthesisWorker] Retrying item ${item.id}`);
        this.db.incrementSynthesisQueueRetry(item.id);
      } else {
        console.error(`[SynthesisWorker] Item ${item.id} failed after ${this.maxRetries} retries`);
        this.db.updateSynthesisQueueStatus(item.id, 'failed', null, errorMessage);
      }

      throw error;
    }
  }

  getStatus(): {
    running: boolean;
    pollInterval: number;
    batchSize: number;
    maxRetries: number;
  } {
    return {
      running: this.running,
      pollInterval: this.pollInterval,
      batchSize: this.batchSize,
      maxRetries: this.maxRetries,
    };
  }
}
