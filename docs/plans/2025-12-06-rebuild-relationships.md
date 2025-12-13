# Rebuild Relationships Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create a CLI command that rebuilds graph relationships for orphan nodes using semantic similarity, temporal context, and session hierarchy.

**Architecture:** Three-phase relationship builder: (1) semantic similarity using existing sqlite-vec embeddings, (2) session hierarchy linking session summaries to child nodes, (3) temporal precedence within sessions. CLI command with dry-run mode for safe execution.

**Tech Stack:** Bun, SQLite with sqlite-vec, Xenova/transformers embeddings (384-dim)

---

## Current State (from Issue #6)

- 718 nodes, 340 edges (0.47 edges/node - critically low)
- 442 orphan nodes (61.5%) with zero relationships
- 91% of edges are generic `relates_to` - lacks semantic precision

## Task Overview

| Task | Description | Files |
|------|-------------|-------|
| 1 | Add `edgeExists()` and `getOrphanNodes()` to database | `src/db.ts` |
| 2 | Create relationship builder module | `src/lib/relationship-builder.ts` |
| 3 | Create CLI command | `src/cli/rebuild-relationships.ts` |
| 4 | Register CLI command | `cli/totalrecall.js` |
| 5 | Add integration tests | `test/integration.ts` |
| 6 | Update status CLI with orphan count | `src/cli/status.ts` |

---

### Task 1: Add Database Helper Methods

**Files:**
- Modify: `src/db.ts:346-414` (after createEdge, before getRelatedNodes)

**Step 1: Write the failing test**

Add to `test/integration.ts` before `main()`:

```typescript
async function testEdgeHelpers() {
  console.log('Test: Edge helper methods...');
  await cleanup();
  const db = new SynthesisDatabase(TEST_DB_PATH);

  // Create two nodes
  const node1 = db.createNode({
    node_type: 'learning',
    one_liner: 'Test node 1',
    summary: 'Summary 1',
    full_synthesis: 'Full 1',
    entity_name: null,
    entity_aliases: null,
    temporal_context: null,
    first_seen: Date.now(),
    last_updated: Date.now(),
    status: null,
    assigned_agent: null,
    priority: null,
    source_session_id: 'test-session',
    source_agent_id: null,
    source_repo: null,
  });

  const node2 = db.createNode({
    node_type: 'decision',
    one_liner: 'Test node 2',
    summary: 'Summary 2',
    full_synthesis: 'Full 2',
    entity_name: null,
    entity_aliases: null,
    temporal_context: null,
    first_seen: Date.now(),
    last_updated: Date.now(),
    status: null,
    assigned_agent: null,
    priority: null,
    source_session_id: 'test-session',
    source_agent_id: null,
    source_repo: null,
  });

  // Test edgeExists - should be false
  if (db.edgeExists(node1.id, node2.id)) {
    throw new Error('edgeExists should return false for non-existent edge');
  }
  console.log('  - edgeExists (no edge): PASS');

  // Create an edge
  db.createEdge({
    from_node_id: node1.id,
    to_node_id: node2.id,
    edge_type: 'relates_to',
    weight: 0.8,
    context: 'test',
  });

  // Test edgeExists - should be true (forward direction)
  if (!db.edgeExists(node1.id, node2.id)) {
    throw new Error('edgeExists should return true for existing edge');
  }
  console.log('  - edgeExists (forward): PASS');

  // Test edgeExists - should be true (reverse direction check)
  if (!db.edgeExists(node2.id, node1.id)) {
    throw new Error('edgeExists should return true for reverse direction');
  }
  console.log('  - edgeExists (reverse): PASS');

  // Test getOrphanNodes
  const node3 = db.createNode({
    node_type: 'event',
    one_liner: 'Orphan node',
    summary: 'This node has no edges',
    full_synthesis: 'Full 3',
    entity_name: null,
    entity_aliases: null,
    temporal_context: null,
    first_seen: Date.now(),
    last_updated: Date.now(),
    status: null,
    assigned_agent: null,
    priority: null,
    source_session_id: 'test-session',
    source_agent_id: null,
    source_repo: null,
  });

  const orphans = db.getOrphanNodes();
  if (orphans.length !== 1 || orphans[0].id !== node3.id) {
    throw new Error(`Expected 1 orphan (node3), got ${orphans.length}`);
  }
  console.log('  - getOrphanNodes: PASS');

  // Test getOrphanNodes with node type filter
  const orphansFiltered = db.getOrphanNodes(['decision']);
  if (orphansFiltered.length !== 0) {
    throw new Error('Expected 0 orphans with decision filter');
  }
  console.log('  - getOrphanNodes (filtered): PASS');

  db.close();
  console.log('Edge helper tests: PASS\n');
}
```

**Step 2: Run test to verify it fails**

Run: `bun test/integration.ts`
Expected: FAIL with "db.edgeExists is not a function"

**Step 3: Write minimal implementation**

Add to `src/db.ts` after line 359 (after `createEdge` method):

```typescript
  /**
   * Check if an edge exists between two nodes (in either direction)
   */
  edgeExists(nodeId1: string, nodeId2: string): boolean {
    const result = this.db.prepare(`
      SELECT COUNT(*) as count
      FROM synthesis_edges
      WHERE (from_node_id = ? AND to_node_id = ?)
         OR (from_node_id = ? AND to_node_id = ?)
    `).get(nodeId1, nodeId2, nodeId2, nodeId1) as { count: number };

    return result.count > 0;
  }

  /**
   * Get all nodes with zero edges (orphans)
   */
  getOrphanNodes(nodeTypes?: NodeType[]): SynthesisNode[] {
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

  /**
   * Get count of edges for a node
   */
  getEdgeCount(nodeId: string): number {
    const result = this.db.prepare(`
      SELECT COUNT(*) as count
      FROM synthesis_edges
      WHERE from_node_id = ? OR to_node_id = ?
    `).get(nodeId, nodeId) as { count: number };

    return result.count;
  }

  /**
   * Get nodes by session ID
   */
  getNodesBySession(sessionId: string): SynthesisNode[] {
    return this.db.prepare(`
      SELECT * FROM synthesis_nodes
      WHERE source_session_id = ?
      ORDER BY created_at ASC
    `).all(sessionId) as SynthesisNode[];
  }

  /**
   * Get all unique session IDs
   */
  getAllSessionIds(): string[] {
    const rows = this.db.prepare(`
      SELECT DISTINCT source_session_id
      FROM synthesis_nodes
      WHERE source_session_id IS NOT NULL
      ORDER BY MIN(created_at) DESC
    `).all() as Array<{ source_session_id: string }>;

    return rows.map(r => r.source_session_id);
  }
```

**Step 4: Update test runner in main()**

In `test/integration.ts`, add to main() after `testProgressiveDisclosureAnalytics()`:

```typescript
    await testEdgeHelpers();
```

**Step 5: Run test to verify it passes**

Run: `bun test/integration.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add src/db.ts test/integration.ts
git commit -m "$(cat <<'EOF'
feat: add edge helper methods for relationship rebuilding

Add edgeExists(), getOrphanNodes(), getEdgeCount(), getNodesBySession(),
and getAllSessionIds() methods to support the rebuild-relationships CLI.

Closes #6 (partial)

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Create Relationship Builder Module

**Files:**
- Create: `src/lib/relationship-builder.ts`

**Step 1: Create the directory**

Run: `mkdir -p src/lib`

**Step 2: Write the failing test**

Add to `test/integration.ts`:

```typescript
async function testRelationshipBuilder() {
  console.log('Test: Relationship builder...');
  await cleanup();
  const db = new SynthesisDatabase(TEST_DB_PATH);
  await initEmbeddings();

  // Import dynamically to test
  const { RelationshipBuilder } = await import('../src/lib/relationship-builder.js');

  // Create 3 nodes - 2 with edges, 1 orphan
  const node1 = db.createNode({
    node_type: 'learning',
    one_liner: 'React hooks best practices',
    summary: 'Learned about useEffect cleanup and dependency arrays',
    full_synthesis: 'Full details about React hooks',
    entity_name: null,
    entity_aliases: null,
    temporal_context: null,
    first_seen: Date.now(),
    last_updated: Date.now(),
    status: null,
    assigned_agent: null,
    priority: null,
    source_session_id: 'session-1',
    source_agent_id: null,
    source_repo: null,
  });
  const emb1 = await generateSynthesisEmbedding(node1.one_liner, node1.summary, node1.node_type);
  db.insertEmbedding(node1.id, emb1);

  const node2 = db.createNode({
    node_type: 'decision',
    one_liner: 'Use React for frontend',
    summary: 'Decided to use React framework for the web application',
    full_synthesis: 'Full decision rationale',
    entity_name: null,
    entity_aliases: null,
    temporal_context: null,
    first_seen: Date.now(),
    last_updated: Date.now(),
    status: null,
    assigned_agent: null,
    priority: null,
    source_session_id: 'session-1',
    source_agent_id: null,
    source_repo: null,
  });
  const emb2 = await generateSynthesisEmbedding(node2.one_liner, node2.summary, node2.node_type);
  db.insertEmbedding(node2.id, emb2);

  // Create edge between node1 and node2
  db.createEdge({
    from_node_id: node1.id,
    to_node_id: node2.id,
    edge_type: 'relates_to',
    weight: 0.8,
    context: 'existing',
  });

  // Orphan node (related to React but no edges)
  const orphan = db.createNode({
    node_type: 'learning',
    one_liner: 'React state management patterns',
    summary: 'Patterns for managing state in React applications',
    full_synthesis: 'Full state management guide',
    entity_name: null,
    entity_aliases: null,
    temporal_context: null,
    first_seen: Date.now(),
    last_updated: Date.now(),
    status: null,
    assigned_agent: null,
    priority: null,
    source_session_id: 'session-1',
    source_agent_id: null,
    source_repo: null,
  });
  const embOrphan = await generateSynthesisEmbedding(orphan.one_liner, orphan.summary, orphan.node_type);
  db.insertEmbedding(orphan.id, embOrphan);

  // Verify orphan exists
  const orphansBefore = db.getOrphanNodes();
  if (orphansBefore.length !== 1) {
    throw new Error(`Expected 1 orphan before rebuild, got ${orphansBefore.length}`);
  }
  console.log('  - Initial orphan count: PASS');

  // Run relationship builder (dry run first)
  const builder = new RelationshipBuilder(db, {
    minSimilarity: 0.5,
    maxEdgesPerNode: 5,
    batchSize: 10,
    dryRun: true,
    verbose: false,
  });

  const dryRunStats = await builder.rebuildOrphans();
  if (dryRunStats.edgesCreated === 0) {
    throw new Error('Dry run should have found edges to create');
  }
  console.log(`  - Dry run found ${dryRunStats.edgesCreated} potential edges: PASS`);

  // Verify no edges were actually created (dry run)
  const orphansAfterDry = db.getOrphanNodes();
  if (orphansAfterDry.length !== 1) {
    throw new Error('Dry run should not create edges');
  }
  console.log('  - Dry run did not modify DB: PASS');

  // Run actual rebuild
  const realBuilder = new RelationshipBuilder(db, {
    minSimilarity: 0.5,
    maxEdgesPerNode: 5,
    batchSize: 10,
    dryRun: false,
    verbose: false,
  });

  const realStats = await realBuilder.rebuildOrphans();
  if (realStats.edgesCreated === 0) {
    throw new Error('Real rebuild should have created edges');
  }
  console.log(`  - Real rebuild created ${realStats.edgesCreated} edges: PASS`);

  // Verify orphan is now connected
  const orphansAfter = db.getOrphanNodes();
  if (orphansAfter.length !== 0) {
    throw new Error(`Expected 0 orphans after rebuild, got ${orphansAfter.length}`);
  }
  console.log('  - Orphan now connected: PASS');

  db.close();
  console.log('Relationship builder tests: PASS\n');
}
```

**Step 3: Run test to verify it fails**

Run: `bun test/integration.ts`
Expected: FAIL with "Cannot find module '../src/lib/relationship-builder.js'"

**Step 4: Write minimal implementation**

Create `src/lib/relationship-builder.ts`:

```typescript
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
```

**Step 5: Update test runner**

Add to `test/integration.ts` main():

```typescript
    await testRelationshipBuilder();
```

**Step 6: Run test to verify it passes**

Run: `bun test/integration.ts`
Expected: PASS

**Step 7: Commit**

```bash
git add src/lib/relationship-builder.ts test/integration.ts
git commit -m "$(cat <<'EOF'
feat: add RelationshipBuilder for orphan node reconnection

Implements semantic similarity, session hierarchy, and temporal
precedence strategies to rebuild graph relationships.

- rebuildOrphans(): fix disconnected nodes
- rebuildSession(): rebuild specific session
- rebuildAll(): full graph rebuild (use with caution)

Closes #6 (partial)

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Create CLI Command

**Files:**
- Create: `src/cli/rebuild-relationships.ts`

**Step 1: Write the CLI implementation**

Create `src/cli/rebuild-relationships.ts`:

```typescript
/**
 * CLI: rebuild-relationships
 * Rebuild graph edges for orphan or all nodes
 */

import { getDatabase } from '../db.js';
import { initEmbeddings } from '../embeddings.js';
import { RelationshipBuilder } from '../lib/relationship-builder.js';

function parseArgs(args: string[]) {
  const result: Record<string, string | boolean> = {};

  for (const arg of args) {
    if (arg.startsWith('--')) {
      const [key, value] = arg.slice(2).split('=');
      result[key] = value ?? true;
    }
  }

  return result;
}

function printHelp() {
  console.log(`Total Recall - Rebuild Relationships

Usage: totalrecall rebuild-relationships [OPTIONS]

Options:
  --dry-run              Show what would be done without making changes
  --orphans-only         Only rebuild relationships for orphan nodes (RECOMMENDED)
  --full                 Rebuild relationships for all nodes (SLOW)
  --session-id=<id>      Rebuild relationships for specific session
  --min-similarity=0.5   Minimum similarity score for relationships (default: 0.5)
  --max-edges=5          Max edges to create per node (default: 5)
  --batch-size=50        Nodes to process per batch (default: 50)
  --verbose              Show detailed progress

Examples:
  # Dry run to see what would be done
  totalrecall rebuild-relationships --orphans-only --dry-run

  # Rebuild relationships for orphan nodes
  totalrecall rebuild-relationships --orphans-only

  # Rebuild for specific session
  totalrecall rebuild-relationships --session-id=abc-123

  # Full rebuild (SLOW)
  totalrecall rebuild-relationships --full --verbose
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const dryRun = args['dry-run'] === true;
  const orphansOnly = args['orphans-only'] === true;
  const full = args['full'] === true;
  const verbose = args['verbose'] === true;
  const sessionId = typeof args['session-id'] === 'string' ? args['session-id'] : undefined;
  const minSimilarity = typeof args['min-similarity'] === 'string'
    ? parseFloat(args['min-similarity'])
    : 0.5;
  const maxEdges = typeof args['max-edges'] === 'string'
    ? parseInt(args['max-edges'])
    : 5;
  const batchSize = typeof args['batch-size'] === 'string'
    ? parseInt(args['batch-size'])
    : 50;

  if (!orphansOnly && !full && !sessionId) {
    printHelp();
    process.exit(0);
  }

  console.log('Total Recall - Rebuild Relationships');
  console.log('====================================\n');

  if (dryRun) {
    console.log('DRY RUN MODE - No changes will be made\n');
  }

  console.log('Configuration:');
  console.log(`  Min similarity: ${minSimilarity}`);
  console.log(`  Max edges/node: ${maxEdges}`);
  console.log(`  Batch size:     ${batchSize}`);
  console.log('');

  const db = getDatabase();

  // Show initial stats
  const orphansBefore = db.getOrphanNodes();
  const totalNodes = db.queryNodes({ limit: 10000 }).length;
  console.log(`Initial state:`);
  console.log(`  Total nodes:  ${totalNodes}`);
  console.log(`  Orphan nodes: ${orphansBefore.length} (${((orphansBefore.length / totalNodes) * 100).toFixed(1)}%)`);
  console.log('');

  console.log('Loading embedding model...');
  await initEmbeddings();

  const builder = new RelationshipBuilder(db, {
    minSimilarity,
    maxEdgesPerNode: maxEdges,
    batchSize,
    dryRun,
    verbose,
  });

  const startTime = Date.now();
  let stats;

  try {
    if (sessionId) {
      console.log(`\nMode: Rebuild session ${sessionId}\n`);
      stats = await builder.rebuildSession(sessionId);
    } else if (orphansOnly) {
      console.log('\nMode: Rebuild orphans only\n');
      stats = await builder.rebuildOrphans();
    } else if (full) {
      console.log('\nMode: Full rebuild (all nodes)\n');
      stats = await builder.rebuildAll();
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log('\n====================================');
    console.log('Rebuild Complete');
    console.log('====================================');
    console.log(`Nodes processed:      ${stats!.nodesProcessed}`);
    console.log(`Edges created:        ${stats!.edgesCreated}`);
    console.log(`Duplicates skipped:   ${stats!.duplicatesSkipped}`);
    console.log(`Orphans fixed:        ${stats!.orphansFixed}`);
    console.log(`Errors:               ${stats!.errors}`);
    console.log(`Duration:             ${duration}s`);

    if (!dryRun) {
      const orphansAfter = db.getOrphanNodes();
      console.log('');
      console.log(`Final state:`);
      console.log(`  Orphan nodes: ${orphansAfter.length} (${((orphansAfter.length / totalNodes) * 100).toFixed(1)}%)`);
      console.log(`  Reduction:    ${orphansBefore.length - orphansAfter.length} nodes connected`);
    }

    if (dryRun) {
      console.log('\nDRY RUN - No changes were made. Remove --dry-run to apply changes.');
    }
  } catch (error) {
    console.error('Error during rebuild:', error);
    process.exit(1);
  } finally {
    db.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

**Step 2: Test CLI manually**

Run: `bun src/cli/rebuild-relationships.ts --help`
Expected: Help text displayed

Run: `bun src/cli/rebuild-relationships.ts --orphans-only --dry-run`
Expected: Dry run output showing potential edges

**Step 3: Commit**

```bash
git add src/cli/rebuild-relationships.ts
git commit -m "$(cat <<'EOF'
feat: add rebuild-relationships CLI command

New command to rebuild graph relationships for orphan nodes:
- --orphans-only: fix disconnected nodes (recommended)
- --full: rebuild all nodes (slow)
- --session-id: rebuild specific session
- --dry-run: preview without changes

Closes #6 (partial)

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Register CLI Command

**Files:**
- Modify: `cli/totalrecall.js`

**Step 1: Add case for rebuild-relationships**

Add to `cli/totalrecall.js` in the switch statement (after `case 'worker':`, around line 103):

```javascript
      case 'rebuild-relationships':
        await runCommand(join(srcDir, 'cli', 'rebuild-relationships.ts'), args);
        break;
```

**Step 2: Update help text**

Update the help text in `cli/totalrecall.js` (around line 119-132) to add:

```javascript
  rebuild-relationships Rebuild graph edges for orphan nodes
                      --orphans-only  Fix disconnected nodes (recommended)
                      --full          Rebuild all nodes (slow)
                      --session-id=X  Rebuild specific session
                      --dry-run       Preview without changes
```

**Step 3: Test the command**

Run: `./cli/totalrecall.js rebuild-relationships --help`
Expected: Help text

Run: `./cli/totalrecall.js rebuild-relationships --orphans-only --dry-run`
Expected: Dry run execution

**Step 4: Commit**

```bash
git add cli/totalrecall.js
git commit -m "$(cat <<'EOF'
feat: register rebuild-relationships in CLI

Add rebuild-relationships command to main CLI entry point.

Closes #6

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Update Status CLI with Orphan Count

**Files:**
- Modify: `src/cli/status.ts`

**Step 1: Update status.ts to show orphan stats**

Replace `src/cli/status.ts`:

```typescript
/**
 * CLI: status
 * Check system status including graph health
 */

import { getDatabase } from '../db.js';

async function main() {
  const db = getDatabase();

  const nodes = db.queryNodes({ limit: 10000 });
  const queueItems = db.getSynthesisQueueItems({ limit: 1000 });
  const orphans = db.getOrphanNodes();

  const pending = queueItems.filter((i) => i.status === 'pending').length;
  const processing = queueItems.filter((i) => i.status === 'processing').length;
  const completed = queueItems.filter((i) => i.status === 'completed').length;
  const failed = queueItems.filter((i) => i.status === 'failed').length;

  // Count edges (approximate via edge count on nodes)
  let totalEdges = 0;
  for (const node of nodes.slice(0, 100)) {
    totalEdges += db.getEdgeCount(node.id);
  }
  // Edges are counted twice (from and to), so divide
  const estimatedEdges = Math.round((totalEdges / 100) * nodes.length / 2);
  const edgesPerNode = nodes.length > 0 ? (estimatedEdges / nodes.length).toFixed(2) : '0.00';

  console.log('Total Recall Status');
  console.log('==================');
  console.log('');
  console.log('Graph Health:');
  console.log(`  Synthesis nodes:  ${nodes.length}`);
  console.log(`  Estimated edges:  ~${estimatedEdges}`);
  console.log(`  Edges per node:   ~${edgesPerNode}`);
  console.log(`  Orphan nodes:     ${orphans.length} (${((orphans.length / nodes.length) * 100).toFixed(1)}%)`);

  if (orphans.length > 50) {
    console.log('');
    console.log('  ⚠️  High orphan count! Run: totalrecall rebuild-relationships --orphans-only');
  }

  console.log('');
  console.log('Queue Status:');
  console.log(`  Pending:    ${pending}`);
  console.log(`  Processing: ${processing}`);
  console.log(`  Completed:  ${completed}`);
  console.log(`  Failed:     ${failed}`);
  console.log('');
  console.log(`Worker: ${process.env.ANTHROPIC_API_KEY ? 'Enabled' : 'Disabled (no API key)'}`);

  db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

**Step 2: Test status command**

Run: `./cli/totalrecall.js status`
Expected: Status with graph health metrics including orphan count

**Step 3: Commit**

```bash
git add src/cli/status.ts
git commit -m "$(cat <<'EOF'
feat: add graph health metrics to status CLI

Show orphan node count, edges per node, and warn when
orphan count is high with suggested remediation.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Run Full Test Suite

**Step 1: Run all tests**

Run: `bun test/integration.ts`
Expected: ALL TESTS PASSED

**Step 2: Build TypeScript**

Run: `bun run build`
Expected: Build completes without errors

**Step 3: Manual E2E test**

Run: `./cli/totalrecall.js status`
Run: `./cli/totalrecall.js rebuild-relationships --orphans-only --dry-run`
Run: `./cli/totalrecall.js rebuild-relationships --orphans-only`
Run: `./cli/totalrecall.js status`

Expected: Orphan count decreases significantly after rebuild

**Step 4: Final commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
test: verify rebuild-relationships e2e

All tests pass, CLI works as expected.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Summary

This plan implements the `rebuild-relationships` CLI command in 6 tasks:

1. **Database helpers** - `edgeExists()`, `getOrphanNodes()`, etc.
2. **RelationshipBuilder** - Core logic with semantic, session, temporal strategies
3. **CLI command** - `src/cli/rebuild-relationships.ts`
4. **CLI registration** - Add to `cli/totalrecall.js`
5. **Status enhancement** - Show orphan count and graph health
6. **Full test suite** - Integration tests and E2E validation

Expected outcomes after running `rebuild-relationships --orphans-only`:
- Orphan nodes: 442 (61.5%) → <50 (<7%)
- Edges per node: 0.47 → 2-3
