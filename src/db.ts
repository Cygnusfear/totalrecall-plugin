/**
 * Total Recall Database with sqlite-vec for vector search
 * Uses bun:sqlite for native Bun compatibility
 */

import { Database } from 'bun:sqlite';
import * as sqliteVec from 'sqlite-vec';
import { mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';
import { randomUUID } from 'crypto';
import { getDbPath } from './paths.js';
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
  ProgressiveDisclosureEventType
} from './schema.js';

// macOS requires custom SQLite for extension support
// Try common Homebrew paths
const macOSSqlitePaths = [
  '/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib',  // Apple Silicon
  '/usr/local/opt/sqlite/lib/libsqlite3.dylib',      // Intel Mac
];

if (process.platform === 'darwin') {
  for (const sqlitePath of macOSSqlitePaths) {
    if (existsSync(sqlitePath)) {
      Database.setCustomSQLite(sqlitePath);
      break;
    }
  }
}

export class SynthesisDatabase {
  private db: Database;

  constructor(dbPath?: string) {
    const path = dbPath || getDbPath();
    mkdirSync(dirname(path), { recursive: true });

    this.db = new Database(path);
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
          const backoff = 50 * Math.pow(2, i); // 50ms, 100ms, 200ms, 400ms, 800ms
          // Synchronous sleep using busy-wait (better-sqlite3 is synchronous)
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

    // Raw content storage for conversation chunks
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

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_raw_content_session_time ON raw_content(session_id, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_raw_content_synthesis_time ON raw_content(synthesis_node_id, timestamp ASC);
      CREATE INDEX IF NOT EXISTS idx_raw_content_timestamp ON raw_content(timestamp DESC);
    `);

    // Synthesis queue for background processing
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
  }

  // ============ Node Operations ============

  createNode(node: Omit<SynthesisNode, 'id' | 'created_at' | 'updated_at' | 'access_count' | 'last_accessed'>): SynthesisNode {
    const id = randomUUID();
    const now = Date.now();

    this.db.prepare(`
      INSERT INTO synthesis_nodes (
        id, node_type, one_liner, summary, full_synthesis,
        entity_name, entity_aliases, temporal_context, first_seen, last_updated,
        status, assigned_agent, priority,
        source_session_id, source_agent_id, source_repo,
        access_count, last_accessed, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)
    `).run(
      id, node.node_type, node.one_liner, node.summary, node.full_synthesis,
      node.entity_name, node.entity_aliases, node.temporal_context,
      node.first_seen, node.last_updated,
      node.status, node.assigned_agent, node.priority,
      node.source_session_id, node.source_agent_id, node.source_repo,
      now, now
    );

    return {
      ...node,
      id,
      access_count: 0,
      last_accessed: null,
      created_at: now,
      updated_at: now
    };
  }

  getNode(id: string): SynthesisNode | undefined {
    return this.db.prepare('SELECT * FROM synthesis_nodes WHERE id = ?').get(id) as SynthesisNode | undefined;
  }

  queryNodes(filters: {
    node_types?: NodeType[];
    session_id?: string;
    limit?: number;
    order_by?: 'created_at' | 'last_updated';
  }): SynthesisNode[] {
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

  updateNodeAccess(nodeId: string): void {
    this.db.prepare(`
      UPDATE synthesis_nodes
      SET access_count = access_count + 1, last_accessed = ?
      WHERE id = ?
    `).run(Date.now(), nodeId);
  }

  // ============ Vector Operations ============

  insertEmbedding(nodeId: string, embedding: number[]): void {
    // Delete existing embedding if any
    this.db.prepare('DELETE FROM vec_synthesis WHERE id = ?').run(nodeId);

    // Insert new embedding
    this.db.prepare('INSERT INTO vec_synthesis (id, embedding) VALUES (?, ?)')
      .run(nodeId, Buffer.from(new Float32Array(embedding).buffer));
  }

  searchByVector(
    queryEmbedding: number[],
    limit: number,
    minScore: number,
    nodeTypes?: NodeType[]
  ): SearchResult[] {
    // sqlite-vec uses L2 (Euclidean) distance by default
    // For normalized vectors: L2^2 = 2 - 2*cosine, so cosine = 1 - L2^2/2

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
      limit * 2  // Over-fetch to account for filtering
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

    return results
      .map(r => ({
        node_id: r.node_id,
        one_liner: r.one_liner,
        score: 1 - (r.distance * r.distance) / 2,  // Convert L2 distance to cosine similarity for normalized vectors
        node_type: r.node_type,
        created_at: r.created_at
      }))
      .filter(r => r.score >= minScore)
      .slice(0, limit);
  }

  // ============ Edge Operations ============

  createEdge(edge: Omit<SynthesisEdge, 'id' | 'created_at'>): SynthesisEdge {
    const now = Date.now();
    const result = this.db.prepare(`
      INSERT INTO synthesis_edges (from_node_id, to_node_id, edge_type, weight, context, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(edge.from_node_id, edge.to_node_id, edge.edge_type, edge.weight, edge.context, now);

    return {
      ...edge,
      id: result.lastInsertRowid as number,
      created_at: now
    };
  }

  getRelatedNodes(nodeId: string): Array<{ node: SynthesisNode; edge: SynthesisEdge }> {
    const results = this.db.prepare(`
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
    `).all(nodeId, nodeId, nodeId) as any[];

    return results.map(row => ({
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
        updated_at: row.updated_at
      } as SynthesisNode,
      edge: {
        id: row.edge_id,
        from_node_id: row.from_node_id,
        to_node_id: row.to_node_id,
        edge_type: row.edge_type,
        weight: row.weight,
        context: row.edge_context,
        created_at: row.edge_created_at
      } as SynthesisEdge
    }));
  }

  // ============ Raw Content Operations ============

  createRawContent(content: Omit<RawContent, 'created_at'>): RawContent {
    const now = Date.now();

    const stmt = this.db.prepare(`
      INSERT INTO raw_content (
        id, session_id, synthesis_node_id, content_type, content,
        agent_id, timestamp, message_index, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.withRetry(() => stmt.run(
      content.id,
      content.session_id,
      content.synthesis_node_id ?? null,
      content.content_type,
      content.content,
      content.agent_id ?? null,
      content.timestamp,
      content.message_index ?? null,
      now
    ));

    return { ...content, created_at: now };
  }

  getRawContentBySession(sessionId: string, limit: number = 100): RawContent[] {
    return this.db.prepare(`
      SELECT * FROM raw_content
      WHERE session_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(sessionId, limit) as RawContent[];
  }

  getRawContentBySynthesis(synthesisNodeId: string): RawContent[] {
    return this.db.prepare(`
      SELECT * FROM raw_content
      WHERE synthesis_node_id = ?
      ORDER BY timestamp ASC
    `).all(synthesisNodeId) as RawContent[];
  }

  getRawContentByIds(ids: string[]): RawContent[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    return this.db.prepare(`
      SELECT * FROM raw_content
      WHERE id IN (${placeholders})
      ORDER BY timestamp ASC
    `).all(...ids) as RawContent[];
  }

  linkRawContentToSynthesis(rawContentIds: string[], synthesisNodeId: string): void {
    const stmt = this.db.prepare(`
      UPDATE raw_content
      SET synthesis_node_id = ?
      WHERE id = ?
    `);

    for (const id of rawContentIds) {
      this.withRetry(() => stmt.run(synthesisNodeId, id));
    }
  }

  // ============ Synthesis Queue Operations ============

  createSynthesisQueueItem(item: Omit<SynthesisQueue, 'id' | 'started_at' | 'completed_at'>): SynthesisQueue {
    const stmt = this.db.prepare(`
      INSERT INTO synthesis_queue (
        session_id, agent_id, chunk_type, raw_content_ids, context,
        message_count, status, retry_count, error, synthesis_node_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = this.withRetry(() => stmt.run(
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
    ));

    return {
      id: result.lastInsertRowid as number,
      ...item,
      started_at: null,
      completed_at: null
    };
  }

  getPendingSynthesisQueue(filters: { limit?: number } = {}): SynthesisQueue[] {
    const { limit = 10 } = filters;
    return this.db.prepare(`
      SELECT * FROM synthesis_queue
      WHERE status = 'pending'
      ORDER BY created_at ASC
      LIMIT ?
    `).all(limit) as SynthesisQueue[];
  }

  getSynthesisQueueItems(filters: {
    session_id?: string;
    status?: SynthesisQueueStatus;
    limit?: number;
  }): SynthesisQueue[] {
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

  updateSynthesisQueueStatus(
    id: number,
    status: SynthesisQueueStatus,
    synthesisNodeId?: string | null,
    error?: string | null
  ): void {
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

  incrementSynthesisQueueRetry(id: number): void {
    const stmt = this.db.prepare(`
      UPDATE synthesis_queue
      SET retry_count = retry_count + 1, status = 'pending'
      WHERE id = ?
    `);
    this.withRetry(() => stmt.run(id));
  }

  resetStuckSynthesisItems(timeoutMs: number): number {
    const cutoffTime = Date.now() - timeoutMs;
    const stmt = this.db.prepare(`
      UPDATE synthesis_queue
      SET status = 'pending', retry_count = retry_count + 1
      WHERE status = 'processing'
        AND (started_at IS NOT NULL AND started_at < ?)
        OR (started_at IS NULL AND created_at < ?)
    `);
    const result = this.withRetry(() => stmt.run(cutoffTime, cutoffTime));
    return result.changes;
  }

  getQueueStats(): { pending: number; processing: number; completed: number; failed: number } {
    const stats = this.db.prepare(`
      SELECT
        COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending,
        COUNT(CASE WHEN status = 'processing' THEN 1 END) as processing,
        COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed,
        COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed
      FROM synthesis_queue
    `).get() as { pending: number; processing: number; completed: number; failed: number };
    return stats;
  }

  // ============ Progressive Disclosure Operations ============

  createProgressiveDisclosureEvent(event: Omit<ProgressiveDisclosureEvent, 'id' | 'created_at'>): ProgressiveDisclosureEvent {
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO progressive_disclosure_events (
        event_type, session_id, agent_id, query_text, search_latency_ms,
        results_count, node_ids, injection_tokens, expanded_node_id,
        expansion_tokens, message_tokens, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = this.withRetry(() => stmt.run(
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
    ));

    return {
      id: result.lastInsertRowid as number,
      ...event,
      created_at: now
    };
  }

  getProgressiveDisclosureAnalytics(startTime: number, endTime: number): {
    totalSearches: number;
    totalInjections: number;
    totalExpansions: number;
    avgSearchLatency: number;
    expansionRate: number;
    totalInjectionTokens: number;
    totalExpansionTokens: number;
  } {
    const stats = this.db.prepare(`
      SELECT
        COUNT(CASE WHEN event_type = 'search' THEN 1 END) as total_searches,
        COUNT(CASE WHEN event_type = 'inject' THEN 1 END) as total_injections,
        COUNT(CASE WHEN event_type = 'expand' THEN 1 END) as total_expansions,
        AVG(CASE WHEN event_type = 'search' THEN search_latency_ms END) as avg_search_latency,
        SUM(CASE WHEN event_type = 'inject' THEN injection_tokens ELSE 0 END) as total_injection_tokens,
        SUM(CASE WHEN event_type = 'expand' THEN expansion_tokens ELSE 0 END) as total_expansion_tokens
      FROM progressive_disclosure_events
      WHERE created_at BETWEEN ? AND ?
    `).get(startTime, endTime) as {
      total_searches: number;
      total_injections: number;
      total_expansions: number;
      avg_search_latency: number | null;
      total_injection_tokens: number | null;
      total_expansion_tokens: number | null;
    };

    const expansionRate = stats.total_injections > 0
      ? stats.total_expansions / stats.total_injections
      : 0;

    return {
      totalSearches: stats.total_searches || 0,
      totalInjections: stats.total_injections || 0,
      totalExpansions: stats.total_expansions || 0,
      avgSearchLatency: stats.avg_search_latency || 0,
      expansionRate,
      totalInjectionTokens: stats.total_injection_tokens || 0,
      totalExpansionTokens: stats.total_expansion_tokens || 0
    };
  }

  // ============ Utility ============

  close(): void {
    this.db.close();
  }
}

// Singleton for shared use
let _db: SynthesisDatabase | null = null;

export function getDatabase(): SynthesisDatabase {
  if (!_db) {
    _db = new SynthesisDatabase();
  }
  return _db;
}
