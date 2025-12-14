/**
 * Total Recall v3 - PostgreSQL Database Implementation
 * Uses VectorChord Suite for vector search and BM25 for keyword ranking
 *
 * NOTE: This implementation is ASYNC and does not yet conform to the synchronous
 * ISynthesisDatabase interface. PostgreSQL support is a work in progress.
 *
 * For v3 Epic 1, SQLite remains the default and fully supported backend.
 * PostgreSQL implementation will be completed in a future Epic with full async support.
 */

import postgres from 'postgres';
import { initPool, getPool } from './pg-pool.js';
import type {
  SynthesisNode,
  SynthesisEdge,
  NodeType,
  SearchResult,
  RawContent,
  SynthesisQueue,
  SynthesisQueueStatus,
  ProgressiveDisclosureEvent,
} from '../schema.js';
import type {
  ISynthesisDatabase,
  NodeQueryFilters,
  SynthesisQueueFilters,
  QueueStats,
  ProgressiveDisclosureAnalytics,
  RelatedNode,
  HybridSearchOptions,
  HybridSearchResult,
} from './interface.js';

/**
 * PostgreSQL database configuration
 */
export interface PostgresDbConfig {
  connectionString: string;
  poolSize?: number;
  poolTimeout?: number;
  connectionTimeout?: number;
  vectorchordProbes?: number;
  vectorDimension?: 384 | 768 | 1536;
}

/**
 * PostgreSQL implementation (async - does not yet implement ISynthesisDatabase)
 * TODO: Either make interface async or create sync wrapper
 */
export class PostgresSynthesisDatabase {
  private sql: postgres.Sql;
  private probes: number;
  private dimension: number;

  constructor(config: PostgresDbConfig) {
    this.probes = config.vectorchordProbes ?? 10;
    this.dimension = config.vectorDimension ?? 384;

    // Initialize connection pool
    this.sql = initPool({
      connectionString: config.connectionString,
      poolSize: config.poolSize,
      poolTimeout: config.poolTimeout,
      connectionTimeout: config.connectionTimeout,
    });

    // Set VectorChord probes for this connection
    this.setVectorChordProbes(this.probes).catch((err) => {
      console.warn('Failed to set VectorChord probes:', err);
    });
  }

  /**
   * Set VectorChord probes for vector search recall/speed tradeoff
   */
  private async setVectorChordProbes(probes: number): Promise<void> {
    await this.sql`SET vectorchord.probes = ${probes}`;
  }

  // ============ Node Operations ============

  async createNode(
    node: Omit<SynthesisNode, 'id' | 'created_at' | 'updated_at' | 'access_count' | 'last_accessed'>
  ): Promise<SynthesisNode> {
    const now = Date.now();

    const [result] = await this.sql`
      INSERT INTO synthesis_nodes (
        node_type, one_liner, summary, full_synthesis,
        entity_name, entity_aliases, temporal_context, first_seen, last_updated,
        status, assigned_agent, priority,
        source_session_id, source_agent_id, source_repo,
        access_count, last_accessed, created_at, updated_at
      ) VALUES (
        ${node.node_type}, ${node.one_liner}, ${node.summary}, ${node.full_synthesis},
        ${node.entity_name}, ${node.entity_aliases}, ${node.temporal_context},
        ${node.first_seen}, ${node.last_updated},
        ${node.status}, ${node.assigned_agent}, ${node.priority},
        ${node.source_session_id}, ${node.source_agent_id}, ${node.source_repo},
        0, NULL, ${now}, ${now}
      )
      RETURNING *
    `;

    return this.mapNodeFromDb(result);
  }

  async getNode(id: string): Promise<SynthesisNode | undefined> {
    const [result] = await this.sql`
      SELECT * FROM synthesis_nodes WHERE id = ${id}
    `;

    return result ? this.mapNodeFromDb(result) : undefined;
  }

  async queryNodes(filters: NodeQueryFilters): Promise<SynthesisNode[]> {
    const { node_types, session_id, limit = 100, order_by = 'last_updated' } = filters;

    let query = this.sql`SELECT * FROM synthesis_nodes WHERE 1=1`;
    const conditions: postgres.PendingQuery<postgres.Row[]>[] = [];

    if (node_types?.length) {
      conditions.push(this.sql`AND node_type = ANY(${node_types})`);
    }
    if (session_id) {
      conditions.push(this.sql`AND source_session_id = ${session_id}`);
    }

    // Build full query
    const orderColumn = order_by === 'created_at' ? 'created_at' : 'last_updated';
    const results = await this.sql`
      SELECT * FROM synthesis_nodes
      WHERE 1=1
      ${node_types?.length ? this.sql`AND node_type = ANY(${node_types})` : this.sql``}
      ${session_id ? this.sql`AND source_session_id = ${session_id}` : this.sql``}
      ORDER BY ${this.sql(orderColumn)} DESC
      LIMIT ${limit}
    `;

    return results.map((r) => this.mapNodeFromDb(r));
  }

  async updateNodeAccess(nodeId: string): Promise<void> {
    await this.sql`
      UPDATE synthesis_nodes
      SET access_count = access_count + 1, last_accessed = ${Date.now()}
      WHERE id = ${nodeId}
    `;
  }

  async getNodesBySession(sessionId: string): Promise<SynthesisNode[]> {
    const results = await this.sql`
      SELECT * FROM synthesis_nodes
      WHERE source_session_id = ${sessionId}
      ORDER BY created_at ASC
    `;

    return results.map((r) => this.mapNodeFromDb(r));
  }

  async getAllSessionIds(): Promise<string[]> {
    const results = await this.sql`
      SELECT source_session_id
      FROM synthesis_nodes
      WHERE source_session_id IS NOT NULL
      GROUP BY source_session_id
      ORDER BY MIN(created_at) DESC
    `;

    return results.map((r) => r.source_session_id as string);
  }

  // ============ Vector Operations ============

  async insertEmbedding(nodeId: string, embedding: number[]): Promise<void> {
    // PostgreSQL pgvector format: [1,2,3]
    const vectorStr = `[${embedding.join(',')}]`;

    await this.sql`
      UPDATE synthesis_nodes
      SET embedding = ${vectorStr}::vector
      WHERE id = ${nodeId}
    `;
  }

  async searchByVector(
    queryEmbedding: number[],
    limit: number,
    minScore: number,
    nodeTypes?: NodeType[]
  ): Promise<SearchResult[]> {
    const vectorStr = `[${queryEmbedding.join(',')}]`;

    // VectorChord uses L2 distance operator <->
    // For normalized vectors: similarity = 1 - (distance^2 / 2)
    const results = await this.sql`
      SELECT
        id as node_id,
        one_liner,
        node_type,
        created_at,
        (embedding <-> ${vectorStr}::vector) as distance
      FROM synthesis_nodes
      WHERE embedding IS NOT NULL
      ${nodeTypes?.length ? this.sql`AND node_type = ANY(${nodeTypes})` : this.sql``}
      ORDER BY embedding <-> ${vectorStr}::vector
      LIMIT ${limit * 2}
    `;

    return results
      .map((r) => ({
        node_id: r.node_id as string,
        one_liner: r.one_liner as string,
        node_type: r.node_type as NodeType,
        created_at: Number(r.created_at),
        score: 1 - (Number(r.distance) ** 2) / 2, // Convert L2 to cosine similarity
      }))
      .filter((r) => r.score >= minScore)
      .slice(0, limit);
  }

  // ============ Hybrid Search (PostgreSQL-only) ============

  async hybridSearch(options: HybridSearchOptions): Promise<HybridSearchResult[]> {
    const {
      query,
      queryEmbedding,
      maxResults = 10,
      minScore = 0.3,
      nodeTypes,
      searchMode = 'hybrid',
      weights = { vector: 1.0, bm25: 1.0, trigram: 0.5 },
    } = options;

    // Vector-only mode
    if (searchMode === 'vector' && queryEmbedding) {
      const results = await this.searchByVector(queryEmbedding, maxResults, minScore, nodeTypes);
      return results.map((r) => ({ ...r, matchType: 'vector' as const }));
    }

    // BM25-only mode
    if (searchMode === 'bm25') {
      return this.searchByBM25(query, maxResults);
    }

    // Trigram-only mode
    if (searchMode === 'trigram') {
      return this.searchByTrigram(query, maxResults, minScore);
    }

    // Hybrid mode - use the stored function
    if (!queryEmbedding) {
      // Fallback to BM25 if no embedding provided
      return this.searchByBM25(query, maxResults);
    }

    const vectorStr = `[${queryEmbedding.join(',')}]`;
    const results = await this.sql`
      SELECT * FROM hybrid_search(
        ${query},
        ${vectorStr}::vector,
        ${maxResults},
        ${minScore},
        ${weights.vector ?? 1.0},
        ${weights.bm25 ?? 1.0},
        ${weights.trigram ?? 0.5},
        60
      )
      ${nodeTypes?.length ? this.sql`WHERE node_type = ANY(${nodeTypes})` : this.sql``}
    `;

    return results.map((r) => ({
      node_id: r.node_id as string,
      one_liner: r.one_liner as string,
      node_type: r.node_type as NodeType,
      score: Number(r.score),
      created_at: Date.now(), // Not returned by hybrid_search
      vectorRank: r.vector_rank !== 1000 ? Number(r.vector_rank) : undefined,
      bm25Rank: r.bm25_rank !== 1000 ? Number(r.bm25_rank) : undefined,
      trigramRank: r.trigram_rank !== 1000 ? Number(r.trigram_rank) : undefined,
      matchType: 'hybrid' as const,
    }));
  }

  async searchByBM25(query: string, limit: number): Promise<SearchResult[]> {
    const results = await this.sql`
      SELECT
        id as node_id,
        one_liner,
        node_type,
        created_at,
        bm25_score(bm25, ${query}) as score
      FROM synthesis_nodes
      WHERE bm25 IS NOT NULL
      ORDER BY score DESC
      LIMIT ${limit}
    `;

    return results.map((r) => ({
      node_id: r.node_id as string,
      one_liner: r.one_liner as string,
      node_type: r.node_type as NodeType,
      created_at: Number(r.created_at),
      score: Number(r.score),
    }));
  }

  async searchByTrigram(
    query: string,
    limit: number,
    threshold: number = 0.3
  ): Promise<SearchResult[]> {
    const results = await this.sql`
      SELECT
        id as node_id,
        one_liner,
        node_type,
        created_at,
        GREATEST(
          similarity(COALESCE(entity_name, ''), ${query}),
          similarity(one_liner, ${query})
        ) as score
      FROM synthesis_nodes
      WHERE
        COALESCE(entity_name, '') % ${query}
        OR one_liner % ${query}
      ORDER BY score DESC
      LIMIT ${limit}
    `;

    return results
      .filter((r) => Number(r.score) >= threshold)
      .map((r) => ({
        node_id: r.node_id as string,
        one_liner: r.one_liner as string,
        node_type: r.node_type as NodeType,
        created_at: Number(r.created_at),
        score: Number(r.score),
      }));
  }

  // ============ Edge Operations ============

  async createEdge(edge: Omit<SynthesisEdge, 'id' | 'created_at'>): Promise<SynthesisEdge> {
    const now = Date.now();

    const [result] = await this.sql`
      INSERT INTO synthesis_edges (from_node_id, to_node_id, edge_type, weight, context, created_at)
      VALUES (${edge.from_node_id}, ${edge.to_node_id}, ${edge.edge_type}, ${edge.weight}, ${edge.context}, ${now})
      ON CONFLICT (from_node_id, to_node_id, edge_type) DO UPDATE
      SET weight = EXCLUDED.weight, context = EXCLUDED.context
      RETURNING *
    `;

    return this.mapEdgeFromDb(result);
  }

  async edgeExists(nodeId1: string, nodeId2: string): Promise<boolean> {
    const [result] = await this.sql`
      SELECT COUNT(*) as count
      FROM synthesis_edges
      WHERE (from_node_id = ${nodeId1} AND to_node_id = ${nodeId2})
         OR (from_node_id = ${nodeId2} AND to_node_id = ${nodeId1})
    `;

    return Number(result.count) > 0;
  }

  async getOrphanNodes(nodeTypes?: NodeType[]): Promise<SynthesisNode[]> {
    const results = await this.sql`
      SELECT * FROM synthesis_nodes
      WHERE id NOT IN (
        SELECT DISTINCT from_node_id FROM synthesis_edges
        UNION
        SELECT DISTINCT to_node_id FROM synthesis_edges
      )
      ${nodeTypes?.length ? this.sql`AND node_type = ANY(${nodeTypes})` : this.sql``}
      ORDER BY created_at DESC
    `;

    return results.map((r) => this.mapNodeFromDb(r));
  }

  async getEdgeCount(nodeId: string): Promise<number> {
    const [result] = await this.sql`
      SELECT COUNT(*) as count
      FROM synthesis_edges
      WHERE from_node_id = ${nodeId} OR to_node_id = ${nodeId}
    `;

    return Number(result.count);
  }

  async getRelatedNodes(nodeId: string): Promise<RelatedNode[]> {
    const results = await this.sql`
      SELECT
        sn.*,
        se.id as edge_id,
        se.from_node_id,
        se.to_node_id,
        se.edge_type,
        se.weight,
        se.context as edge_context,
        se.created_at as edge_created_at
      FROM synthesis_edges se
      JOIN synthesis_nodes sn ON (
        (se.to_node_id = sn.id AND se.from_node_id = ${nodeId}) OR
        (se.from_node_id = sn.id AND se.to_node_id = ${nodeId})
      )
      WHERE sn.id != ${nodeId}
    `;

    return results.map((row) => ({
      node: this.mapNodeFromDb(row),
      edge: {
        id: Number(row.edge_id),
        from_node_id: row.from_node_id as string,
        to_node_id: row.to_node_id as string,
        edge_type: row.edge_type as SynthesisEdge['edge_type'],
        weight: Number(row.weight),
        context: row.edge_context as string | null,
        created_at: Number(row.edge_created_at),
      },
    }));
  }

  // ============ Raw Content Operations ============

  async createRawContent(content: Omit<RawContent, 'created_at'>): Promise<RawContent> {
    const now = Date.now();

    const [result] = await this.sql`
      INSERT INTO raw_content (
        id, session_id, synthesis_node_id, content_type, content,
        agent_id, timestamp, message_index, created_at
      ) VALUES (
        ${content.id}, ${content.session_id}, ${content.synthesis_node_id},
        ${content.content_type}, ${content.content}, ${content.agent_id},
        ${content.timestamp}, ${content.message_index}, ${now}
      )
      RETURNING *
    `;

    return this.mapRawContentFromDb(result);
  }

  async getRawContentBySession(sessionId: string, limit: number = 100): Promise<RawContent[]> {
    const results = await this.sql`
      SELECT * FROM raw_content
      WHERE session_id = ${sessionId}
      ORDER BY timestamp DESC
      LIMIT ${limit}
    `;

    return results.map((r) => this.mapRawContentFromDb(r));
  }

  async getRawContentBySynthesis(synthesisNodeId: string): Promise<RawContent[]> {
    const results = await this.sql`
      SELECT * FROM raw_content
      WHERE synthesis_node_id = ${synthesisNodeId}
      ORDER BY timestamp ASC
    `;

    return results.map((r) => this.mapRawContentFromDb(r));
  }

  async getRawContentByIds(ids: string[]): Promise<RawContent[]> {
    if (ids.length === 0) return [];

    const results = await this.sql`
      SELECT * FROM raw_content
      WHERE id = ANY(${ids})
      ORDER BY timestamp ASC
    `;

    return results.map((r) => this.mapRawContentFromDb(r));
  }

  async linkRawContentToSynthesis(rawContentIds: string[], synthesisNodeId: string): Promise<void> {
    await this.sql`
      UPDATE raw_content
      SET synthesis_node_id = ${synthesisNodeId}
      WHERE id = ANY(${rawContentIds})
    `;
  }

  // ============ Synthesis Queue Operations ============

  async createSynthesisQueueItem(
    item: Omit<SynthesisQueue, 'id' | 'started_at' | 'completed_at'>
  ): Promise<SynthesisQueue> {
    const [result] = await this.sql`
      INSERT INTO synthesis_queue (
        session_id, agent_id, chunk_type, raw_content_ids, context,
        message_count, status, retry_count, error, synthesis_node_id, created_at
      ) VALUES (
        ${item.session_id}, ${item.agent_id}, ${item.chunk_type},
        ${item.raw_content_ids}, ${item.context}, ${item.message_count},
        ${item.status}, ${item.retry_count}, ${item.error},
        ${item.synthesis_node_id}, ${item.created_at}
      )
      RETURNING *
    `;

    return this.mapQueueItemFromDb(result);
  }

  async getPendingSynthesisQueue(filters: { limit?: number } = {}): Promise<SynthesisQueue[]> {
    const { limit = 10 } = filters;

    const results = await this.sql`
      SELECT * FROM synthesis_queue
      WHERE status = 'pending'
      ORDER BY created_at ASC
      LIMIT ${limit}
    `;

    return results.map((r) => this.mapQueueItemFromDb(r));
  }

  async getSynthesisQueueItems(filters: SynthesisQueueFilters): Promise<SynthesisQueue[]> {
    const { session_id, status, limit = 50 } = filters;

    const results = await this.sql`
      SELECT * FROM synthesis_queue
      WHERE 1=1
      ${session_id ? this.sql`AND session_id = ${session_id}` : this.sql``}
      ${status ? this.sql`AND status = ${status}` : this.sql``}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;

    return results.map((r) => this.mapQueueItemFromDb(r));
  }

  async updateSynthesisQueueStatus(
    id: number,
    status: SynthesisQueueStatus,
    synthesisNodeId?: string | null,
    error?: string | null
  ): Promise<void> {
    const now = Date.now();

    const updates: Record<string, any> = { status };

    if (status === 'processing') {
      updates.started_at = now;
    } else if (status === 'completed' || status === 'failed') {
      updates.completed_at = now;
    }

    if (synthesisNodeId !== undefined) {
      updates.synthesis_node_id = synthesisNodeId;
    }

    if (error !== undefined) {
      updates.error = error;
    }

    await this.sql`
      UPDATE synthesis_queue
      SET ${this.sql(updates)}
      WHERE id = ${id}
    `;
  }

  async incrementSynthesisQueueRetry(id: number): Promise<void> {
    await this.sql`
      UPDATE synthesis_queue
      SET retry_count = retry_count + 1, status = 'pending'
      WHERE id = ${id}
    `;
  }

  async resetStuckSynthesisItems(timeoutMs: number): Promise<number> {
    const cutoffTime = Date.now() - timeoutMs;

    const result = await this.sql`
      UPDATE synthesis_queue
      SET status = 'pending', retry_count = retry_count + 1
      WHERE status = 'processing'
        AND (
          (started_at IS NOT NULL AND started_at < ${cutoffTime})
          OR (started_at IS NULL AND created_at < ${cutoffTime})
        )
    `;

    return result.count;
  }

  async getQueueStats(): Promise<QueueStats> {
    const [stats] = await this.sql`
      SELECT
        COUNT(CASE WHEN status = 'pending' THEN 1 END)::int as pending,
        COUNT(CASE WHEN status = 'processing' THEN 1 END)::int as processing,
        COUNT(CASE WHEN status = 'completed' THEN 1 END)::int as completed,
        COUNT(CASE WHEN status = 'failed' THEN 1 END)::int as failed
      FROM synthesis_queue
    `;

    return stats as QueueStats;
  }

  // ============ Progressive Disclosure Operations ============

  async createProgressiveDisclosureEvent(
    event: Omit<ProgressiveDisclosureEvent, 'id' | 'created_at'>
  ): Promise<ProgressiveDisclosureEvent> {
    const now = Date.now();

    const [result] = await this.sql`
      INSERT INTO progressive_disclosure_events (
        event_type, session_id, agent_id, query_text, search_latency_ms,
        results_count, node_ids, injection_tokens, expanded_node_id,
        expansion_tokens, message_tokens, created_at
      ) VALUES (
        ${event.event_type}, ${event.session_id}, ${event.agent_id},
        ${event.query_text}, ${event.search_latency_ms}, ${event.results_count},
        ${event.node_ids}, ${event.injection_tokens}, ${event.expanded_node_id},
        ${event.expansion_tokens}, ${event.message_tokens}, ${now}
      )
      RETURNING *
    `;

    return this.mapPDEventFromDb(result);
  }

  async getProgressiveDisclosureAnalytics(
    startTime: number,
    endTime: number
  ): Promise<ProgressiveDisclosureAnalytics> {
    const [stats] = await this.sql`
      SELECT
        COUNT(CASE WHEN event_type = 'search' THEN 1 END)::int as total_searches,
        COUNT(CASE WHEN event_type = 'inject' THEN 1 END)::int as total_injections,
        COUNT(CASE WHEN event_type = 'expand' THEN 1 END)::int as total_expansions,
        AVG(CASE WHEN event_type = 'search' THEN search_latency_ms END) as avg_search_latency,
        SUM(CASE WHEN event_type = 'inject' THEN injection_tokens ELSE 0 END)::int as total_injection_tokens,
        SUM(CASE WHEN event_type = 'expand' THEN expansion_tokens ELSE 0 END)::int as total_expansion_tokens
      FROM progressive_disclosure_events
      WHERE created_at BETWEEN ${startTime} AND ${endTime}
    `;

    const expansionRate =
      stats.total_injections > 0 ? stats.total_expansions / stats.total_injections : 0;

    return {
      totalSearches: stats.total_searches || 0,
      totalInjections: stats.total_injections || 0,
      totalExpansions: stats.total_expansions || 0,
      avgSearchLatency: Number(stats.avg_search_latency) || 0,
      expansionRate,
      totalInjectionTokens: stats.total_injection_tokens || 0,
      totalExpansionTokens: stats.total_expansion_tokens || 0,
    };
  }

  // ============ Utility ============

  async close(): Promise<void> {
    await this.sql.end();
  }

  getBackendType(): 'postgres' {
    return 'postgres';
  }

  supportsHybridSearch(): boolean {
    return true;
  }

  // ============ Internal Mapping Helpers ============

  private mapNodeFromDb(row: postgres.Row): SynthesisNode {
    return {
      id: row.id as string,
      node_type: row.node_type as NodeType,
      one_liner: row.one_liner as string,
      summary: row.summary as string,
      full_synthesis: row.full_synthesis as string,
      entity_name: row.entity_name as string | null,
      entity_aliases: row.entity_aliases as string | null,
      temporal_context: row.temporal_context as string | null,
      first_seen: Number(row.first_seen),
      last_updated: Number(row.last_updated),
      status: row.status as string | null,
      assigned_agent: row.assigned_agent as string | null,
      priority: row.priority as number | null,
      source_session_id: row.source_session_id as string | null,
      source_agent_id: row.source_agent_id as string | null,
      source_repo: row.source_repo as string | null,
      access_count: Number(row.access_count),
      last_accessed: row.last_accessed ? Number(row.last_accessed) : null,
      created_at: Number(row.created_at),
      updated_at: Number(row.updated_at),
    };
  }

  private mapEdgeFromDb(row: postgres.Row): SynthesisEdge {
    return {
      id: Number(row.id),
      from_node_id: row.from_node_id as string,
      to_node_id: row.to_node_id as string,
      edge_type: row.edge_type as SynthesisEdge['edge_type'],
      weight: Number(row.weight),
      context: row.context as string | null,
      created_at: Number(row.created_at),
    };
  }

  private mapRawContentFromDb(row: postgres.Row): RawContent {
    return {
      id: row.id as string,
      session_id: row.session_id as string,
      synthesis_node_id: row.synthesis_node_id as string | null,
      content_type: row.content_type as RawContent['content_type'],
      content: row.content as string,
      agent_id: row.agent_id as string | null,
      timestamp: Number(row.timestamp),
      message_index: row.message_index as number | null,
      created_at: Number(row.created_at),
    };
  }

  private mapQueueItemFromDb(row: postgres.Row): SynthesisQueue {
    return {
      id: Number(row.id),
      session_id: row.session_id as string,
      agent_id: row.agent_id as string | null,
      chunk_type: row.chunk_type as SynthesisQueue['chunk_type'],
      raw_content_ids: row.raw_content_ids as string,
      context: row.context as string | null,
      message_count: row.message_count as number | null,
      status: row.status as SynthesisQueueStatus,
      retry_count: Number(row.retry_count),
      error: row.error as string | null,
      synthesis_node_id: row.synthesis_node_id as string | null,
      created_at: Number(row.created_at),
      started_at: row.started_at ? Number(row.started_at) : null,
      completed_at: row.completed_at ? Number(row.completed_at) : null,
    };
  }

  private mapPDEventFromDb(row: postgres.Row): ProgressiveDisclosureEvent {
    return {
      id: Number(row.id),
      event_type: row.event_type as ProgressiveDisclosureEvent['event_type'],
      session_id: row.session_id as string | null,
      agent_id: row.agent_id as string | null,
      query_text: row.query_text as string | null,
      search_latency_ms: row.search_latency_ms as number | null,
      results_count: row.results_count as number | null,
      node_ids: row.node_ids as string | null,
      injection_tokens: row.injection_tokens as number | null,
      expanded_node_id: row.expanded_node_id as string | null,
      expansion_tokens: row.expansion_tokens as number | null,
      message_tokens: row.message_tokens as number | null,
      created_at: Number(row.created_at),
    };
  }
}
