/**
 * Relationship Builder - Rebuilds graph edges for orphan nodes
 *
 * Uses semantic similarity (embeddings), session context, and temporal
 * relationships to connect disconnected nodes in the synthesis graph.
 */

import type { SynthesisDatabase } from '../db.js';
import type { SynthesisNode, NodeType, EdgeType } from '../schema.js';
import { generateSynthesisEmbedding } from '../embeddings.js';

export interface RelationshipBuilderConfig {
  minSimilarity: number;      // Minimum cosine similarity (0-1)
  maxEdgesPerNode: number;    // Max edges to create per node
  batchSize: number;          // Nodes per batch
  dryRun: boolean;            // Preview without changes
  verbose: boolean;           // Detailed logging
}

export interface RelationshipStats {
  nodesProcessed: number;
  edgesCreated: number;
  edgesSkipped: number;
  orphansFixed: number;
  duplicatesSkipped: number;
  noEmbeddingSkipped: number;
  errors: number;
}

export class RelationshipBuilder {
  constructor(
    private db: SynthesisDatabase,
    private config: RelationshipBuilderConfig
  ) {}

  /**
   * Rebuild relationships for orphan nodes only
   */
  async rebuildOrphans(): Promise<RelationshipStats> {
    const stats: RelationshipStats = {
      nodesProcessed: 0,
      edgesCreated: 0,
      edgesSkipped: 0,
      orphansFixed: 0,
      duplicatesSkipped: 0,
      noEmbeddingSkipped: 0,
      errors: 0,
    };

    const orphans = this.db.getOrphanNodes();

    if (this.config.verbose) {
      console.log(`Found ${orphans.length} orphan nodes`);
    }

    if (orphans.length === 0) {
      return stats;
    }

    // Process in batches
    for (let i = 0; i < orphans.length; i += this.config.batchSize) {
      const batch = orphans.slice(i, i + this.config.batchSize);

      if (this.config.verbose) {
        const batchNum = Math.floor(i / this.config.batchSize) + 1;
        const totalBatches = Math.ceil(orphans.length / this.config.batchSize);
        console.log(`Processing batch ${batchNum}/${totalBatches}`);
      }

      for (const node of batch) {
        try {
          const edgesCreated = await this.createEdgesForNode(node, stats);
          stats.nodesProcessed++;
          if (edgesCreated > 0) {
            stats.orphansFixed++;
          }
        } catch (error) {
          if (this.config.verbose) {
            console.error(`Error processing node ${node.id}:`, error);
          }
          stats.errors++;
        }
      }
    }

    return stats;
  }

  /**
   * Rebuild relationships for all nodes
   */
  async rebuildAll(): Promise<RelationshipStats> {
    const stats: RelationshipStats = {
      nodesProcessed: 0,
      edgesCreated: 0,
      edgesSkipped: 0,
      orphansFixed: 0,
      duplicatesSkipped: 0,
      noEmbeddingSkipped: 0,
      errors: 0,
    };

    const allNodes = this.db.queryNodes({ limit: 10000, order_by: 'created_at' });

    if (this.config.verbose) {
      console.log(`Processing ${allNodes.length} total nodes`);
    }

    // Process in batches
    for (let i = 0; i < allNodes.length; i += this.config.batchSize) {
      const batch = allNodes.slice(i, i + this.config.batchSize);

      if (this.config.verbose) {
        const batchNum = Math.floor(i / this.config.batchSize) + 1;
        const totalBatches = Math.ceil(allNodes.length / this.config.batchSize);
        console.log(`Processing batch ${batchNum}/${totalBatches}`);
      }

      for (const node of batch) {
        try {
          await this.createEdgesForNode(node, stats);
          stats.nodesProcessed++;
        } catch (error) {
          if (this.config.verbose) {
            console.error(`Error processing node ${node.id}:`, error);
          }
          stats.errors++;
        }
      }
    }

    return stats;
  }

  /**
   * Rebuild relationships for a specific session
   */
  async rebuildSession(sessionId: string): Promise<RelationshipStats> {
    const stats: RelationshipStats = {
      nodesProcessed: 0,
      edgesCreated: 0,
      edgesSkipped: 0,
      orphansFixed: 0,
      duplicatesSkipped: 0,
      noEmbeddingSkipped: 0,
      errors: 0,
    };

    const sessionNodes = this.db.getNodesBySession(sessionId);

    if (this.config.verbose) {
      console.log(`Processing ${sessionNodes.length} nodes in session ${sessionId}`);
    }

    // Phase 1: Create session hierarchy (summary -> children)
    await this.createSessionHierarchy(sessionNodes, stats);

    // Phase 2: Create temporal precedence within session
    await this.createTemporalPrecedence(sessionNodes, stats);

    // Phase 3: Semantic similarity for remaining orphans
    for (const node of sessionNodes) {
      const edgeCount = this.db.getEdgeCount(node.id);
      if (edgeCount === 0) {
        try {
          await this.createEdgesForNode(node, stats);
          stats.nodesProcessed++;
        } catch (error) {
          if (this.config.verbose) {
            console.error(`Error processing node ${node.id}:`, error);
          }
          stats.errors++;
        }
      }
    }

    return stats;
  }

  /**
   * Create edges for a single node using semantic similarity
   */
  private async createEdgesForNode(
    node: SynthesisNode,
    stats: RelationshipStats
  ): Promise<number> {
    // Generate embedding for search
    const embedding = await generateSynthesisEmbedding(
      node.one_liner,
      node.summary,
      node.node_type
    );

    // Search for similar nodes
    const candidates = this.db.searchByVector(
      embedding,
      this.config.maxEdgesPerNode * 3, // Over-fetch for filtering
      this.config.minSimilarity
    );

    let edgesCreated = 0;

    for (const candidate of candidates) {
      // Skip self
      if (candidate.node_id === node.id) continue;

      // Check for existing edge
      if (this.db.edgeExists(node.id, candidate.node_id)) {
        stats.duplicatesSkipped++;
        continue;
      }

      // Determine edge type
      const targetNode = this.db.getNode(candidate.node_id);
      if (!targetNode) continue;

      const edgeType = this.determineEdgeType(node, targetNode);

      if (this.config.verbose) {
        console.log(`  ${node.id.slice(0, 8)} -> ${candidate.node_id.slice(0, 8)} (${edgeType}, score: ${candidate.score.toFixed(2)})`);
      }

      if (!this.config.dryRun) {
        this.db.createEdge({
          from_node_id: node.id,
          to_node_id: candidate.node_id,
          edge_type: edgeType,
          weight: candidate.score,
          context: 'auto-rebuilt (semantic)',
        });
      }

      edgesCreated++;
      stats.edgesCreated++;

      if (edgesCreated >= this.config.maxEdgesPerNode) break;
    }

    return edgesCreated;
  }

  /**
   * Create session hierarchy edges (summary -> children)
   */
  private async createSessionHierarchy(
    nodes: SynthesisNode[],
    stats: RelationshipStats
  ): Promise<void> {
    // Find session summary nodes
    const summaries = nodes.filter(n =>
      n.node_type === 'summary' &&
      n.one_liner.toLowerCase().includes('session')
    );

    for (const summary of summaries) {
      // Link to other nodes in the same session
      const children = nodes.filter(n =>
        n.id !== summary.id &&
        n.source_session_id === summary.source_session_id
      );

      for (const child of children.slice(0, 10)) { // Limit to 10 children
        if (this.db.edgeExists(summary.id, child.id)) {
          stats.duplicatesSkipped++;
          continue;
        }

        if (this.config.verbose) {
          console.log(`  Session hierarchy: ${summary.id.slice(0, 8)} -> ${child.id.slice(0, 8)}`);
        }

        if (!this.config.dryRun) {
          this.db.createEdge({
            from_node_id: summary.id,
            to_node_id: child.id,
            edge_type: 'contains',
            weight: 1.0,
            context: 'session hierarchy',
          });
        }

        stats.edgesCreated++;
      }
    }
  }

  /**
   * Create temporal precedence edges within session
   */
  private async createTemporalPrecedence(
    nodes: SynthesisNode[],
    stats: RelationshipStats
  ): Promise<void> {
    // Sort by creation time
    const sorted = [...nodes].sort((a, b) => a.created_at - b.created_at);

    for (let i = 0; i < sorted.length - 1; i++) {
      const current = sorted[i];
      const next = sorted[i + 1];

      // Only link if within 5 minutes
      const timeDiff = next.created_at - current.created_at;
      if (timeDiff > 5 * 60 * 1000) continue;

      // Skip if already connected
      if (this.db.edgeExists(current.id, next.id)) {
        stats.duplicatesSkipped++;
        continue;
      }

      // Check type compatibility for temporal edges
      if (!this.isTemporallyCompatible(current.node_type, next.node_type)) {
        continue;
      }

      if (this.config.verbose) {
        console.log(`  Temporal: ${current.id.slice(0, 8)} -> ${next.id.slice(0, 8)} (preceded)`);
      }

      if (!this.config.dryRun) {
        this.db.createEdge({
          from_node_id: current.id,
          to_node_id: next.id,
          edge_type: 'preceded',
          weight: 1.0 - (timeDiff / (5 * 60 * 1000)), // Higher weight for closer nodes
          context: 'temporal precedence',
        });
      }

      stats.edgesCreated++;
    }
  }

  /**
   * Determine edge type based on node types
   */
  private determineEdgeType(from: SynthesisNode, to: SynthesisNode): EdgeType {
    // Decision -> Task: caused
    if (from.node_type === 'decision' && to.node_type === 'task') {
      return 'caused';
    }

    // Summary -> other: contains (if same session)
    if (from.node_type === 'summary' && from.source_session_id === to.source_session_id) {
      return 'contains';
    }

    // Temporal ordering within session
    if (from.source_session_id === to.source_session_id) {
      if (from.created_at < to.created_at) {
        return 'preceded';
      }
    }

    // Default: semantic relationship
    return 'relates_to';
  }

  /**
   * Check if two node types can have temporal relationship
   */
  private isTemporallyCompatible(type1: NodeType, type2: NodeType): boolean {
    const temporalPairs: Array<[NodeType, NodeType]> = [
      ['decision', 'task'],
      ['decision', 'event'],
      ['decision', 'learning'],
      ['task', 'event'],
      ['task', 'learning'],
      ['event', 'learning'],
      ['learning', 'learning'],
    ];

    return temporalPairs.some(([t1, t2]) =>
      (type1 === t1 && type2 === t2) || (type1 === t2 && type2 === t1)
    );
  }
}
