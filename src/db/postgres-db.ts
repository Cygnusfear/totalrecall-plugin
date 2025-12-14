/**
 * Total Recall v3 - PostgreSQL Database Implementation
 * Uses VectorChord Suite for vector search and BM25 for keyword ranking
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
  CoreMemoryBlock,
  CoreMemoryBlockType,
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
 * PostgreSQL implementation - fully async and implements ISynthesisDatabase
 */
export class PostgresSynthesisDatabase implements ISynthesisDatabase {
  private sql: postgres.Sql;
  private probes: number;
  private dimension: number;
  private initPromise: Promise<void>;

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

    // Start session initialization - callers should use init() to await completion
    this.initPromise = this.initializeSession();
  }

  /**
   * Initialize the database connection
   * Call this after construction to ensure session settings are applied
   * Safe to call multiple times - subsequent calls return immediately
   */
  async init(): Promise<void> {
    await this.initPromise;
  }

  /**
   * Initialize session settings for VectorChord suite
   * Sets search_path to include catalog schemas and configures probes
   */
  private async initializeSession(): Promise<void> {
    // Set search_path to include catalog schemas for BM25 and tokenizer
    await this.sql.unsafe(
      `SET search_path TO public, bm25_catalog, tokenizer_catalog`
    );

    // Set VectorChord probes for vector search recall/speed tradeoff
    const safeProbes = Math.max(1, Math.min(1000, Math.floor(this.probes)));
    await this.sql.unsafe(`SET vectorchord.probes = ${safeProbes}`);
  }

  // ============ Node Operations ============

  // Columns to select for synthesis_nodes (excludes 'bm25' which postgres.js can't parse)
  private readonly nodeColumns = `
    id, node_type, one_liner, summary, full_synthesis,
    entity_name, entity_aliases, temporal_context, first_seen, last_updated,
    status, assigned_agent, priority, source_session_id, source_agent_id,
    source_repo, access_count, last_accessed, created_at, updated_at, embedding
  `;

  async createNode(
    node: Omit<SynthesisNode, 'id' | 'created_at' | 'updated_at' | 'access_count' | 'last_accessed'>
  ): Promise<SynthesisNode> {
    const now = Date.now();

    // Note: Use unsafe() because postgres.js can't parse bm25_catalog.bm25vector type
    // even when the column isn't returned - it introspects table schema for prepared statements
    const results = await this.sql.unsafe(
      `INSERT INTO synthesis_nodes (
        node_type, one_liner, summary, full_synthesis,
        entity_name, entity_aliases, temporal_context, first_seen, last_updated,
        status, assigned_agent, priority,
        source_session_id, source_agent_id, source_repo,
        access_count, last_accessed, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 0, NULL, $16, $16)
      RETURNING ${this.nodeColumns}`,
      [
        node.node_type, node.one_liner, node.summary, node.full_synthesis,
        node.entity_name, node.entity_aliases, node.temporal_context,
        node.first_seen, node.last_updated,
        node.status, node.assigned_agent, node.priority,
        node.source_session_id, node.source_agent_id, node.source_repo,
        now,
      ]
    );

    return this.mapNodeFromDb(results[0]);
  }

  async getNode(id: string): Promise<SynthesisNode | undefined> {
    // Use unsafe() to avoid postgres.js type parsing issues with bm25 column
    const results = await this.sql.unsafe(
      `SELECT ${this.nodeColumns} FROM synthesis_nodes WHERE id = $1`,
      [id]
    );

    return results.length > 0 ? this.mapNodeFromDb(results[0]) : undefined;
  }

  async queryNodes(filters: NodeQueryFilters): Promise<SynthesisNode[]> {
    const { node_types, session_id, limit = 100, order_by = 'last_updated' } = filters;
    const orderColumn = order_by === 'created_at' ? 'created_at' : 'last_updated';

    // Build dynamic WHERE clause
    const conditions: string[] = ['1=1'];
    const params: any[] = [];

    if (node_types?.length) {
      params.push(node_types);
      conditions.push(`node_type = ANY($${params.length})`);
    }
    if (session_id) {
      params.push(session_id);
      conditions.push(`source_session_id = $${params.length}`);
    }
    params.push(limit);

    // Use unsafe() to avoid postgres.js type parsing issues with bm25 column
    const results = await this.sql.unsafe(
      `SELECT ${this.nodeColumns} FROM synthesis_nodes
       WHERE ${conditions.join(' AND ')}
       ORDER BY ${orderColumn} DESC
       LIMIT $${params.length}`,
      params
    );

    return results.map((r: any) => this.mapNodeFromDb(r));
  }

  async updateNodeAccess(nodeId: string): Promise<void> {
    await this.sql`
      UPDATE synthesis_nodes
      SET access_count = access_count + 1, last_accessed = ${Date.now()}
      WHERE id = ${nodeId}
    `;
  }

  async getNodesBySession(sessionId: string): Promise<SynthesisNode[]> {
    // Use unsafe() to avoid postgres.js type parsing issues with bm25 column
    const results = await this.sql.unsafe(
      `SELECT ${this.nodeColumns} FROM synthesis_nodes
       WHERE source_session_id = $1
       ORDER BY created_at ASC`,
      [sessionId]
    );

    return results.map((r: any) => this.mapNodeFromDb(r));
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
    // Note: nodeTypes filtering is done inside hybrid_search function via subquery
    // We wrap in a subquery to filter results after RRF scoring
    // JOIN with synthesis_nodes to get created_at for date filtering
    const results = nodeTypes?.length
      ? await this.sql`
          SELECT hs.*, sn.created_at FROM (
            SELECT * FROM hybrid_search(
              ${query},
              ${vectorStr}::vector,
              ${maxResults * 2},
              ${minScore},
              ${weights.vector ?? 1.0},
              ${weights.bm25 ?? 1.0},
              ${weights.trigram ?? 0.5},
              60
            )
          ) AS hs
          JOIN synthesis_nodes sn ON sn.id = hs.node_id
          WHERE hs.node_type = ANY(${nodeTypes})
          LIMIT ${maxResults}
        `
      : await this.sql`
          SELECT hs.*, sn.created_at FROM hybrid_search(
            ${query},
            ${vectorStr}::vector,
            ${maxResults},
            ${minScore},
            ${weights.vector ?? 1.0},
            ${weights.bm25 ?? 1.0},
            ${weights.trigram ?? 0.5},
            60
          ) AS hs
          JOIN synthesis_nodes sn ON sn.id = hs.node_id
        `;

    return results.map((r) => ({
      node_id: r.node_id as string,
      one_liner: r.one_liner as string,
      node_type: r.node_type as NodeType,
      score: Number(r.score),
      created_at: Number(r.created_at),
      vectorRank: r.vector_rank !== 1000 ? Number(r.vector_rank) : undefined,
      bm25Rank: r.bm25_rank !== 1000 ? Number(r.bm25_rank) : undefined,
      trigramRank: r.trigram_rank !== 1000 ? Number(r.trigram_rank) : undefined,
      matchType: 'hybrid' as const,
    }));
  }

  async searchByBM25(query: string, limit: number): Promise<SearchResult[]> {
    // VectorChord-BM25 uses <&> operator with to_bm25query and tokenize
    // BM25 scores are negative (more negative = more relevant)
    // We normalize to [0, 1] where higher = more relevant
    // Note: Must set search_path before query because <&> operator requires bm25_catalog types
    // Use a transaction to ensure search_path persists for the query
    const results = await this.sql.begin(async (sql) => {
      await sql.unsafe(`SET search_path TO public, bm25_catalog, tokenizer_catalog`);
      return sql.unsafe(
        `SELECT
          id as node_id,
          one_liner,
          node_type,
          created_at,
          bm25 <&> bm25_catalog.to_bm25query(
            'idx_nodes_bm25'::regclass,
            tokenizer_catalog.tokenize($1, 'totalrecall_tokenizer')::bm25vector
          ) as bm25_score
        FROM synthesis_nodes
        WHERE bm25 IS NOT NULL
        ORDER BY bm25_score ASC
        LIMIT $2`,
        [query, limit]
      );
    });

    // Normalize BM25 scores to [0, 1] range
    // BM25 scores are negative, so we use exp(-score) to convert
    return results.map((r: any) => ({
      node_id: r.node_id as string,
      one_liner: r.one_liner as string,
      node_type: r.node_type as NodeType,
      created_at: Number(r.created_at),
      score: Math.min(1.0, Math.exp(Number(r.bm25_score) / 10)), // Normalize to [0, 1]
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
    // Use unsafe() to avoid postgres.js type parsing issues with bm25 column
    const params: any[] = [];
    let nodeTypeFilter = '';
    if (nodeTypes?.length) {
      params.push(nodeTypes);
      nodeTypeFilter = `AND node_type = ANY($${params.length})`;
    }

    const results = await this.sql.unsafe(
      `SELECT ${this.nodeColumns} FROM synthesis_nodes
       WHERE id NOT IN (
         SELECT DISTINCT from_node_id FROM synthesis_edges
         UNION
         SELECT DISTINCT to_node_id FROM synthesis_edges
       )
       ${nodeTypeFilter}
       ORDER BY created_at DESC`,
      params
    );

    return results.map((r: any) => this.mapNodeFromDb(r));
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

  async searchRawContentByText(
    query: string,
    limit: number = 20,
    includeOrphans: boolean = true
  ): Promise<RawContent[]> {
    // Case-insensitive ILIKE search for PostgreSQL
    const searchPattern = `%${query}%`;

    if (includeOrphans) {
      const rows = await this.sql`
        SELECT * FROM raw_content
        WHERE content ILIKE ${searchPattern}
        ORDER BY timestamp DESC
        LIMIT ${limit}
      `;
      return rows.map((r: Record<string, unknown>) => this.mapRawContentFromDb(r));
    } else {
      const rows = await this.sql`
        SELECT * FROM raw_content
        WHERE content ILIKE ${searchPattern} AND synthesis_node_id IS NOT NULL
        ORDER BY timestamp DESC
        LIMIT ${limit}
      `;
      return rows.map((r: Record<string, unknown>) => this.mapRawContentFromDb(r));
    }
  }

  // ============ Raw Content Vector Operations ============

  async insertRawEmbedding(rawContentId: string, embedding: number[]): Promise<void> {
    // PostgreSQL pgvector format: [1,2,3]
    const vectorStr = `[${embedding.join(',')}]`;

    await this.sql`
      UPDATE raw_content
      SET embedding = ${vectorStr}::vector
      WHERE id = ${rawContentId}
    `;
  }

  async searchRawByVector(
    queryEmbedding: number[],
    limit: number,
    minScore: number,
    includeOrphans: boolean = true
  ): Promise<Array<RawContent & { score: number }>> {
    const vectorStr = `[${queryEmbedding.join(',')}]`;

    let rows;
    if (includeOrphans) {
      rows = await this.sql`
        SELECT
          id, session_id, synthesis_node_id, content_type, content,
          agent_id, timestamp, message_index, created_at,
          1 / (1 + (embedding <-> ${vectorStr}::vector)) as score
        FROM raw_content
        WHERE embedding IS NOT NULL
        ORDER BY embedding <-> ${vectorStr}::vector ASC
        LIMIT ${limit * 2}
      `;
    } else {
      rows = await this.sql`
        SELECT
          id, session_id, synthesis_node_id, content_type, content,
          agent_id, timestamp, message_index, created_at,
          1 / (1 + (embedding <-> ${vectorStr}::vector)) as score
        FROM raw_content
        WHERE embedding IS NOT NULL AND synthesis_node_id IS NOT NULL
        ORDER BY embedding <-> ${vectorStr}::vector ASC
        LIMIT ${limit * 2}
      `;
    }

    return rows
      .map((r: Record<string, unknown>) => ({
        ...this.mapRawContentFromDb(r),
        score: r.score as number,
      }))
      .filter((r) => r.score >= minScore)
      .slice(0, limit);
  }

  async getRawContentWithoutEmbedding(limit: number = 100): Promise<RawContent[]> {
    const rows = await this.sql`
      SELECT * FROM raw_content
      WHERE embedding IS NULL
      ORDER BY timestamp DESC
      LIMIT ${limit}
    `;
    return rows.map((r: Record<string, unknown>) => this.mapRawContentFromDb(r));
  }

  async getRawEmbeddingCount(): Promise<number> {
    const [result] = await this.sql`
      SELECT COUNT(*) as count FROM raw_content WHERE embedding IS NOT NULL
    `;
    return parseInt(result.count as string, 10);
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

  // ============ Core Memory Operations ============

  private coreMemoryTableInitialized = false;

  private async ensureCoreMemoryTable(): Promise<void> {
    if (this.coreMemoryTableInitialized) return;
    await this.sql`
      CREATE TABLE IF NOT EXISTS core_memory (
        id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        block_type TEXT NOT NULL UNIQUE CHECK(block_type IN ('persona', 'human')),
        content TEXT NOT NULL,
        token_estimate INTEGER NOT NULL DEFAULT 0,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      )
    `;
    this.coreMemoryTableInitialized = true;
  }

  async getCoreMemoryBlock(blockType: CoreMemoryBlockType): Promise<CoreMemoryBlock | null> {
    await this.ensureCoreMemoryTable();
    const rows = await this.sql`
      SELECT * FROM core_memory WHERE block_type = ${blockType}
    `;
    return rows.length > 0 ? this.mapCoreMemoryFromDb(rows[0]) : null;
  }

  async getAllCoreMemoryBlocks(): Promise<CoreMemoryBlock[]> {
    await this.ensureCoreMemoryTable();
    const rows = await this.sql`SELECT * FROM core_memory`;
    return rows.map((row) => this.mapCoreMemoryFromDb(row));
  }

  async setCoreMemoryBlock(
    blockType: CoreMemoryBlockType,
    content: string,
    tokenEstimate: number
  ): Promise<CoreMemoryBlock> {
    await this.ensureCoreMemoryTable();
    const now = Date.now();
    const rows = await this.sql`
      INSERT INTO core_memory (block_type, content, token_estimate, created_at, updated_at)
      VALUES (${blockType}, ${content}, ${tokenEstimate}, ${now}, ${now})
      ON CONFLICT (block_type) DO UPDATE SET
        content = EXCLUDED.content,
        token_estimate = EXCLUDED.token_estimate,
        updated_at = EXCLUDED.updated_at
      RETURNING *
    `;
    return this.mapCoreMemoryFromDb(rows[0]);
  }

  async deleteCoreMemoryBlock(blockType: CoreMemoryBlockType): Promise<boolean> {
    await this.ensureCoreMemoryTable();
    const result = await this.sql`
      DELETE FROM core_memory WHERE block_type = ${blockType}
    `;
    return result.count > 0;
  }

  private mapCoreMemoryFromDb(row: postgres.Row): CoreMemoryBlock {
    return {
      id: row.id as string,
      block_type: row.block_type as CoreMemoryBlockType,
      content: row.content as string,
      token_estimate: Number(row.token_estimate),
      created_at: Number(row.created_at),
      updated_at: Number(row.updated_at),
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
