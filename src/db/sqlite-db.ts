/**
 * Total Recall v3 - SQLite Database Implementation
 * Extracted from original db.ts with interface compliance
 */

import { Database } from 'bun:sqlite';
import * as sqliteVec from 'sqlite-vec';
import { mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';
import { randomUUID } from 'crypto';
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
import {
  type ISynthesisDatabase,
  type NodeQueryFilters,
  type SynthesisQueueFilters,
  type QueueStats,
  type ProgressiveDisclosureAnalytics,
  type RelatedNode,
  type TextSearchMatchLocation,
  type SearchRankingConfig,
  TEXT_SEARCH_FIELDS,
  processTextSearchResults,
  applySearchRanking,
} from './interface.js';

// macOS requires custom SQLite for extension support
const macOSSqlitePaths = [
  '/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib', // Apple Silicon
  '/usr/local/opt/sqlite/lib/libsqlite3.dylib', // Intel Mac
];

if (process.platform === 'darwin') {
  for (const sqlitePath of macOSSqlitePaths) {
    if (existsSync(sqlitePath)) {
      Database.setCustomSQLite(sqlitePath);
      break;
    }
  }
}

export class SQLiteSynthesisDatabase implements ISynthesisDatabase {
  private db: Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });

    this.db = new Database(dbPath);
    sqliteVec.load(this.db);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.initSchema();
  }

  // Retry wrapper for SQLite operations with exponential backoff
  private withRetry<T>(fn: () => T, maxRetries: number = 5): T {
    for (let i = 0; i < maxRetries; i++) {
      try {
        return fn();
      } catch (e: unknown) {
        const error = e as { code?: string };
        if (error.code === 'SQLITE_BUSY' && i < maxRetries - 1) {
          const backoff = 50 * Math.pow(2, i);
          const start = Date.now();
          while (Date.now() - start < backoff) {
            // busy wait
          }
          continue;
        }
        throw e;
      }
    }
    throw new Error('Retry exhausted');
  }

  private initSchema(): void {
    // Main synthesis nodes table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS synthesis_nodes (
        id TEXT PRIMARY KEY,
        node_type TEXT NOT NULL,
        one_liner TEXT NOT NULL,
        summary TEXT NOT NULL,
        full_synthesis TEXT NOT NULL,
        entity_name TEXT,
        entity_aliases TEXT,
        temporal_context TEXT,
        first_seen INTEGER NOT NULL,
        last_updated INTEGER NOT NULL,
        status TEXT,
        assigned_agent TEXT,
        priority INTEGER,
        source_session_id TEXT,
        source_agent_id TEXT,
        source_repo TEXT,
        access_count INTEGER DEFAULT 0,
        last_accessed INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    // Vector embeddings table (sqlite-vec)
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS vec_synthesis USING vec0(
        id TEXT PRIMARY KEY,
        embedding FLOAT[384]
      )
    `);

    // Edges table for graph relationships
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS synthesis_edges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_node_id TEXT NOT NULL,
        to_node_id TEXT NOT NULL,
        edge_type TEXT NOT NULL,
        weight REAL DEFAULT 1.0,
        context TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (from_node_id) REFERENCES synthesis_nodes(id),
        FOREIGN KEY (to_node_id) REFERENCES synthesis_nodes(id)
      )
    `);

    // Indexes
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_nodes_last_updated ON synthesis_nodes(last_updated DESC);
      CREATE INDEX IF NOT EXISTS idx_nodes_session ON synthesis_nodes(source_session_id);
      CREATE INDEX IF NOT EXISTS idx_nodes_type ON synthesis_nodes(node_type);
      CREATE INDEX IF NOT EXISTS idx_edges_from ON synthesis_edges(from_node_id);
      CREATE INDEX IF NOT EXISTS idx_edges_to ON synthesis_edges(to_node_id);
    `);

    // Raw content storage
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS raw_content (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        synthesis_node_id TEXT,
        content_type TEXT NOT NULL CHECK(content_type IN ('message', 'tool_call', 'tool_result', 'conversation')),
        content TEXT NOT NULL,
        agent_id TEXT,
        timestamp INTEGER NOT NULL,
        message_index INTEGER,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (synthesis_node_id) REFERENCES synthesis_nodes(id) ON DELETE SET NULL
      )
    `);

    // Vector embeddings for raw content (enables semantic search on raw conversations)
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS vec_raw_content USING vec0(
        id TEXT PRIMARY KEY,
        embedding FLOAT[384]
      )
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_raw_content_session_time ON raw_content(session_id, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_raw_content_synthesis_time ON raw_content(synthesis_node_id, timestamp ASC);
      CREATE INDEX IF NOT EXISTS idx_raw_content_timestamp ON raw_content(timestamp DESC);
    `);

    // Synthesis queue
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS synthesis_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        agent_id TEXT,
        chunk_type TEXT NOT NULL CHECK(chunk_type IN ('session_start', 'session_chunk', 'session_end')),
        raw_content_ids TEXT NOT NULL,
        context TEXT,
        message_count INTEGER,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'completed', 'failed')),
        retry_count INTEGER DEFAULT 0,
        error TEXT,
        synthesis_node_id TEXT,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        completed_at INTEGER,
        FOREIGN KEY (synthesis_node_id) REFERENCES synthesis_nodes(id) ON DELETE SET NULL
      )
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_synthesis_queue_status ON synthesis_queue(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_synthesis_queue_session ON synthesis_queue(session_id);
      CREATE INDEX IF NOT EXISTS idx_synthesis_queue_session_time ON synthesis_queue(session_id, created_at DESC);
    `);

    // Progressive disclosure analytics
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS progressive_disclosure_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL CHECK(event_type IN ('search', 'inject', 'expand', 'skip')),
        session_id TEXT,
        agent_id TEXT,
        query_text TEXT,
        search_latency_ms INTEGER,
        results_count INTEGER,
        node_ids TEXT,
        injection_tokens INTEGER,
        expanded_node_id TEXT,
        expansion_tokens INTEGER,
        message_tokens INTEGER,
        created_at INTEGER NOT NULL
      )
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_pd_events_type ON progressive_disclosure_events(event_type);
      CREATE INDEX IF NOT EXISTS idx_pd_events_session ON progressive_disclosure_events(session_id);
      CREATE INDEX IF NOT EXISTS idx_pd_events_created ON progressive_disclosure_events(created_at DESC);
    `);

    // Core memory for always-inject blocks (Epic 4)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS core_memory (
        id TEXT PRIMARY KEY,
        block_type TEXT NOT NULL UNIQUE CHECK(block_type IN ('persona', 'human')),
        content TEXT NOT NULL,
        token_estimate INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
  }

  // ============ Node Operations ============

  async createNode(
    node: Omit<SynthesisNode, 'id' | 'created_at' | 'updated_at' | 'access_count' | 'last_accessed'>
  ): Promise<SynthesisNode> {
    const id = randomUUID();
    const now = Date.now();

    this.db
      .prepare(
        `
      INSERT INTO synthesis_nodes (
        id, node_type, one_liner, summary, full_synthesis,
        entity_name, entity_aliases, temporal_context, first_seen, last_updated,
        status, assigned_agent, priority,
        source_session_id, source_agent_id, source_repo,
        access_count, last_accessed, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)
    `
      )
      .run(
        id,
        node.node_type,
        node.one_liner,
        node.summary,
        node.full_synthesis,
        node.entity_name,
        node.entity_aliases,
        node.temporal_context,
        node.first_seen,
        node.last_updated,
        node.status,
        node.assigned_agent,
        node.priority,
        node.source_session_id,
        node.source_agent_id,
        node.source_repo,
        now,
        now
      );

    return {
      ...node,
      id,
      access_count: 0,
      last_accessed: null,
      created_at: now,
      updated_at: now,
    };
  }

  async getNode(id: string): Promise<SynthesisNode | undefined> {
    return this.db.prepare('SELECT * FROM synthesis_nodes WHERE id = ?').get(id) as
      | SynthesisNode
      | undefined;
  }

  async queryNodes(filters: NodeQueryFilters): Promise<SynthesisNode[]> {
    const { node_types, session_id, limit = 100, order_by = 'last_updated' } = filters;

    let query = 'SELECT * FROM synthesis_nodes WHERE 1=1';
    const params: (string | number | null)[] = [];

    if (node_types?.length) {
      query += ` AND node_type IN (${node_types.map(() => '?').join(',')})`;
      params.push(...node_types);
    }
    if (session_id) {
      query += ' AND source_session_id = ?';
      params.push(session_id);
    }

    query += ` ORDER BY ${order_by} DESC LIMIT ?`;
    params.push(limit);

    return this.db.prepare(query).all(...params) as SynthesisNode[];
  }

  async updateNodeAccess(nodeId: string): Promise<void> {
    this.db
      .prepare(
        `
      UPDATE synthesis_nodes
      SET access_count = access_count + 1, last_accessed = ?
      WHERE id = ?
    `
      )
      .run(Date.now(), nodeId);
  }

  async getNodesBySession(sessionId: string): Promise<SynthesisNode[]> {
    return this.db
      .prepare(
        `
      SELECT * FROM synthesis_nodes
      WHERE source_session_id = ?
      ORDER BY created_at ASC
    `
      )
      .all(sessionId) as SynthesisNode[];
  }

  async getAllSessionIds(): Promise<string[]> {
    const rows = this.db
      .prepare(
        `
      SELECT source_session_id
      FROM synthesis_nodes
      WHERE source_session_id IS NOT NULL
      GROUP BY source_session_id
      ORDER BY MIN(created_at) DESC
    `
      )
      .all() as Array<{ source_session_id: string }>;

    return rows.map((r) => r.source_session_id);
  }

  async queryNodesByIdPrefix(prefix: string, limit: number = 10): Promise<SynthesisNode[]> {
    // Efficient prefix matching using LIKE with escaped prefix
    const escapedPrefix = prefix.replace(/[%_]/g, '\\$&');
    return this.db
      .prepare(
        `
        SELECT * FROM synthesis_nodes
        WHERE id LIKE ? ESCAPE '\\'
        ORDER BY last_updated DESC
        LIMIT ?
      `
      )
      .all(`${escapedPrefix}%`, limit) as SynthesisNode[];
  }

  async searchNodesByText(
    term: string,
    limit: number = 20,
    nodeTypes?: NodeType[]
  ): Promise<Array<SynthesisNode & { match_location: TextSearchMatchLocation }>> {
    // Case-insensitive LIKE search with priority ranking by match location
    const searchPattern = `%${term}%`;
    const results: Array<SynthesisNode & { match_location: TextSearchMatchLocation; priority: number }> = [];
    const seenIds = new Set<string>();

    for (const { location, column, priority } of TEXT_SEARCH_FIELDS) {
      let query = `SELECT * FROM synthesis_nodes WHERE ${column} LIKE ?`;
      const params: (string | number | null)[] = [searchPattern];

      if (nodeTypes?.length) {
        query += ` AND node_type IN (${nodeTypes.map(() => '?').join(',')})`;
        params.push(...nodeTypes);
      }

      query += ' ORDER BY last_updated DESC';

      const rows = this.db.prepare(query).all(...params) as SynthesisNode[];

      for (const row of rows) {
        if (!seenIds.has(row.id)) {
          seenIds.add(row.id);
          results.push({ ...row, match_location: location, priority });
        }
      }
    }

    return processTextSearchResults(results, limit);
  }

  // ============ Vector Operations ============

  async insertEmbedding(nodeId: string, embedding: number[]): Promise<void> {
    this.db.prepare('DELETE FROM vec_synthesis WHERE id = ?').run(nodeId);
    this.db
      .prepare('INSERT INTO vec_synthesis (id, embedding) VALUES (?, ?)')
      .run(nodeId, Buffer.from(new Float32Array(embedding).buffer));
  }

  async searchByVector(
    queryEmbedding: number[],
    limit: number,
    minScore: number,
    nodeTypes?: NodeType[],
    rankingConfig?: SearchRankingConfig
  ): Promise<SearchResult[]> {
    // Over-fetch to allow for ranking before limiting
    const fetchLimit = limit * 3;

    let query = `
      SELECT
        sn.id as node_id,
        sn.one_liner,
        sn.node_type,
        sn.created_at,
        vec.distance
      FROM vec_synthesis AS vec
      JOIN synthesis_nodes AS sn ON vec.id = sn.id
      WHERE vec.embedding MATCH ? AND k = ?
    `;

    const params: (string | number | Buffer | null)[] = [
      Buffer.from(new Float32Array(queryEmbedding).buffer),
      fetchLimit,
    ];

    if (nodeTypes?.length) {
      query += ` AND sn.node_type IN (${nodeTypes.map(() => '?').join(',')})`;
      params.push(...nodeTypes);
    }

    query += ' ORDER BY vec.distance ASC';

    const results = this.db.prepare(query).all(...params) as Array<{
      node_id: string;
      one_liner: string;
      node_type: NodeType;
      created_at: number;
      distance: number;
    }>;

    // Convert to SearchResult format
    const searchResults: SearchResult[] = results
      .map((r) => ({
        node_id: r.node_id,
        one_liner: r.one_liner,
        score: 1 - (r.distance * r.distance) / 2,
        node_type: r.node_type,
        created_at: r.created_at,
      }))
      .filter((r) => r.score >= minScore);

    // If no ranking config, return simple similarity-sorted results
    if (!rankingConfig) {
      return searchResults.slice(0, limit);
    }

    // Fetch edge counts for all candidate nodes
    const nodeIds = searchResults.map((r) => r.node_id);
    const edgeCounts = new Map<string, number>();

    if (nodeIds.length > 0) {
      const placeholders = nodeIds.map(() => '?').join(',');
      const edgeCountResults = this.db
        .prepare(
          `
        SELECT
          node_id,
          COUNT(*) as edge_count
        FROM (
          SELECT from_node_id as node_id FROM synthesis_edges WHERE from_node_id IN (${placeholders})
          UNION ALL
          SELECT to_node_id as node_id FROM synthesis_edges WHERE to_node_id IN (${placeholders})
        )
        GROUP BY node_id
      `
        )
        .all(...nodeIds, ...nodeIds) as Array<{ node_id: string; edge_count: number }>;

      for (const row of edgeCountResults) {
        edgeCounts.set(row.node_id, row.edge_count);
      }
    }

    // Apply multi-factor ranking
    const rankedResults = applySearchRanking(searchResults, edgeCounts, rankingConfig);

    // Return top results, converting back to SearchResult
    // Note: We keep the ranking metadata in the score field
    return rankedResults.slice(0, limit).map((r) => ({
      node_id: r.node_id,
      one_liner: r.one_liner,
      score: r.rankingScore, // Use combined ranking score instead of just similarity
      node_type: r.node_type,
      created_at: r.created_at,
    }));
  }

  // ============ Edge Operations ============

  async createEdge(edge: Omit<SynthesisEdge, 'id' | 'created_at'>): Promise<SynthesisEdge> {
    const now = Date.now();
    const result = this.db
      .prepare(
        `
      INSERT INTO synthesis_edges (from_node_id, to_node_id, edge_type, weight, context, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `
      )
      .run(edge.from_node_id, edge.to_node_id, edge.edge_type, edge.weight, edge.context, now);

    return {
      ...edge,
      id: result.lastInsertRowid as number,
      created_at: now,
    };
  }

  async edgeExists(nodeId1: string, nodeId2: string): Promise<boolean> {
    const result = this.db
      .prepare(
        `
      SELECT COUNT(*) as count
      FROM synthesis_edges
      WHERE (from_node_id = ? AND to_node_id = ?)
         OR (from_node_id = ? AND to_node_id = ?)
    `
      )
      .get(nodeId1, nodeId2, nodeId2, nodeId1) as { count: number };

    return result.count > 0;
  }

  async getOrphanNodes(nodeTypes?: NodeType[]): Promise<SynthesisNode[]> {
    let query = `
      SELECT * FROM synthesis_nodes
      WHERE id NOT IN (
        SELECT DISTINCT from_node_id FROM synthesis_edges
        UNION
        SELECT DISTINCT to_node_id FROM synthesis_edges
      )
    `;

    const params: string[] = [];

    if (nodeTypes?.length) {
      query += ` AND node_type IN (${nodeTypes.map(() => '?').join(',')})`;
      params.push(...nodeTypes);
    }

    query += ' ORDER BY created_at DESC';

    return this.db.prepare(query).all(...params) as SynthesisNode[];
  }

  async getEdgeCount(nodeId: string): Promise<number> {
    const result = this.db
      .prepare(
        `
      SELECT COUNT(*) as count
      FROM synthesis_edges
      WHERE from_node_id = ? OR to_node_id = ?
    `
      )
      .get(nodeId, nodeId) as { count: number };

    return result.count;
  }

  async getRelatedNodes(nodeId: string): Promise<RelatedNode[]> {
    const results = this.db
      .prepare(
        `
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
        (se.to_node_id = sn.id AND se.from_node_id = ?) OR
        (se.from_node_id = sn.id AND se.to_node_id = ?)
      )
      WHERE sn.id != ?
    `
      )
      .all(nodeId, nodeId, nodeId) as any[];

    return results.map((row) => ({
      node: {
        id: row.id,
        node_type: row.node_type,
        one_liner: row.one_liner,
        summary: row.summary,
        full_synthesis: row.full_synthesis,
        entity_name: row.entity_name,
        entity_aliases: row.entity_aliases,
        temporal_context: row.temporal_context,
        first_seen: row.first_seen,
        last_updated: row.last_updated,
        status: row.status,
        assigned_agent: row.assigned_agent,
        priority: row.priority,
        source_session_id: row.source_session_id,
        source_agent_id: row.source_agent_id,
        source_repo: row.source_repo,
        access_count: row.access_count,
        last_accessed: row.last_accessed,
        created_at: row.created_at,
        updated_at: row.updated_at,
      } as SynthesisNode,
      edge: {
        id: row.edge_id,
        from_node_id: row.from_node_id,
        to_node_id: row.to_node_id,
        edge_type: row.edge_type,
        weight: row.weight,
        context: row.edge_context,
        created_at: row.edge_created_at,
      } as SynthesisEdge,
    }));
  }

  // ============ Raw Content Operations ============

  async createRawContent(content: Omit<RawContent, 'created_at'>): Promise<RawContent> {
    const now = Date.now();

    const stmt = this.db.prepare(`
      INSERT INTO raw_content (
        id, session_id, synthesis_node_id, content_type, content,
        agent_id, timestamp, message_index, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.withRetry(() =>
      stmt.run(
        content.id,
        content.session_id,
        content.synthesis_node_id ?? null,
        content.content_type,
        content.content,
        content.agent_id ?? null,
        content.timestamp,
        content.message_index ?? null,
        now
      )
    );

    return { ...content, created_at: now };
  }

  async getRawContentBySession(sessionId: string, limit: number = 100): Promise<RawContent[]> {
    return this.db
      .prepare(
        `
      SELECT * FROM raw_content
      WHERE session_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `
      )
      .all(sessionId, limit) as RawContent[];
  }

  async getRawContentBySynthesis(synthesisNodeId: string): Promise<RawContent[]> {
    return this.db
      .prepare(
        `
      SELECT * FROM raw_content
      WHERE synthesis_node_id = ?
      ORDER BY timestamp ASC
    `
      )
      .all(synthesisNodeId) as RawContent[];
  }

  async getRawContentByIds(ids: string[]): Promise<RawContent[]> {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    return this.db
      .prepare(
        `
      SELECT * FROM raw_content
      WHERE id IN (${placeholders})
      ORDER BY timestamp ASC
    `
      )
      .all(...ids) as RawContent[];
  }

  async linkRawContentToSynthesis(rawContentIds: string[], synthesisNodeId: string): Promise<void> {
    const stmt = this.db.prepare(`
      UPDATE raw_content
      SET synthesis_node_id = ?
      WHERE id = ?
    `);

    for (const id of rawContentIds) {
      this.withRetry(() => stmt.run(synthesisNodeId, id));
    }
  }

  async searchRawContentByText(
    query: string,
    limit: number = 20,
    includeOrphans: boolean = true
  ): Promise<RawContent[]> {
    // Case-insensitive LIKE search on content
    const searchPattern = `%${query}%`;

    if (includeOrphans) {
      // Search all raw content
      return this.withRetry(() =>
        this.db
          .prepare(
            `
        SELECT * FROM raw_content
        WHERE content LIKE ?
        ORDER BY timestamp DESC
        LIMIT ?
      `
          )
          .all(searchPattern, limit)
      ) as RawContent[];
    } else {
      // Only search raw content linked to synthesis nodes
      return this.withRetry(() =>
        this.db
          .prepare(
            `
        SELECT * FROM raw_content
        WHERE content LIKE ? AND synthesis_node_id IS NOT NULL
        ORDER BY timestamp DESC
        LIMIT ?
      `
          )
          .all(searchPattern, limit)
      ) as RawContent[];
    }
  }

  // ============ Raw Content Vector Operations ============

  async insertRawEmbedding(rawContentId: string, embedding: number[]): Promise<void> {
    this.db.prepare('DELETE FROM vec_raw_content WHERE id = ?').run(rawContentId);
    this.db
      .prepare('INSERT INTO vec_raw_content (id, embedding) VALUES (?, ?)')
      .run(rawContentId, Buffer.from(new Float32Array(embedding).buffer));
  }

  async searchRawByVector(
    queryEmbedding: number[],
    limit: number,
    minScore: number,
    includeOrphans: boolean = true
  ): Promise<Array<RawContent & { score: number }>> {
    let query = `
      SELECT
        rc.*,
        vec.distance
      FROM vec_raw_content AS vec
      JOIN raw_content AS rc ON vec.id = rc.id
      WHERE vec.embedding MATCH ? AND k = ?
    `;

    const params: (Buffer | number | null)[] = [
      Buffer.from(new Float32Array(queryEmbedding).buffer),
      limit * 2, // Over-fetch to allow for filtering
    ];

    if (!includeOrphans) {
      query += ' AND rc.synthesis_node_id IS NOT NULL';
    }

    query += ' ORDER BY vec.distance ASC';

    const results = this.db.prepare(query).all(...params) as Array<{
      id: string;
      session_id: string;
      synthesis_node_id: string | null;
      content_type: 'message' | 'tool_call' | 'tool_result' | 'conversation';
      content: string;
      agent_id: string | null;
      timestamp: number;
      message_index: number | null;
      created_at: number;
      distance: number;
    }>;

    // Convert L2 distance to similarity score and filter
    return results
      .map((r) => {
        const { distance, ...rawContent } = r;
        // L2 distance to cosine-like score (assuming normalized embeddings)
        const score = 1 / (1 + distance);
        return { ...rawContent, score };
      })
      .filter((r) => r.score >= minScore)
      .slice(0, limit);
  }

  async getRawContentWithoutEmbedding(limit: number = 100): Promise<RawContent[]> {
    // Find raw content that doesn't have an embedding yet
    return this.db
      .prepare(
        `
      SELECT rc.* FROM raw_content rc
      LEFT JOIN vec_raw_content vec ON rc.id = vec.id
      WHERE vec.id IS NULL
      ORDER BY rc.timestamp DESC
      LIMIT ?
    `
      )
      .all(limit) as RawContent[];
  }

  async getRawEmbeddingCount(): Promise<number> {
    const result = this.db.prepare('SELECT COUNT(*) as count FROM vec_raw_content').get() as {
      count: number;
    };
    return result.count;
  }

  // ============ Synthesis Queue Operations ============

  async createSynthesisQueueItem(
    item: Omit<SynthesisQueue, 'id' | 'started_at' | 'completed_at'>
  ): Promise<SynthesisQueue> {
    const stmt = this.db.prepare(`
      INSERT INTO synthesis_queue (
        session_id, agent_id, chunk_type, raw_content_ids, context,
        message_count, status, retry_count, error, synthesis_node_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = this.withRetry(() =>
      stmt.run(
        item.session_id,
        item.agent_id ?? null,
        item.chunk_type,
        item.raw_content_ids,
        item.context ?? null,
        item.message_count ?? null,
        item.status,
        item.retry_count,
        item.error ?? null,
        item.synthesis_node_id ?? null,
        item.created_at
      )
    );

    return {
      id: result.lastInsertRowid as number,
      ...item,
      started_at: null,
      completed_at: null,
    };
  }

  async getPendingSynthesisQueue(filters: { limit?: number } = {}): Promise<SynthesisQueue[]> {
    const { limit = 10 } = filters;
    return this.db
      .prepare(
        `
      SELECT * FROM synthesis_queue
      WHERE status = 'pending'
      ORDER BY created_at ASC
      LIMIT ?
    `
      )
      .all(limit) as SynthesisQueue[];
  }

  async getSynthesisQueueItems(filters: SynthesisQueueFilters): Promise<SynthesisQueue[]> {
    const { session_id, status, limit = 50 } = filters;

    let query = 'SELECT * FROM synthesis_queue WHERE 1=1';
    const params: (string | number | null)[] = [];

    if (session_id) {
      query += ' AND session_id = ?';
      params.push(session_id);
    }

    if (status) {
      query += ' AND status = ?';
      params.push(status);
    }

    query += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);

    return this.db.prepare(query).all(...params) as SynthesisQueue[];
  }

  async updateSynthesisQueueStatus(
    id: number,
    status: SynthesisQueueStatus,
    synthesisNodeId?: string | null,
    error?: string | null
  ): Promise<void> {
    const now = Date.now();
    const updates: string[] = ['status = ?'];
    const values: (string | number | null)[] = [status];

    if (status === 'processing') {
      updates.push('started_at = ?');
      values.push(now);
    } else if (status === 'completed' || status === 'failed') {
      updates.push('completed_at = ?');
      values.push(now);
    }

    if (synthesisNodeId !== undefined) {
      updates.push('synthesis_node_id = ?');
      values.push(synthesisNodeId);
    }

    if (error !== undefined) {
      updates.push('error = ?');
      values.push(error);
    }

    values.push(id);

    const stmt = this.db.prepare(`
      UPDATE synthesis_queue
      SET ${updates.join(', ')}
      WHERE id = ?
    `);
    this.withRetry(() => stmt.run(...values));
  }

  async incrementSynthesisQueueRetry(id: number): Promise<void> {
    const stmt = this.db.prepare(`
      UPDATE synthesis_queue
      SET retry_count = retry_count + 1, status = 'pending'
      WHERE id = ?
    `);
    this.withRetry(() => stmt.run(id));
  }

  async resetStuckSynthesisItems(timeoutMs: number): Promise<number> {
    const cutoffTime = Date.now() - timeoutMs;
    const stmt = this.db.prepare(`
      UPDATE synthesis_queue
      SET status = 'pending', retry_count = retry_count + 1
      WHERE status = 'processing'
        AND (
          (started_at IS NOT NULL AND started_at < ?)
          OR (started_at IS NULL AND created_at < ?)
        )
    `);
    const result = this.withRetry(() => stmt.run(cutoffTime, cutoffTime));
    return result.changes;
  }

  async getQueueStats(): Promise<QueueStats> {
    const stats = this.db
      .prepare(
        `
      SELECT
        COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending,
        COUNT(CASE WHEN status = 'processing' THEN 1 END) as processing,
        COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed,
        COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed
      FROM synthesis_queue
    `
      )
      .get() as QueueStats;
    return stats;
  }

  // ============ Progressive Disclosure Operations ============

  async createProgressiveDisclosureEvent(
    event: Omit<ProgressiveDisclosureEvent, 'id' | 'created_at'>
  ): Promise<ProgressiveDisclosureEvent> {
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO progressive_disclosure_events (
        event_type, session_id, agent_id, query_text, search_latency_ms,
        results_count, node_ids, injection_tokens, expanded_node_id,
        expansion_tokens, message_tokens, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = this.withRetry(() =>
      stmt.run(
        event.event_type,
        event.session_id ?? null,
        event.agent_id ?? null,
        event.query_text ?? null,
        event.search_latency_ms ?? null,
        event.results_count ?? null,
        event.node_ids ?? null,
        event.injection_tokens ?? null,
        event.expanded_node_id ?? null,
        event.expansion_tokens ?? null,
        event.message_tokens ?? null,
        now
      )
    );

    return {
      id: result.lastInsertRowid as number,
      ...event,
      created_at: now,
    };
  }

  async getProgressiveDisclosureAnalytics(
    startTime: number,
    endTime: number
  ): Promise<ProgressiveDisclosureAnalytics> {
    const stats = this.db
      .prepare(
        `
      SELECT
        COUNT(CASE WHEN event_type = 'search' THEN 1 END) as total_searches,
        COUNT(CASE WHEN event_type = 'inject' THEN 1 END) as total_injections,
        COUNT(CASE WHEN event_type = 'expand' THEN 1 END) as total_expansions,
        AVG(CASE WHEN event_type = 'search' THEN search_latency_ms END) as avg_search_latency,
        SUM(CASE WHEN event_type = 'inject' THEN injection_tokens ELSE 0 END) as total_injection_tokens,
        SUM(CASE WHEN event_type = 'expand' THEN expansion_tokens ELSE 0 END) as total_expansion_tokens
      FROM progressive_disclosure_events
      WHERE created_at BETWEEN ? AND ?
    `
      )
      .get(startTime, endTime) as {
      total_searches: number;
      total_injections: number;
      total_expansions: number;
      avg_search_latency: number | null;
      total_injection_tokens: number | null;
      total_expansion_tokens: number | null;
    };

    const expansionRate =
      stats.total_injections > 0 ? stats.total_expansions / stats.total_injections : 0;

    return {
      totalSearches: stats.total_searches || 0,
      totalInjections: stats.total_injections || 0,
      totalExpansions: stats.total_expansions || 0,
      avgSearchLatency: stats.avg_search_latency || 0,
      expansionRate,
      totalInjectionTokens: stats.total_injection_tokens || 0,
      totalExpansionTokens: stats.total_expansion_tokens || 0,
    };
  }

  // ============ Core Memory Operations ============

  async getCoreMemoryBlock(blockType: CoreMemoryBlockType): Promise<CoreMemoryBlock | null> {
    const row = this.db
      .prepare('SELECT * FROM core_memory WHERE block_type = ?')
      .get(blockType) as CoreMemoryBlock | undefined;
    return row || null;
  }

  async getAllCoreMemoryBlocks(): Promise<CoreMemoryBlock[]> {
    return this.db.prepare('SELECT * FROM core_memory').all() as CoreMemoryBlock[];
  }

  async setCoreMemoryBlock(
    blockType: CoreMemoryBlockType,
    content: string,
    tokenEstimate: number
  ): Promise<CoreMemoryBlock> {
    const now = Date.now();
    const existing = await this.getCoreMemoryBlock(blockType);

    if (existing) {
      this.db
        .prepare(
          `UPDATE core_memory SET content = ?, token_estimate = ?, updated_at = ? WHERE block_type = ?`
        )
        .run(content, tokenEstimate, now, blockType);

      return {
        ...existing,
        content,
        token_estimate: tokenEstimate,
        updated_at: now,
      };
    }

    const id = crypto.randomUUID();
    this.db
      .prepare(
        `INSERT INTO core_memory (id, block_type, content, token_estimate, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(id, blockType, content, tokenEstimate, now, now);

    return {
      id,
      block_type: blockType,
      content,
      token_estimate: tokenEstimate,
      created_at: now,
      updated_at: now,
    };
  }

  async deleteCoreMemoryBlock(blockType: CoreMemoryBlockType): Promise<boolean> {
    const result = this.db.prepare('DELETE FROM core_memory WHERE block_type = ?').run(blockType);
    return result.changes > 0;
  }

  // ============ Utility ============

  async close(): Promise<void> {
    this.db.close();
  }

  getBackendType(): 'sqlite' {
    return 'sqlite';
  }

  supportsHybridSearch(): boolean {
    return false;
  }
}
