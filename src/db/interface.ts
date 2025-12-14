/**
 * Total Recall v3 - Database Interface
 * Defines the contract that both SQLite and PostgreSQL implementations must fulfill
 */

import type {
  SynthesisNode,
  SynthesisEdge,
  NodeType,
  EdgeType,
  SearchResult,
  RawContent,
  SynthesisQueue,
  SynthesisQueueStatus,
  SynthesisQueueChunkType,
  ProgressiveDisclosureEvent,
  ProgressiveDisclosureEventType,
  CoreMemoryBlock,
  CoreMemoryBlockType,
} from '../schema.js';

/**
 * Query filters for nodes
 */
export interface NodeQueryFilters {
  node_types?: NodeType[];
  session_id?: string;
  limit?: number;
  order_by?: 'created_at' | 'last_updated';
}

/**
 * Synthesis queue query filters
 */
export interface SynthesisQueueFilters {
  session_id?: string;
  status?: SynthesisQueueStatus;
  limit?: number;
}

/**
 * Queue statistics
 */
export interface QueueStats {
  pending: number;
  processing: number;
  completed: number;
  failed: number;
}

/**
 * Progressive disclosure analytics
 */
export interface ProgressiveDisclosureAnalytics {
  totalSearches: number;
  totalInjections: number;
  totalExpansions: number;
  avgSearchLatency: number;
  expansionRate: number;
  totalInjectionTokens: number;
  totalExpansionTokens: number;
}

/**
 * Related node with edge information
 */
export interface RelatedNode {
  node: SynthesisNode;
  edge: SynthesisEdge;
}

/**
 * Search ranking configuration
 * Controls how different factors influence search result ordering
 */
export interface SearchRankingConfig {
  /**
   * Weight for recency (0-1)
   * Higher = more recent nodes ranked higher
   * Default: 0.3
   */
  recencyWeight?: number;

  /**
   * Weight for node type importance (0-1)
   * Uses type importance scores to prioritize certain node types
   * Default: 0.2
   */
  nodeTypeWeight?: number;

  /**
   * Weight for relationship density (0-1)
   * Nodes with more connections ranked higher
   * Default: 0.1
   */
  relationshipWeight?: number;

  /**
   * Weight for base similarity score (0-1)
   * The vector/BM25/trigram similarity
   * Default: 0.4
   */
  similarityWeight?: number;

  /**
   * Recency decay factor (days)
   * How quickly recency bonus decays over time
   * Default: 30 days
   */
  recencyDecayDays?: number;

  /**
   * Node type importance scores
   * Custom importance values for different node types
   * Default: decision=1.0, entity=0.9, learning=0.8, task=0.7, summary=0.6, event=0.5
   */
  nodeTypeScores?: Partial<Record<NodeType, number>>;
}

/**
 * Default ranking configuration
 */
export const DEFAULT_RANKING_CONFIG: Required<SearchRankingConfig> = {
  recencyWeight: 0.3,
  nodeTypeWeight: 0.2,
  relationshipWeight: 0.1,
  similarityWeight: 0.4,
  recencyDecayDays: 30,
  nodeTypeScores: {
    decision: 1.0,
    entity: 0.9,
    learning: 0.8,
    task: 0.7,
    summary: 0.6,
    event: 0.5,
  },
};

/**
 * Hybrid search options (PostgreSQL only)
 */
export interface HybridSearchOptions {
  query: string;
  queryEmbedding?: number[];
  maxResults?: number;
  minScore?: number;
  nodeTypes?: NodeType[];
  searchMode?: 'vector' | 'bm25' | 'trigram' | 'hybrid';
  weights?: {
    vector?: number;
    bm25?: number;
    trigram?: number;
  };
  /**
   * Custom ranking configuration
   * If not provided, uses DEFAULT_RANKING_CONFIG
   */
  rankingConfig?: SearchRankingConfig;
}

/**
 * Hybrid search result with component scores
 */
export interface HybridSearchResult extends SearchResult {
  vectorRank?: number;
  bm25Rank?: number;
  trigramRank?: number;
  matchType?: 'vector' | 'bm25' | 'trigram' | 'hybrid';
}

/**
 * Database interface - All implementations must implement this
 */
export interface ISynthesisDatabase {
  // ============ Node Operations ============

  /**
   * Create a new synthesis node
   */
  createNode(
    node: Omit<SynthesisNode, 'id' | 'created_at' | 'updated_at' | 'access_count' | 'last_accessed'>
  ): Promise<SynthesisNode>;

  /**
   * Get a node by ID
   */
  getNode(id: string): Promise<SynthesisNode | undefined>;

  /**
   * Query nodes with filters
   */
  queryNodes(filters: NodeQueryFilters): Promise<SynthesisNode[]>;

  /**
   * Update node access count and timestamp
   */
  updateNodeAccess(nodeId: string): Promise<void>;

  /**
   * Get nodes by session ID
   */
  getNodesBySession(sessionId: string): Promise<SynthesisNode[]>;

  /**
   * Get all unique session IDs
   */
  getAllSessionIds(): Promise<string[]>;

  /**
   * Query nodes by ID prefix (like git short hashes)
   * Efficient database-level prefix matching instead of loading all nodes
   */
  queryNodesByIdPrefix(prefix: string, limit?: number): Promise<SynthesisNode[]>;

  /**
   * Search nodes by exact text match (LIKE) across all text fields
   * Returns nodes where the term appears in one_liner, summary, full_synthesis,
   * entity_name, or entity_aliases (case-insensitive)
   */
  searchNodesByText(
    term: string,
    limit?: number,
    nodeTypes?: NodeType[]
  ): Promise<Array<SynthesisNode & { match_location: 'one_liner' | 'summary' | 'full_synthesis' | 'entity_name' | 'entity_aliases' }>>;

  // ============ Vector Operations ============

  /**
   * Insert or update embedding for a node
   */
  insertEmbedding(nodeId: string, embedding: number[]): Promise<void>;

  /**
   * Search nodes by vector similarity
   * Now includes intelligent ranking based on recency, type, and relationships
   */
  searchByVector(
    queryEmbedding: number[],
    limit: number,
    minScore: number,
    nodeTypes?: NodeType[],
    rankingConfig?: SearchRankingConfig
  ): Promise<SearchResult[]>;

  // ============ Edge Operations ============

  /**
   * Create a new edge between nodes
   */
  createEdge(edge: Omit<SynthesisEdge, 'id' | 'created_at'>): Promise<SynthesisEdge>;

  /**
   * Check if edge exists between two nodes (in either direction)
   */
  edgeExists(nodeId1: string, nodeId2: string): Promise<boolean>;

  /**
   * Get orphan nodes (nodes with no edges)
   */
  getOrphanNodes(nodeTypes?: NodeType[]): Promise<SynthesisNode[]>;

  /**
   * Get edge count for a node
   */
  getEdgeCount(nodeId: string): Promise<number>;

  /**
   * Get related nodes with their edges
   */
  getRelatedNodes(nodeId: string): Promise<RelatedNode[]>;

  // ============ Raw Content Operations ============

  /**
   * Create raw content record
   */
  createRawContent(content: Omit<RawContent, 'created_at'>): Promise<RawContent>;

  /**
   * Get raw content by session
   */
  getRawContentBySession(sessionId: string, limit?: number): Promise<RawContent[]>;

  /**
   * Get raw content by synthesis node
   */
  getRawContentBySynthesis(synthesisNodeId: string): Promise<RawContent[]>;

  /**
   * Get raw content by IDs
   */
  getRawContentByIds(ids: string[]): Promise<RawContent[]>;

  /**
   * Link raw content to synthesis node
   */
  linkRawContentToSynthesis(rawContentIds: string[], synthesisNodeId: string): Promise<void>;

  /**
   * Search raw content by text (case-insensitive LIKE search)
   */
  searchRawContentByText(
    query: string,
    limit?: number,
    includeOrphans?: boolean
  ): Promise<RawContent[]>;

  // ============ Raw Content Vector Operations ============

  /**
   * Insert embedding for raw content
   */
  insertRawEmbedding(rawContentId: string, embedding: number[]): Promise<void>;

  /**
   * Search raw content by vector similarity
   */
  searchRawByVector(
    queryEmbedding: number[],
    limit: number,
    minScore: number,
    includeOrphans?: boolean
  ): Promise<Array<RawContent & { score: number }>>;

  /**
   * Get raw content that doesn't have embeddings yet (for backfill)
   */
  getRawContentWithoutEmbedding(limit?: number): Promise<RawContent[]>;

  /**
   * Get count of raw content embeddings
   */
  getRawEmbeddingCount(): Promise<number>;

  // ============ Synthesis Queue Operations ============

  /**
   * Create synthesis queue item
   */
  createSynthesisQueueItem(
    item: Omit<SynthesisQueue, 'id' | 'started_at' | 'completed_at'>
  ): Promise<SynthesisQueue>;

  /**
   * Get pending synthesis queue items
   */
  getPendingSynthesisQueue(filters?: { limit?: number }): Promise<SynthesisQueue[]>;

  /**
   * Get synthesis queue items with filters
   */
  getSynthesisQueueItems(filters: SynthesisQueueFilters): Promise<SynthesisQueue[]>;

  /**
   * Update synthesis queue item status
   */
  updateSynthesisQueueStatus(
    id: number,
    status: SynthesisQueueStatus,
    synthesisNodeId?: string | null,
    error?: string | null
  ): Promise<void>;

  /**
   * Increment retry count for queue item
   */
  incrementSynthesisQueueRetry(id: number): Promise<void>;

  /**
   * Reset stuck synthesis items
   */
  resetStuckSynthesisItems(timeoutMs: number): Promise<number>;

  /**
   * Get queue statistics
   */
  getQueueStats(): Promise<QueueStats>;

  // ============ Progressive Disclosure Operations ============

  /**
   * Create progressive disclosure event
   */
  createProgressiveDisclosureEvent(
    event: Omit<ProgressiveDisclosureEvent, 'id' | 'created_at'>
  ): Promise<ProgressiveDisclosureEvent>;

  /**
   * Get progressive disclosure analytics
   */
  getProgressiveDisclosureAnalytics(
    startTime: number,
    endTime: number
  ): Promise<ProgressiveDisclosureAnalytics>;

  // ============ Hybrid Search (PostgreSQL only) ============

  /**
   * Perform hybrid search combining vector, BM25, and trigram
   * Falls back to vector-only for SQLite
   */
  hybridSearch?(options: HybridSearchOptions): Promise<HybridSearchResult[]>;

  /**
   * Search by BM25 keyword ranking (PostgreSQL only)
   */
  searchByBM25?(query: string, limit: number): Promise<SearchResult[]>;

  /**
   * Search by trigram similarity (PostgreSQL only)
   */
  searchByTrigram?(
    query: string,
    limit: number,
    threshold?: number
  ): Promise<SearchResult[]>;

  // ============ Core Memory Operations (Epic 4) ============

  /**
   * Get a core memory block by type
   */
  getCoreMemoryBlock(blockType: CoreMemoryBlockType): Promise<CoreMemoryBlock | null>;

  /**
   * Get all core memory blocks
   */
  getAllCoreMemoryBlocks(): Promise<CoreMemoryBlock[]>;

  /**
   * Set (upsert) a core memory block
   */
  setCoreMemoryBlock(
    blockType: CoreMemoryBlockType,
    content: string,
    tokenEstimate: number
  ): Promise<CoreMemoryBlock>;

  /**
   * Delete a core memory block
   */
  deleteCoreMemoryBlock(blockType: CoreMemoryBlockType): Promise<boolean>;

  // ============ Memory Consolidation / Salience Scoring (Issue #13) ============

  /**
   * Calculate salience scores for all nodes
   * Returns nodes sorted by salience (most salient first)
   * Used for memory consolidation and identifying important memories
   */
  calculateMemorySalience(
    config?: SalienceConfig,
    limit?: number
  ): Promise<SalienceResult[]>;

  /**
   * Get low-salience nodes (candidates for archival/pruning)
   * Returns nodes below the salience threshold
   */
  getLowSalienceNodes(
    threshold?: number,
    config?: SalienceConfig,
    limit?: number
  ): Promise<SalienceResult[]>;

  // ============ Time-Based Queries (Issue #10) ============

  /**
   * Query nodes by time range
   * Returns nodes created or updated within the specified time window
   */
  queryNodesByTimeRange(
    startTime: number,
    endTime: number,
    options?: {
      nodeTypes?: NodeType[];
      limit?: number;
      orderBy?: 'created_at' | 'last_updated';
    }
  ): Promise<SynthesisNode[]>;

  /**
   * Get activity summary for a time period
   * Returns grouped statistics and representative nodes
   */
  getActivitySummary(
    startTime: number,
    endTime: number,
    options?: {
      groupBy?: 'type' | 'date' | 'both';
      includeNodeSamples?: boolean;
      maxSamplesPerGroup?: number;
    }
  ): Promise<ActivitySummary>;

  // ============ Utility ============

  /**
   * Close database connection
   */
  close(): Promise<void>;

  /**
   * Get backend type
   */
  getBackendType(): 'sqlite' | 'postgres';

  /**
   * Check if backend supports hybrid search
   */
  supportsHybridSearch(): boolean;
}

/**
 * Type guard to check if database supports hybrid search
 */
export function supportsHybridSearch(
  db: ISynthesisDatabase
): db is ISynthesisDatabase & Required<Pick<ISynthesisDatabase, 'hybridSearch' | 'searchByBM25' | 'searchByTrigram'>> {
  return db.supportsHybridSearch();
}

// ============ Shared Utilities for Text Search ============

/** Match location type for text search results */
export type TextSearchMatchLocation = 'one_liner' | 'summary' | 'full_synthesis' | 'entity_name' | 'entity_aliases';

/** Search field configuration for priority-based text search */
export interface TextSearchField {
  location: TextSearchMatchLocation;
  column: string;
  priority: number;
}

/** Default search fields in priority order (lowest = highest priority) */
export const TEXT_SEARCH_FIELDS: TextSearchField[] = [
  { location: 'entity_name', column: 'entity_name', priority: 1 },
  { location: 'one_liner', column: 'one_liner', priority: 2 },
  { location: 'entity_aliases', column: 'entity_aliases', priority: 3 },
  { location: 'summary', column: 'summary', priority: 4 },
  { location: 'full_synthesis', column: 'full_synthesis', priority: 5 },
];

/**
 * Process and deduplicate text search results by priority
 * Shared between SQLite and PostgreSQL implementations
 */
export function processTextSearchResults<T extends { id: string; last_updated: number }>(
  results: Array<T & { match_location: TextSearchMatchLocation; priority: number }>,
  limit: number
): Array<T & { match_location: TextSearchMatchLocation }> {
  // Sort by priority (best match location first), then by last_updated
  results.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return b.last_updated - a.last_updated;
  });

  // Return only the node & match_location (not the internal priority)
  return results.slice(0, limit).map((r) => {
    const { priority: _priority, ...nodeWithLocation } = r;
    return nodeWithLocation as T & { match_location: TextSearchMatchLocation };
  });
}

// ============ Shared Utilities for Search Ranking ============

/**
 * Extended search result with ranking metadata
 */
export interface RankedSearchResult extends SearchResult {
  rankingScore: number;
  recencyScore?: number;
  typeScore?: number;
  relationshipScore?: number;
  edgeCount?: number;
}

/**
 * Calculate recency score with exponential decay
 * Returns 0-1 where 1 = most recent
 */
export function calculateRecencyScore(
  createdAt: number,
  decayDays: number = 30
): number {
  const now = Date.now();
  const ageMs = now - createdAt;
  const ageDays = ageMs / (1000 * 60 * 60 * 24);

  // Exponential decay: score = e^(-age/decay)
  // At decay days: score = 0.368 (e^-1)
  // At 2x decay days: score = 0.135 (e^-2)
  return Math.exp(-ageDays / decayDays);
}

/**
 * Calculate node type importance score
 * Returns 0-1 based on node type importance
 */
export function calculateTypeScore(
  nodeType: NodeType,
  typeScores: Record<NodeType, number>
): number {
  return typeScores[nodeType] ?? 0.5; // Default to 0.5 if type not found
}

/**
 * Calculate relationship density score
 * Normalizes edge count to 0-1 scale with logarithmic scaling
 * Returns 0-1 where higher edge count = higher score
 */
export function calculateRelationshipScore(edgeCount: number): number {
  if (edgeCount === 0) return 0;

  // Logarithmic scaling: log(1 + edges) / log(101)
  // This maps 0->0, 10->0.52, 100->1.0
  // Prevents highly connected nodes from dominating
  return Math.log(1 + Math.min(edgeCount, 100)) / Math.log(101);
}

/**
 * Apply multi-factor ranking to search results
 * Combines similarity, recency, type importance, and relationship density
 */
export function applySearchRanking<T extends SearchResult>(
  results: T[],
  edgeCounts: Map<string, number>,
  config: SearchRankingConfig = {}
): RankedSearchResult[] {
  // Merge config with defaults
  const fullConfig: Required<SearchRankingConfig> = {
    ...DEFAULT_RANKING_CONFIG,
    ...config,
    nodeTypeScores: {
      ...DEFAULT_RANKING_CONFIG.nodeTypeScores,
      ...(config.nodeTypeScores ?? {}),
    },
  };

  // Calculate component scores for each result
  const rankedResults: RankedSearchResult[] = results.map((result) => {
    const recencyScore = calculateRecencyScore(
      result.created_at,
      fullConfig.recencyDecayDays
    );

    const typeScore = calculateTypeScore(
      result.node_type,
      fullConfig.nodeTypeScores as Record<NodeType, number>
    );

    const edgeCount = edgeCounts.get(result.node_id) ?? 0;
    const relationshipScore = calculateRelationshipScore(edgeCount);

    // Weighted combination of all factors
    const rankingScore =
      fullConfig.similarityWeight * result.score +
      fullConfig.recencyWeight * recencyScore +
      fullConfig.nodeTypeWeight * typeScore +
      fullConfig.relationshipWeight * relationshipScore;

    return {
      ...result,
      rankingScore,
      recencyScore,
      typeScore,
      relationshipScore,
      edgeCount,
    };
  });

  // Sort by ranking score (descending)
  rankedResults.sort((a, b) => b.rankingScore - a.rankingScore);

  return rankedResults;
}

// ============ Salience Scoring (Memory Consolidation / Dreaming) ============

/**
 * Salience configuration for memory consolidation
 */
export interface SalienceConfig {
  /**
   * Weight for access frequency (0-1)
   * How much access count matters for salience
   * Default: 0.4
   */
  accessWeight?: number;

  /**
   * Weight for recency of access (0-1)
   * How much recent access matters
   * Default: 0.3
   */
  accessRecencyWeight?: number;

  /**
   * Weight for relationship connections (0-1)
   * Nodes with many relationships are more salient
   * Default: 0.2
   */
  relationshipWeight?: number;

  /**
   * Weight for node type importance (0-1)
   * Default: 0.1
   */
  nodeTypeWeight?: number;

  /**
   * Decay half-life in days
   * How quickly unaccessed memories lose salience
   * Default: 90 days
   */
  decayHalfLifeDays?: number;

  /**
   * Minimum salience threshold for retention
   * Nodes below this are candidates for archival/pruning
   * Default: 0.1 (keep 90% of memories)
   */
  minSalienceThreshold?: number;
}

/**
 * Default salience configuration
 */
export const DEFAULT_SALIENCE_CONFIG: Required<SalienceConfig> = {
  accessWeight: 0.4,
  accessRecencyWeight: 0.3,
  relationshipWeight: 0.2,
  nodeTypeWeight: 0.1,
  decayHalfLifeDays: 90,
  minSalienceThreshold: 0.1,
};

/**
 * Node with computed salience score
 */
export interface SalienceResult {
  node_id: string;
  one_liner: string;
  node_type: NodeType;
  salience_score: number;
  access_count: number;
  last_accessed: number | null;
  edge_count: number;
  created_at: number;
  // Component scores for debugging
  access_score?: number;
  access_recency_score?: number;
  relationship_score?: number;
  type_score?: number;
}

/**
 * Calculate access frequency score
 * Uses logarithmic scaling to prevent highly accessed nodes from dominating
 * Returns 0-1 where 1 = very frequently accessed
 */
export function calculateAccessScore(accessCount: number): number {
  if (accessCount === 0) return 0;

  // Logarithmic scaling: log(1 + access_count) / log(1001)
  // This maps 0->0, 10->0.50, 100->0.75, 1000->1.0
  return Math.log(1 + Math.min(accessCount, 1000)) / Math.log(1001);
}

/**
 * Calculate access recency score with exponential decay
 * Returns 0-1 where 1 = accessed very recently
 */
export function calculateAccessRecencyScore(
  lastAccessed: number | null,
  decayHalfLifeDays: number = 90
): number {
  if (lastAccessed === null) return 0;

  const now = Date.now();
  const ageMs = now - lastAccessed;
  const ageDays = ageMs / (1000 * 60 * 60 * 24);

  // Exponential decay with half-life: score = 0.5^(age/half-life)
  // At half-life: score = 0.5
  // At 2x half-life: score = 0.25
  return Math.pow(0.5, ageDays / decayHalfLifeDays);
}

/**
 * Calculate salience score for a memory node
 * Combines access patterns, relationships, and importance
 * Returns 0-1 where higher = more salient (important to keep)
 */
export function calculateSalienceScore(
  accessCount: number,
  lastAccessed: number | null,
  edgeCount: number,
  nodeType: NodeType,
  config: SalienceConfig = {}
): number {
  const fullConfig: Required<SalienceConfig> = {
    ...DEFAULT_SALIENCE_CONFIG,
    ...config,
  };

  // Component scores
  const accessScore = calculateAccessScore(accessCount);
  const accessRecencyScore = calculateAccessRecencyScore(
    lastAccessed,
    fullConfig.decayHalfLifeDays
  );
  const relationshipScore = calculateRelationshipScore(edgeCount);
  const typeScore = calculateTypeScore(
    nodeType,
    DEFAULT_RANKING_CONFIG.nodeTypeScores as Record<NodeType, number>
  );

  // Weighted combination
  const salienceScore =
    fullConfig.accessWeight * accessScore +
    fullConfig.accessRecencyWeight * accessRecencyScore +
    fullConfig.relationshipWeight * relationshipScore +
    fullConfig.nodeTypeWeight * typeScore;

  return Math.min(1.0, Math.max(0.0, salienceScore));
}

/**
 * Apply salience decay to unaccessed memories
 * Reduces salience for nodes that haven't been accessed recently
 * This simulates memory consolidation / forgetting
 */
export function applySalienceDecay(
  currentSalience: number,
  daysSinceLastAccess: number,
  decayHalfLifeDays: number = 90
): number {
  if (daysSinceLastAccess === 0) return currentSalience;

  // Exponential decay: salience *= 0.5^(days/half-life)
  const decayFactor = Math.pow(0.5, daysSinceLastAccess / decayHalfLifeDays);
  return currentSalience * decayFactor;
}

// ============ Time-Based Activity Summary (Issue #10) ============

/**
 * Activity group for a specific node type or date
 */
export interface ActivityGroup {
  groupKey: string; // e.g., "decision", "2025-01-15", or "decision:2025-01-15"
  nodeType?: NodeType;
  date?: string; // YYYY-MM-DD
  count: number;
  sampleNodes?: Array<{
    node_id: string;
    one_liner: string;
    created_at: number;
  }>;
}

/**
 * Activity summary for a time period
 */
export interface ActivitySummary {
  timeRange: {
    start: number;
    end: number;
    durationMs: number;
  };
  totalNodes: number;
  groups: ActivityGroup[];
  nodeTypeDistribution: Record<NodeType, number>;
  dailyActivity?: Array<{
    date: string;
    count: number;
  }>;
}

/**
 * Time window presets for convenience
 */
export const TIME_WINDOWS = {
  TODAY: () => {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
    return { start: start.getTime(), end: end.getTime() };
  },
  YESTERDAY: () => {
    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const start = new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate(), 0, 0, 0);
    const end = new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate(), 23, 59, 59);
    return { start: start.getTime(), end: end.getTime() };
  },
  THIS_WEEK: () => {
    const now = new Date();
    const dayOfWeek = now.getDay();
    const start = new Date(now.getTime() - dayOfWeek * 24 * 60 * 60 * 1000);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000 - 1);
    return { start: start.getTime(), end: end.getTime() };
  },
  LAST_WEEK: () => {
    const thisWeek = TIME_WINDOWS.THIS_WEEK();
    const start = thisWeek.start - 7 * 24 * 60 * 60 * 1000;
    const end = thisWeek.start - 1;
    return { start, end };
  },
  THIS_MONTH: () => {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
    return { start: start.getTime(), end: end.getTime() };
  },
  LAST_MONTH: () => {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth() - 1, 1, 0, 0, 0);
    const end = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);
    return { start: start.getTime(), end: end.getTime() };
  },
  LAST_7_DAYS: () => {
    const now = Date.now();
    return { start: now - 7 * 24 * 60 * 60 * 1000, end: now };
  },
  LAST_30_DAYS: () => {
    const now = Date.now();
    return { start: now - 30 * 24 * 60 * 60 * 1000, end: now };
  },
} as const;
