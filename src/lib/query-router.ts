/**
 * Query Router
 *
 * Routes queries to appropriate memory types based on topic analysis.
 * Part of the Active Retrieval pipeline (Epic 3).
 *
 * Routes:
 * - Core memory: persona/human preferences (always-inject, not routed here)
 * - Synthesis: decisions, learnings, entities, events, tasks, summaries
 * - Combined results with score normalization
 */

import type {
  ISynthesisDatabase,
  HybridSearchOptions,
  HybridSearchResult,
} from '../db/index.js';
import type { NodeType, SearchResult } from '../schema.js';
import { supportsHybridSearch } from '../db/index.js';

// Memory types for routing
export type MemoryType = 'core' | 'synthesis';

/**
 * Query plan for a single topic
 */
export interface QueryPlan {
  topic: string;
  targetMemoryTypes: MemoryType[];
  nodeTypes?: NodeType[];
  priority: number;
  dateRange?: {
    after?: number;
    before?: number;
  };
}

/**
 * Result from a single memory type query
 */
export interface RouteResult {
  memoryType: MemoryType;
  results: SearchResult[];
  latencyMs: number;
  queryPlan: QueryPlan;
  error?: string;
}

/**
 * Merged result with source attribution
 */
export interface MergedResult extends SearchResult {
  sourceMemoryType: MemoryType;
  normalizedScore: number;
  originalScore: number;
}

/**
 * Final merged results from all queries
 */
export interface MergedResults {
  results: MergedResult[];
  routingDecisions: QueryPlan[];
  totalLatencyMs: number;
  errors: string[];
}

/**
 * Configuration for the query router
 */
export interface QueryRouterConfig {
  maxResultsPerType?: number;
  minScore?: number;
  useHybridSearch?: boolean;
  hybridWeights?: {
    vector?: number;
    bm25?: number;
    trigram?: number;
  };
  debugLogging?: boolean;
}

// Default configuration
const DEFAULT_CONFIG: Required<QueryRouterConfig> = {
  maxResultsPerType: 10,
  minScore: 0.3,
  useHybridSearch: true,
  hybridWeights: {
    vector: 0.6,
    bm25: 0.3,
    trigram: 0.1,
  },
  debugLogging: false,
};

// Topic pattern matchers for routing decisions
const ROUTING_PATTERNS: Array<{
  pattern: RegExp;
  nodeTypes: NodeType[];
  priority: number;
}> = [
  // Decision-related queries
  {
    pattern: /\b(decision|decided|chose|choice|selected|picked)\b/i,
    nodeTypes: ['decision'],
    priority: 1,
  },
  // Learning/how-to queries
  {
    pattern: /\b(learned|learning|how to|understand|understood)\b/i,
    nodeTypes: ['learning'],
    priority: 1,
  },
  // Entity queries (who/what is)
  {
    pattern: /\b(who is|what is|entity|person|company|service|api)\b/i,
    nodeTypes: ['entity'],
    priority: 1,
  },
  // Event/temporal queries
  {
    pattern: /\b(when|happened|event|occurred|deployed|released|launched)\b/i,
    nodeTypes: ['event'],
    priority: 1,
  },
  // Task queries
  {
    pattern: /\b(task|todo|assigned|working on|implement|fix|bug)\b/i,
    nodeTypes: ['task'],
    priority: 1,
  },
  // Summary queries
  {
    pattern: /\b(summary|summarize|overview|recap|session)\b/i,
    nodeTypes: ['summary'],
    priority: 1,
  },
];

export class QueryRouter {
  private db: ISynthesisDatabase;
  private config: Required<QueryRouterConfig>;
  private embedder?: (text: string) => Promise<number[]>;

  constructor(
    db: ISynthesisDatabase,
    config?: QueryRouterConfig,
    embedder?: (text: string) => Promise<number[]>
  ) {
    this.db = db;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.embedder = embedder;
  }

  /**
   * Plan queries based on topics
   */
  planQueries(topics: string[], context?: string): QueryPlan[] {
    const plans: QueryPlan[] = [];

    for (const topic of topics) {
      const plan = this.planSingleQuery(topic, context);
      plans.push(plan);
    }

    // Deduplicate plans with same node types
    return this.deduplicatePlans(plans);
  }

  /**
   * Plan a single query based on topic analysis
   */
  private planSingleQuery(topic: string, _context?: string): QueryPlan {
    // Check for pattern matches
    for (const { pattern, nodeTypes, priority } of ROUTING_PATTERNS) {
      if (pattern.test(topic)) {
        return {
          topic,
          targetMemoryTypes: ['synthesis'],
          nodeTypes,
          priority,
        };
      }
    }

    // Default: search all synthesis node types
    return {
      topic,
      targetMemoryTypes: ['synthesis'],
      priority: 0,
    };
  }

  /**
   * Deduplicate plans that would search the same node types
   */
  private deduplicatePlans(plans: QueryPlan[]): QueryPlan[] {
    const seen = new Map<string, QueryPlan>();

    for (const plan of plans) {
      const key = plan.nodeTypes ? [...plan.nodeTypes].sort().join(',') : 'all';
      const existing = seen.get(key);

      if (!existing || plan.priority > existing.priority) {
        seen.set(key, plan);
      }
    }

    return Array.from(seen.values());
  }

  /**
   * Execute queries across memory types
   */
  async executeQueries(plans: QueryPlan[]): Promise<RouteResult[]> {
    const results: RouteResult[] = [];
    const startTime = Date.now();

    // Execute all queries in parallel
    const promises = plans.map(async (plan) => {
      const queryStart = Date.now();

      try {
        const searchResults = await this.executeSingleQuery(plan);
        return {
          memoryType: 'synthesis' as MemoryType,
          results: searchResults,
          latencyMs: Date.now() - queryStart,
          queryPlan: plan,
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (this.config.debugLogging) {
          console.error(`[QueryRouter] Query failed for topic "${plan.topic}":`, error);
        }
        return {
          memoryType: 'synthesis' as MemoryType,
          results: [],
          latencyMs: Date.now() - queryStart,
          queryPlan: plan,
          error: errorMessage,
        };
      }
    });

    const queryResults = await Promise.all(promises);
    results.push(...queryResults);

    if (this.config.debugLogging) {
      console.error(
        `[QueryRouter] Executed ${plans.length} queries in ${Date.now() - startTime}ms`
      );
    }

    return results;
  }

  /**
   * Execute a single query
   */
  private async executeSingleQuery(plan: QueryPlan): Promise<SearchResult[]> {
    // Use hybrid search if available and configured
    if (this.config.useHybridSearch && supportsHybridSearch(this.db)) {
      const options: HybridSearchOptions = {
        query: plan.topic,
        maxResults: this.config.maxResultsPerType,
        minScore: this.config.minScore,
        nodeTypes: plan.nodeTypes,
        searchMode: 'hybrid',
        weights: this.config.hybridWeights,
      };

      // Generate embedding if embedder is available
      if (this.embedder) {
        options.queryEmbedding = await this.embedder(plan.topic);
      }

      const results = await this.db.hybridSearch(options);
      return results.map(this.normalizeHybridResult);
    }

    // Fallback to vector search
    if (!this.embedder) {
      if (this.config.debugLogging) {
        console.warn('[QueryRouter] No embedder available, returning empty results');
      }
      return [];
    }

    const embedding = await this.embedder(plan.topic);
    return this.db.searchByVector(
      embedding,
      this.config.maxResultsPerType,
      this.config.minScore,
      plan.nodeTypes
    );
  }

  /**
   * Normalize hybrid search result to standard SearchResult
   */
  private normalizeHybridResult(result: HybridSearchResult): SearchResult {
    return {
      node_id: result.node_id,
      one_liner: result.one_liner,
      score: result.score,
      node_type: result.node_type,
      created_at: result.created_at,
    };
  }

  /**
   * Merge and deduplicate results from multiple queries
   */
  mergeResults(routeResults: RouteResult[]): MergedResults {
    const allResults: MergedResult[] = [];
    const errors: string[] = [];
    let totalLatencyMs = 0;

    // Collect all results with source attribution
    for (const route of routeResults) {
      totalLatencyMs = Math.max(totalLatencyMs, route.latencyMs);

      if (route.error) {
        errors.push(`${route.queryPlan.topic}: ${route.error}`);
        continue;
      }

      for (const result of route.results) {
        allResults.push({
          ...result,
          sourceMemoryType: route.memoryType,
          normalizedScore: result.score,
          originalScore: result.score,
        });
      }
    }

    // Deduplicate by node_id, keeping highest score
    const deduplicated = this.deduplicateResults(allResults);

    // Sort by normalized score descending
    deduplicated.sort((a, b) => b.normalizedScore - a.normalizedScore);

    return {
      results: deduplicated,
      routingDecisions: routeResults.map((r) => r.queryPlan),
      totalLatencyMs,
      errors,
    };
  }

  /**
   * Deduplicate results by node_id, keeping highest score
   */
  private deduplicateResults(results: MergedResult[]): MergedResult[] {
    const seen = new Map<string, MergedResult>();

    for (const result of results) {
      const existing = seen.get(result.node_id);

      if (!existing || result.normalizedScore > existing.normalizedScore) {
        seen.set(result.node_id, result);
      }
    }

    return Array.from(seen.values());
  }

  /**
   * Convenience method: route and execute queries for topics
   */
  async routeAndExecute(
    topics: string[],
    context?: string
  ): Promise<MergedResults> {
    const plans = this.planQueries(topics, context);
    const results = await this.executeQueries(plans);
    return this.mergeResults(results);
  }

  /**
   * Get routing explanation for debugging
   */
  explainRouting(topics: string[]): Array<{
    topic: string;
    matchedPattern: string | null;
    targetNodeTypes: NodeType[] | null;
    priority: number;
  }> {
    return topics.map((topic) => {
      for (const { pattern, nodeTypes, priority } of ROUTING_PATTERNS) {
        if (pattern.test(topic)) {
          return {
            topic,
            matchedPattern: pattern.source,
            targetNodeTypes: nodeTypes,
            priority,
          };
        }
      }

      return {
        topic,
        matchedPattern: null,
        targetNodeTypes: null,
        priority: 0,
      };
    });
  }
}

/**
 * Create a QueryRouter instance
 */
export function createQueryRouter(
  db: ISynthesisDatabase,
  config?: QueryRouterConfig,
  embedder?: (text: string) => Promise<number[]>
): QueryRouter {
  return new QueryRouter(db, config, embedder);
}
