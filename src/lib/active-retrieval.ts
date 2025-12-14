/**
 * Active Retrieval Pipeline
 *
 * Orchestrates the full Active Retrieval flow:
 * Topic Inference → Query Router → Memory Handlers → Context Formatter
 *
 * This is the main integration point for Epic 3 components.
 */

import type { ISynthesisDatabase } from '../db/index.js';
import type { NodeType } from '../schema.js';
import { TopicInferenceService } from './topic-inference.js';
import { QueryRouter, createQueryRouter, type MergedResult } from './query-router.js';
import {
  ContextFormatter,
  createContextFormatter,
  type FormattedMemory,
  type FormatOptions,
} from './context-formatter.js';
import { CoreMemoryService, createCoreMemoryService, type CoreMemoryBlocks } from './core-memory.js';

/**
 * Result from the Active Retrieval pipeline
 */
export interface ActiveRetrievalResult {
  formattedContext: string;
  coreMemory: CoreMemoryBlocks | null;
  retrievedMemories: MergedResult[];
  metrics: ActiveRetrievalMetrics;
}

/**
 * Metrics for pipeline execution
 */
export interface ActiveRetrievalMetrics {
  totalMs: number;
  inferenceMs: number;
  coreMemoryMs: number;
  routingMs: number;
  formatMs: number;
  topicCount: number;
  resultCount: number;
}

/**
 * Configuration for Active Retrieval
 */
export interface ActiveRetrievalConfig {
  // Topic inference
  topicInferenceEnabled?: boolean;
  maxTopics?: number;
  topicConfidenceThreshold?: number;

  // Query routing
  maxResultsPerType?: number;
  minScore?: number;
  useHybridSearch?: boolean;

  // Formatting
  verbosity?: 'minimal' | 'standard' | 'verbose';
  maxTokens?: number;
  includeCoreMemory?: boolean;
  includeNodeIds?: boolean;

  // Debugging
  debugLogging?: boolean;
}

const DEFAULT_CONFIG: Required<ActiveRetrievalConfig> = {
  topicInferenceEnabled: true,
  maxTopics: 3,
  topicConfidenceThreshold: 0.5,
  maxResultsPerType: 10,
  minScore: 0.3,
  useHybridSearch: true,
  verbosity: 'standard',
  maxTokens: 4000,
  includeCoreMemory: true,
  includeNodeIds: true,
  debugLogging: false,
};

/**
 * Active Retrieval Pipeline
 */
export class ActiveRetrievalPipeline {
  private topicService: TopicInferenceService | null;
  private queryRouter: QueryRouter;
  private contextFormatter: ContextFormatter;
  private coreMemoryService: CoreMemoryService;
  private config: Required<ActiveRetrievalConfig>;

  constructor(
    db: ISynthesisDatabase,
    embedder: (text: string) => Promise<number[]>,
    apiKey?: string,
    config?: ActiveRetrievalConfig
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Initialize components
    this.topicService = apiKey
      ? new TopicInferenceService(apiKey, { enabled: true })
      : null;

    this.queryRouter = createQueryRouter(
      db,
      {
        maxResultsPerType: this.config.maxResultsPerType,
        minScore: this.config.minScore,
        useHybridSearch: this.config.useHybridSearch,
        debugLogging: this.config.debugLogging,
      },
      embedder
    );

    this.contextFormatter = createContextFormatter();
    this.coreMemoryService = createCoreMemoryService(db);
  }

  /**
   * Execute the full Active Retrieval pipeline
   */
  async retrieve(
    userPrompt: string,
    sessionContext?: string
  ): Promise<ActiveRetrievalResult> {
    const startTime = Date.now();
    const metrics: ActiveRetrievalMetrics = {
      totalMs: 0,
      inferenceMs: 0,
      coreMemoryMs: 0,
      routingMs: 0,
      formatMs: 0,
      topicCount: 0,
      resultCount: 0,
    };

    // Parallel: topic inference + core memory fetch
    const inferenceStart = Date.now();
    const coreMemoryStart = Date.now();

    const [topicsResult, coreMemory] = await Promise.all([
      this.inferTopics(userPrompt),
      this.config.includeCoreMemory
        ? this.coreMemoryService.getBlocks()
        : Promise.resolve(null),
    ]);

    metrics.inferenceMs = Date.now() - inferenceStart;
    metrics.coreMemoryMs = Date.now() - coreMemoryStart;
    metrics.topicCount = topicsResult.topics.length;

    // Route and execute queries
    const routingStart = Date.now();
    const mergedResults = await this.queryRouter.routeAndExecute(
      topicsResult.topics,
      sessionContext
    );
    metrics.routingMs = Date.now() - routingStart;
    metrics.resultCount = mergedResults.results.length;

    // Format results
    const formatStart = Date.now();
    const formattedMemories = this.convertToFormattedMemories(mergedResults.results);

    const formatOptions: FormatOptions = {
      verbosity: this.config.verbosity,
      maxTokens: this.config.maxTokens,
      includeCoreMemory: this.config.includeCoreMemory && coreMemory !== null,
      includeNodeIds: this.config.includeNodeIds,
    };

    const formattedContext = this.contextFormatter.formatForInjection(
      formattedMemories,
      coreMemory ?? undefined,
      formatOptions
    );
    metrics.formatMs = Date.now() - formatStart;

    metrics.totalMs = Date.now() - startTime;

    if (this.config.debugLogging) {
      console.error('[ActiveRetrieval] Metrics:', JSON.stringify(metrics));
    }

    return {
      formattedContext,
      coreMemory,
      retrievedMemories: mergedResults.results,
      metrics,
    };
  }

  /**
   * Infer topics from user prompt
   */
  private async inferTopics(
    userPrompt: string
  ): Promise<{ topics: string[]; confidence: number }> {
    // Use topic inference if available and enabled
    if (this.config.topicInferenceEnabled && this.topicService) {
      try {
        const result = await this.topicService.inferTopics(userPrompt, {
          maxTopics: this.config.maxTopics,
        });

        if (result.confidence >= this.config.topicConfidenceThreshold) {
          return { topics: result.topics, confidence: result.confidence };
        }
      } catch (error) {
        if (this.config.debugLogging) {
          console.error('[ActiveRetrieval] Topic inference failed:', error);
        }
        // Fall through to fallback
      }
    }

    // Fallback: use the original prompt as a single topic
    return { topics: [userPrompt], confidence: 0.5 };
  }

  /**
   * Convert MergedResults to FormattedMemory for the formatter
   */
  private convertToFormattedMemories(results: MergedResult[]): FormattedMemory[] {
    return results.map((r) => ({
      content: r.one_liner,
      type: r.node_type as NodeType,
      source: `memory`, // Could be enhanced with session ID if available
      confidence: r.normalizedScore,
      ageMs: Date.now() - r.created_at,
      nodeId: r.node_id,
      oneLiner: r.one_liner,
    }));
  }

  /**
   * Simple retrieval without topic inference (for fallback)
   */
  async simpleRetrieve(userPrompt: string): Promise<ActiveRetrievalResult> {
    const startTime = Date.now();

    // Get core memory
    const coreMemory = this.config.includeCoreMemory
      ? await this.coreMemoryService.getBlocks()
      : null;

    // Direct search using the prompt as query
    const mergedResults = await this.queryRouter.routeAndExecute([userPrompt]);

    // Format results
    const formattedMemories = this.convertToFormattedMemories(mergedResults.results);
    const formattedContext = this.contextFormatter.formatForInjection(
      formattedMemories,
      coreMemory ?? undefined,
      {
        verbosity: this.config.verbosity,
        maxTokens: this.config.maxTokens,
        includeCoreMemory: this.config.includeCoreMemory,
        includeNodeIds: this.config.includeNodeIds,
      }
    );

    return {
      formattedContext,
      coreMemory,
      retrievedMemories: mergedResults.results,
      metrics: {
        totalMs: Date.now() - startTime,
        inferenceMs: 0,
        coreMemoryMs: 0,
        routingMs: Date.now() - startTime,
        formatMs: 0,
        topicCount: 1,
        resultCount: mergedResults.results.length,
      },
    };
  }
}

/**
 * Create an ActiveRetrievalPipeline instance
 */
export function createActiveRetrievalPipeline(
  db: ISynthesisDatabase,
  embedder: (text: string) => Promise<number[]>,
  apiKey?: string,
  config?: ActiveRetrievalConfig
): ActiveRetrievalPipeline {
  return new ActiveRetrievalPipeline(db, embedder, apiKey, config);
}
