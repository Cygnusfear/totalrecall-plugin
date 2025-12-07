/**
 * Background worker for processing synthesis queue
 */

import type { SynthesisDatabase } from './db.js';
import type { SynthesisQueue, SynthesisNode, EdgeType } from './schema.js';
import { LLMSynthesisClient, type ConversationChunk } from './llm-synthesis.js';
import { generateSynthesisEmbedding } from './embeddings.js';
import { Semaphore } from './semaphore.js';
import { TimeSummaryService, type TimeSummaryServiceConfig } from './time-summary-service.js';

// Config for auto-relationship building
const AUTO_RELATIONSHIP_CONFIG = {
  minSimilarity: 0.5,
  maxEdges: 3, // Keep it light for auto-building
  useLLM: true, // Use LLM validation
};

export interface SynthesisWorkerConfig {
  pollInterval?: number; // ms, default 30000 (30s)
  batchSize?: number; // Process N items per poll, default 5
  maxRetries?: number; // Max retries per item, default 3
  maxConcurrency?: number; // Max concurrent processing, default 5
  timeSummary?: TimeSummaryServiceConfig; // Config for time-based summaries
}

export class SynthesisWorker {
  private running = false;
  private pollInterval: number;
  private batchSize: number;
  private maxRetries: number;
  private maxConcurrency: number;
  private pollTimeout: NodeJS.Timeout | null = null;
  private semaphore: Semaphore;
  private activeProcessing = 0;
  private timeSummaryService: TimeSummaryService;

  constructor(
    private db: SynthesisDatabase,
    private llmClient: LLMSynthesisClient,
    config: SynthesisWorkerConfig = {}
  ) {
    this.pollInterval = config.pollInterval || 30000;
    this.batchSize = config.batchSize || 5;
    this.maxRetries = config.maxRetries || 3;
    this.maxConcurrency = config.maxConcurrency || 5;
    this.semaphore = new Semaphore(this.maxConcurrency);
    this.timeSummaryService = new TimeSummaryService(db, llmClient, config.timeSummary);
  }

  /**
   * Get the time summary service for external access (e.g., MCP tools)
   */
  getTimeSummaryService(): TimeSummaryService {
    return this.timeSummaryService;
  }

  async start(): Promise<void> {
    if (this.running) {
      console.warn('[SynthesisWorker] Already running');
      return;
    }

    this.running = true;
    console.log(
      `[SynthesisWorker] Started (poll: ${this.pollInterval}ms, batch: ${this.batchSize}, concurrency: ${this.maxConcurrency})`
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

    // Wait for active processing to complete (max 30 seconds)
    const maxWait = 30000;
    const checkInterval = 100;
    let waited = 0;

    while (this.activeProcessing > 0 && waited < maxWait) {
      await new Promise(resolve => setTimeout(resolve, checkInterval));
      waited += checkInterval;
    }

    if (this.activeProcessing > 0) {
      console.warn(`[SynthesisWorker] Stopped with ${this.activeProcessing} active tasks still running`);
    }

    console.log('[SynthesisWorker] Stopped');
  }

  private poll(): void {
    if (!this.running) return;

    this.runPollCycle()
      .catch((error) => {
        console.error('[SynthesisWorker] Poll cycle error:', error);
      })
      .finally(() => {
        if (this.running) {
          this.pollTimeout = setTimeout(() => this.poll(), this.pollInterval);
        }
      });
  }

  /**
   * Run a single poll cycle: check time summaries, then process synthesis queue
   */
  private async runPollCycle(): Promise<void> {
    // Check and generate time summaries (hourly/daily roll-ups)
    try {
      await this.timeSummaryService.checkAndGenerateSummaries();
    } catch (error) {
      console.error('[SynthesisWorker] Time summary error:', error);
    }

    // Process regular synthesis queue
    await this.processNextBatch();
  }

  private async processNextBatch(): Promise<void> {
    // Fetch batchSize items but process with bounded concurrency via semaphore
    // This prevents memory exhaustion from 100+ concurrent CLI processes
    const items = this.db.getPendingSynthesisQueue({ limit: this.batchSize });

    if (items.length === 0) {
      return;
    }

    console.log(`[SynthesisWorker] Processing batch of ${items.length} items (max concurrency: ${this.maxConcurrency})`);

    // Process all items with bounded concurrency using semaphore
    const promises = items.map(async (item) => {
      await this.semaphore.withPermit(async () => {
        this.activeProcessing++;
        try {
          console.log(`[SynthesisWorker] Processing item ${item.id} (session: ${item.session_id})`);
          await this.processSynthesisItem(item);
          console.log(`[SynthesisWorker] Item ${item.id} completed`);
        } catch (error) {
          // Error already logged in processSynthesisItem
          // Continue to next item
        } finally {
          this.activeProcessing--;
        }
      });
    });

    await Promise.all(promises);
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
      let embedding: number[] | null = null;
      try {
        embedding = await generateSynthesisEmbedding(
          synthesis.one_liner,
          synthesis.summary,
          synthesis.node_type,
          {
            entityName: synthesis.entity_name,
          }
        );
        this.db.insertEmbedding(node.id, embedding);
      } catch (e) {
        console.error('[SynthesisWorker] Failed to generate embedding:', e);
      }

      console.log(`[SynthesisWorker] Created synthesis node ${node.id}`);

      // Dream: connect new memory to the graph
      if (embedding) {
        try {
          await this.dream(node, embedding);
        } catch (e) {
          console.error('[SynthesisWorker] Dream interrupted:', e);
        }
      }

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

  /**
   * Dream: connect a new memory to the graph by finding and validating relationships
   * Like sleep consolidation, this runs in the background after synthesis
   */
  private async dream(
    node: SynthesisNode,
    embedding: number[]
  ): Promise<number> {
    const { minSimilarity, maxEdges, useLLM } = AUTO_RELATIONSHIP_CONFIG;

    // Find similar nodes
    const candidates = this.db.searchByVector(embedding, maxEdges * 2, minSimilarity);

    let edgesCreated = 0;

    for (const candidate of candidates) {
      // Skip self
      if (candidate.node_id === node.id) continue;

      // Skip if edge already exists
      if (this.db.edgeExists(node.id, candidate.node_id)) continue;

      const targetNode = this.db.getNode(candidate.node_id);
      if (!targetNode) continue;

      let edgeType: EdgeType = 'relates_to';

      // Use LLM to validate and classify relationship
      if (useLLM) {
        try {
          const classification = await this.llmClient.classifyRelationship(
            {
              one_liner: node.one_liner,
              summary: node.summary,
              node_type: node.node_type,
              created_at: node.created_at,
              entity_name: node.entity_name,
              temporal_context: node.temporal_context,
              source_repo: node.source_repo,
              source_session_id: node.source_session_id,
            },
            {
              one_liner: targetNode.one_liner,
              summary: targetNode.summary,
              node_type: targetNode.node_type,
              created_at: targetNode.created_at,
              entity_name: targetNode.entity_name,
              temporal_context: targetNode.temporal_context,
              source_repo: targetNode.source_repo,
              source_session_id: targetNode.source_session_id,
            }
          );

          if (!classification.has_relationship) {
            console.log(`[SynthesisWorker] Dreaming... rejected ${node.id.slice(0, 8)} <-> ${candidate.node_id.slice(0, 8)}`);
            continue;
          }

          edgeType = classification.edge_type as EdgeType;
          console.log(`[SynthesisWorker] Dreaming... connected ${node.id.slice(0, 8)} -> ${candidate.node_id.slice(0, 8)} (${edgeType})`);
        } catch (e) {
          // On LLM error, use heuristics
          console.warn('[SynthesisWorker] LLM classification failed, using heuristics:', e);
          edgeType = this.determineEdgeType(node, targetNode);
        }
      } else {
        edgeType = this.determineEdgeType(node, targetNode);
      }

      // Create the edge
      this.db.createEdge({
        from_node_id: node.id,
        to_node_id: candidate.node_id,
        edge_type: edgeType,
        weight: candidate.score,
        context: 'auto-built during synthesis',
      });

      edgesCreated++;
      if (edgesCreated >= maxEdges) break;
    }

    console.log(`[SynthesisWorker] Dream complete: ${edgesCreated} connections formed for ${node.id.slice(0, 8)}`);
    return edgesCreated;
  }

  /**
   * Heuristic edge type determination (fallback)
   */
  private determineEdgeType(from: SynthesisNode, to: SynthesisNode): EdgeType {
    if (from.node_type === 'decision' && to.node_type === 'task') return 'caused';
    if (from.node_type === 'summary' && from.source_session_id === to.source_session_id) return 'contains';
    if (from.source_session_id === to.source_session_id && from.created_at < to.created_at) return 'preceded';
    return 'relates_to';
  }

  getStatus(): {
    running: boolean;
    pollInterval: number;
    batchSize: number;
    maxRetries: number;
    maxConcurrency: number;
    activeProcessing: number;
    semaphore: { available: number; waiting: number; max: number };
  } {
    return {
      running: this.running,
      pollInterval: this.pollInterval,
      batchSize: this.batchSize,
      maxRetries: this.maxRetries,
      maxConcurrency: this.maxConcurrency,
      activeProcessing: this.activeProcessing,
      semaphore: this.semaphore.getStatus(),
    };
  }
}
