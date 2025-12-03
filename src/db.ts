/**
 * Total Recall Database with sqlite-vec for vector search
 */

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { randomUUID } from 'crypto';
import { getDbPath } from './paths.js';
import type { SynthesisNode, SynthesisEdge, NodeType, EdgeType, SearchResult } from './schema.js';

export class SynthesisDatabase {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const path = dbPath || getDbPath();
    mkdirSync(dirname(path), { recursive: true });

    this.db = new Database(path);
    sqliteVec.load(this.db);
    this.db.pragma('journal_mode = WAL');
    this.initSchema();
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
    const params: unknown[] = [];

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
    // sqlite-vec uses distance (lower = more similar)
    // We need to convert to similarity score (higher = more similar)
    // For normalized vectors: similarity = 1 - distance

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

    const params: unknown[] = [
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
        score: 1 - r.distance,  // Convert distance to similarity
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
