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
  ): SynthesisNode;

  /**
   * Get a node by ID
   */
  getNode(id: string): SynthesisNode | undefined;

  /**
   * Query nodes with filters
   */
  queryNodes(filters: NodeQueryFilters): SynthesisNode[];

  /**
   * Update node access count and timestamp
   */
  updateNodeAccess(nodeId: string): void;

  /**
   * Get nodes by session ID
   */
  getNodesBySession(sessionId: string): SynthesisNode[];

  /**
   * Get all unique session IDs
   */
  getAllSessionIds(): string[];

  // ============ Vector Operations ============

  /**
   * Insert or update embedding for a node
   */
  insertEmbedding(nodeId: string, embedding: number[]): void;

  /**
   * Search nodes by vector similarity
   */
  searchByVector(
    queryEmbedding: number[],
    limit: number,
    minScore: number,
    nodeTypes?: NodeType[]
  ): SearchResult[];

  // ============ Edge Operations ============

  /**
   * Create a new edge between nodes
   */
  createEdge(edge: Omit<SynthesisEdge, 'id' | 'created_at'>): SynthesisEdge;

  /**
   * Check if edge exists between two nodes (in either direction)
   */
  edgeExists(nodeId1: string, nodeId2: string): boolean;

  /**
   * Get orphan nodes (nodes with no edges)
   */
  getOrphanNodes(nodeTypes?: NodeType[]): SynthesisNode[];

  /**
   * Get edge count for a node
   */
  getEdgeCount(nodeId: string): number;

  /**
   * Get related nodes with their edges
   */
  getRelatedNodes(nodeId: string): RelatedNode[];

  // ============ Raw Content Operations ============

  /**
   * Create raw content record
   */
  createRawContent(content: Omit<RawContent, 'created_at'>): RawContent;

  /**
   * Get raw content by session
   */
  getRawContentBySession(sessionId: string, limit?: number): RawContent[];

  /**
   * Get raw content by synthesis node
   */
  getRawContentBySynthesis(synthesisNodeId: string): RawContent[];

  /**
   * Get raw content by IDs
   */
  getRawContentByIds(ids: string[]): RawContent[];

  /**
   * Link raw content to synthesis node
   */
  linkRawContentToSynthesis(rawContentIds: string[], synthesisNodeId: string): void;

  // ============ Synthesis Queue Operations ============

  /**
   * Create synthesis queue item
   */
  createSynthesisQueueItem(
    item: Omit<SynthesisQueue, 'id' | 'started_at' | 'completed_at'>
  ): SynthesisQueue;

  /**
   * Get pending synthesis queue items
   */
  getPendingSynthesisQueue(filters?: { limit?: number }): SynthesisQueue[];

  /**
   * Get synthesis queue items with filters
   */
  getSynthesisQueueItems(filters: SynthesisQueueFilters): SynthesisQueue[];

  /**
   * Update synthesis queue item status
   */
  updateSynthesisQueueStatus(
    id: number,
    status: SynthesisQueueStatus,
    synthesisNodeId?: string | null,
    error?: string | null
  ): void;

  /**
   * Increment retry count for queue item
   */
  incrementSynthesisQueueRetry(id: number): void;

  /**
   * Reset stuck synthesis items
   */
  resetStuckSynthesisItems(timeoutMs: number): number;

  /**
   * Get queue statistics
   */
  getQueueStats(): QueueStats;

  // ============ Progressive Disclosure Operations ============

  /**
   * Create progressive disclosure event
   */
  createProgressiveDisclosureEvent(
    event: Omit<ProgressiveDisclosureEvent, 'id' | 'created_at'>
  ): ProgressiveDisclosureEvent;

  /**
   * Get progressive disclosure analytics
   */
  getProgressiveDisclosureAnalytics(
    startTime: number,
    endTime: number
  ): ProgressiveDisclosureAnalytics;

  // ============ Hybrid Search (PostgreSQL only) ============

  /**
   * Perform hybrid search combining vector, BM25, and trigram
   * Falls back to vector-only for SQLite
   */
  hybridSearch?(options: HybridSearchOptions): HybridSearchResult[];

  /**
   * Search by BM25 keyword ranking (PostgreSQL only)
   */
  searchByBM25?(query: string, limit: number): SearchResult[];

  /**
   * Search by trigram similarity (PostgreSQL only)
   */
  searchByTrigram?(
    query: string,
    limit: number,
    threshold?: number
  ): SearchResult[];

  // ============ Utility ============

  /**
   * Close database connection
   */
  close(): void;

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
