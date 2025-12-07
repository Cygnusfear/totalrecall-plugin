/**
 * Salience Database Operations
 *
 * Extensions to the SynthesisDatabase for salience scoring.
 * These operations can be added to db.ts or used as a mixin.
 */

import type { Database } from 'bun:sqlite';
import type { DreamingPass, DreamingPassType, SalienceComponents, SalienceStats } from './types.js';
import type { NodeType, SynthesisNode } from '../schema.js';

/**
 * Initialize salience-related tables and columns
 */
export function initSalienceSchema(db: Database): void {
  // Dreaming passes table
  db.exec(`
    CREATE TABLE IF NOT EXISTS dreaming_passes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pass_type TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      nodes_processed INTEGER DEFAULT 0,
      nodes_updated INTEGER DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      error TEXT,
      created_at INTEGER NOT NULL
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_dreaming_passes_status ON dreaming_passes(status);
    CREATE INDEX IF NOT EXISTS idx_dreaming_passes_created ON dreaming_passes(created_at DESC);
  `);

  // Migrate salience columns to synthesis_nodes
  migrateSalienceColumns(db);
}

/**
 * Add salience columns to synthesis_nodes if they don't exist
 */
export function migrateSalienceColumns(db: Database): void {
  const columns = db.prepare("PRAGMA table_info(synthesis_nodes)").all() as { name: string }[];
  const columnNames = columns.map(c => c.name);

  if (!columnNames.includes('salience')) {
    db.exec(`
      ALTER TABLE synthesis_nodes ADD COLUMN salience REAL DEFAULT 1.0;
      ALTER TABLE synthesis_nodes ADD COLUMN salience_components TEXT;
      ALTER TABLE synthesis_nodes ADD COLUMN is_novel INTEGER DEFAULT 0;
      ALTER TABLE synthesis_nodes ADD COLUMN is_emotional INTEGER DEFAULT 0;
      ALTER TABLE synthesis_nodes ADD COLUMN is_consequential INTEGER DEFAULT 0;
      ALTER TABLE synthesis_nodes ADD COLUMN is_user_marked INTEGER DEFAULT 0;
      ALTER TABLE synthesis_nodes ADD COLUMN similar_count INTEGER DEFAULT 0;
    `);

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_nodes_salience ON synthesis_nodes(salience DESC);
    `);
  }
}

/**
 * Update salience score and components for a node
 */
export function updateNodeSalience(
  db: Database,
  nodeId: string,
  salience: number,
  components: SalienceComponents
): void {
  db.prepare(`
    UPDATE synthesis_nodes
    SET salience = ?, salience_components = ?, updated_at = ?
    WHERE id = ?
  `).run(salience, JSON.stringify(components), Date.now(), nodeId);
}

/**
 * Mark a node as user-important
 */
export function markNodeImportant(db: Database, nodeId: string, isImportant: boolean): void {
  db.prepare(`
    UPDATE synthesis_nodes
    SET is_user_marked = ?, updated_at = ?
    WHERE id = ?
  `).run(isImportant ? 1 : 0, Date.now(), nodeId);
}

/**
 * Update node flags (novel, emotional, consequential)
 */
export function updateNodeFlags(
  db: Database,
  nodeId: string,
  flags: {
    is_novel?: boolean;
    is_emotional?: boolean;
    is_consequential?: boolean;
  }
): void {
  const updates: string[] = ['updated_at = ?'];
  const values: (number | string)[] = [Date.now()];

  if (flags.is_novel !== undefined) {
    updates.push('is_novel = ?');
    values.push(flags.is_novel ? 1 : 0);
  }
  if (flags.is_emotional !== undefined) {
    updates.push('is_emotional = ?');
    values.push(flags.is_emotional ? 1 : 0);
  }
  if (flags.is_consequential !== undefined) {
    updates.push('is_consequential = ?');
    values.push(flags.is_consequential ? 1 : 0);
  }

  values.push(nodeId);

  db.prepare(`
    UPDATE synthesis_nodes
    SET ${updates.join(', ')}
    WHERE id = ?
  `).run(...values);
}

/**
 * Update similar_count for a node
 */
export function updateSimilarCount(db: Database, nodeId: string, count: number): void {
  db.prepare(`
    UPDATE synthesis_nodes
    SET similar_count = ?, updated_at = ?
    WHERE id = ?
  `).run(count, Date.now(), nodeId);
}

/**
 * Get nodes for dreaming pass
 */
export function getNodesForDreamingPass(
  db: Database,
  passType: DreamingPassType,
  limit: number = 1000
): SynthesisNode[] {
  let query: string;

  switch (passType) {
    case 'decay':
      query = `SELECT * FROM synthesis_nodes WHERE salience < 0.5 ORDER BY last_updated ASC LIMIT ?`;
      break;
    case 'frequency_analysis':
      query = `SELECT * FROM synthesis_nodes ORDER BY last_updated DESC LIMIT ?`;
      break;
    case 'novelty_detection':
    case 'emotional_detection':
      query = `SELECT * FROM synthesis_nodes ORDER BY last_updated DESC LIMIT ?`;
      break;
    case 'full':
    default:
      query = `SELECT * FROM synthesis_nodes ORDER BY created_at ASC LIMIT ?`;
  }

  return db.prepare(query).all(limit) as SynthesisNode[];
}

/**
 * Log a dreaming pass
 */
export function logDreamingPass(db: Database, pass: Omit<DreamingPass, 'id'>): number {
  const result = db.prepare(`
    INSERT INTO dreaming_passes (
      pass_type, started_at, completed_at, nodes_processed, nodes_updated,
      status, error, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    pass.pass_type,
    pass.started_at,
    pass.completed_at,
    pass.nodes_processed,
    pass.nodes_updated,
    pass.status,
    pass.error,
    Date.now()
  );

  return result.lastInsertRowid as number;
}

/**
 * Get last dreaming pass
 */
export function getLastDreamingPass(db: Database, passType?: DreamingPassType): DreamingPass | null {
  let query = 'SELECT * FROM dreaming_passes';
  const params: string[] = [];

  if (passType) {
    query += ' WHERE pass_type = ?';
    params.push(passType);
  }

  query += ' ORDER BY created_at DESC LIMIT 1';

  const result = db.prepare(query).get(...params) as DreamingPass | undefined;
  return result || null;
}

/**
 * Get salience statistics
 */
export function getSalienceStats(db: Database): SalienceStats {
  const stats = db.prepare(`
    SELECT
      COUNT(*) as total_nodes,
      AVG(salience) as avg_salience,
      COUNT(CASE WHEN salience >= 1.0 THEN 1 END) as high_salience_count,
      COUNT(CASE WHEN salience < 0.5 THEN 1 END) as low_salience_count,
      COUNT(CASE WHEN salience < 0.3 THEN 1 END) as routine_count
    FROM synthesis_nodes
  `).get() as {
    total_nodes: number;
    avg_salience: number | null;
    high_salience_count: number;
    low_salience_count: number;
    routine_count: number;
  };

  const lastPass = getLastDreamingPass(db);

  return {
    total_nodes: stats.total_nodes || 0,
    avg_salience: stats.avg_salience || 1.0,
    high_salience_count: stats.high_salience_count || 0,
    low_salience_count: stats.low_salience_count || 0,
    routine_count: stats.routine_count || 0,
    last_dreaming_pass: lastPass
  };
}

/**
 * Enhanced search result with salience
 */
export interface SalienceSearchResult {
  node_id: string;
  one_liner: string;
  score: number;
  node_type: NodeType;
  created_at: number;
  last_updated: number;
  edge_count: number;
  salience: number;
}

/**
 * Search with salience-weighted scoring
 * Combined score: vector_similarity * 0.6 + recency * 0.2 + salience * 0.2
 */
export function searchByVectorWithSalience(
  db: Database,
  queryEmbedding: number[],
  limit: number,
  minScore: number,
  nodeTypes?: NodeType[]
): SalienceSearchResult[] {
  let query = `
    SELECT
      sn.id as node_id,
      sn.one_liner,
      sn.node_type,
      sn.created_at,
      sn.last_updated,
      COALESCE(sn.salience, 1.0) as salience,
      vec.distance,
      (SELECT COUNT(*) FROM synthesis_edges WHERE from_node_id = sn.id OR to_node_id = sn.id) as edge_count
    FROM vec_synthesis AS vec
    JOIN synthesis_nodes AS sn ON vec.id = sn.id
    WHERE vec.embedding MATCH ? AND k = ?
  `;

  const params: (string | number | Buffer | null)[] = [
    Buffer.from(new Float32Array(queryEmbedding).buffer),
    limit * 2
  ];

  if (nodeTypes?.length) {
    query += ` AND sn.node_type IN (${nodeTypes.map(() => '?').join(',')})`;
    params.push(...nodeTypes);
  }

  query += ' ORDER BY vec.distance ASC';

  const results = db.prepare(query).all(...params) as Array<{
    node_id: string;
    one_liner: string;
    node_type: NodeType;
    created_at: number;
    last_updated: number;
    salience: number;
    distance: number;
    edge_count: number;
  }>;

  const now = Date.now();
  const recencyHalfLifeDays = 30;

  return results
    .map(r => {
      const vectorScore = 1 - (r.distance * r.distance) / 2;
      const ageDays = (now - r.last_updated) / (1000 * 60 * 60 * 24);
      const recency = Math.pow(0.5, ageDays / recencyHalfLifeDays);
      const salience = r.salience || 1.0;

      // Combined score: vector_similarity * 0.6 + recency * 0.2 + salience * 0.2
      const combinedScore = (vectorScore * 0.6) + (recency * 0.2) + ((salience / 2) * 0.2);

      return {
        node_id: r.node_id,
        one_liner: r.one_liner,
        score: combinedScore,
        node_type: r.node_type,
        created_at: r.created_at,
        last_updated: r.last_updated,
        edge_count: r.edge_count,
        salience: r.salience
      };
    })
    .filter(r => r.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
