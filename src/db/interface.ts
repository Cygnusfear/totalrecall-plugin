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
   */
  searchByVector(
    queryEmbedding: number[],
    limit: number,
    minScore: number,
    nodeTypes?: NodeType[]
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
