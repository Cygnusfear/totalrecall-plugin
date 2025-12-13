# Oracle 2: Temporal/Session Context Relationship Rebuilding

## Executive Summary

This proposal outlines a comprehensive approach to rebuilding relationships in the Total Recall synthesis graph using temporal and session context. The current graph has **717 nodes with only 340 edges (0.47 edges/node)**, indicating significant under-connectivity. Many session summary nodes are floating disconnected, missing critical temporal and hierarchical relationships.

## Current State Analysis

### Graph Statistics
- **Total nodes**: 718
- **Total edges**: 340 (0.47 edges/node - **critically low**)
- **Unique sessions**: 119
- **Session summary nodes**: 108 (many disconnected)

### Node Distribution
- `summary`: 164 nodes (23%)
- `learning`: 183 nodes (26%)
- `event`: 131 nodes (18%)
- `task`: 117 nodes (16%)
- `decision`: 79 nodes (11%)
- `entity`: 44 nodes (6%)

### Edge Distribution (Current)
- `relates_to`: 311 edges (91% - overused, lacks semantic precision)
- `preceded`: 10 edges (3%)
- `caused`: 8 edges (2%)
- `contradicts`: 6 edges (2%)
- `contains`: 3 edges (1%)
- `informs`: 2 edges (0.6%)

### Key Problems Identified

1. **Disconnected Session Summaries**: 108 "Session:" summary nodes, many not linked to their content
2. **Under-connected Graph**: 0.47 edges/node suggests 50%+ of nodes have zero relationships
3. **Poor Edge Type Diversity**: 91% `relates_to` edges lack semantic meaning
4. **Missing Temporal Chains**: Only 10 `preceded` edges despite strong temporal ordering
5. **Weak Session Hierarchies**: Only 3 `contains` edges, missing parent-child session structure

## Architecture: Temporal/Session Relationship Discovery

### 1. Session-Based Clustering

#### Concept
Nodes created in the same session form a **temporal cluster** with implicit relationships through shared context, time proximity, and conversational flow.

#### Implementation Strategy

```typescript
interface SessionCluster {
  session_id: string;
  nodes: SynthesisNode[];
  start_time: number;
  end_time: number;
  session_summary_node_id: string | null;
}

function buildSessionClusters(db: SynthesisDatabase): SessionCluster[] {
  // Group all nodes by source_session_id
  const sessions = db.queryAllSessions();

  return sessions.map(session_id => {
    const nodes = db.queryNodes({
      session_id,
      limit: 1000,
      order_by: 'created_at'
    });

    // Find or create session summary node
    const summaryNode = nodes.find(n =>
      n.node_type === 'summary' &&
      (n.one_liner.includes('Session started') || n.one_liner.includes('Session complete'))
    );

    return {
      session_id,
      nodes,
      start_time: Math.min(...nodes.map(n => n.created_at)),
      end_time: Math.max(...nodes.map(n => n.created_at)),
      session_summary_node_id: summaryNode?.id ?? null
    };
  });
}
```

### 2. Temporal Ordering Within Sessions

#### Edge Type: `preceded`
**Semantics**: Node A was created immediately before Node B in the same session/conversation

**Application**:
- Link consecutive decisions in a session
- Connect task → learning chains (task leads to learning)
- Link events in temporal sequence

```typescript
function createTemporalPrecedenceEdges(
  cluster: SessionCluster,
  db: SynthesisDatabase
): number {
  let edgesCreated = 0;
  const sortedNodes = cluster.nodes.sort((a, b) => a.created_at - b.created_at);

  for (let i = 0; i < sortedNodes.length - 1; i++) {
    const current = sortedNodes[i];
    const next = sortedNodes[i + 1];

    // Only create `preceded` edge if:
    // 1. Nodes are close in time (< 5 minutes)
    // 2. Compatible node types (not all pairs make sense)
    const timeDeltaMs = next.created_at - current.created_at;

    if (timeDeltaMs < 5 * 60 * 1000 && shouldLinkWithPreceded(current, next)) {
      db.createEdge({
        from_node_id: current.id,
        to_node_id: next.id,
        edge_type: 'preceded',
        weight: 1.0 - (timeDeltaMs / (5 * 60 * 1000)), // Higher weight for closer times
        context: `temporal sequence in ${cluster.session_id}`
      });
      edgesCreated++;
    }
  }

  return edgesCreated;
}

function shouldLinkWithPreceded(nodeA: SynthesisNode, nodeB: SynthesisNode): boolean {
  // Rules for when `preceded` makes semantic sense
  const compatiblePairs = [
    ['decision', 'learning'],   // decision often leads to learning
    ['task', 'event'],          // task completion is an event
    ['event', 'learning'],      // events teach lessons
    ['decision', 'task'],       // decisions spawn tasks
    ['learning', 'decision'],   // learnings inform decisions
  ];

  return compatiblePairs.some(([a, b]) =>
    nodeA.node_type === a && nodeB.node_type === b
  );
}
```

### 3. Hierarchical Session Structure

#### Edge Type: `contains`
**Semantics**: A session summary node contains/encompasses all nodes created in that session

**Application**:
- Session summary → all nodes in session
- Enables hierarchical navigation: "show me everything from session X"
- Provides aggregation point for session-level context

```typescript
function createSessionHierarchyEdges(
  cluster: SessionCluster,
  db: SynthesisDatabase
): number {
  if (!cluster.session_summary_node_id) {
    // Create session summary node if missing
    const summaryNode = db.createNode({
      node_type: 'summary',
      one_liner: `Session ${cluster.session_id}`,
      summary: `Session containing ${cluster.nodes.length} synthesis nodes`,
      full_synthesis: generateSessionSummary(cluster),
      source_session_id: cluster.session_id,
      temporal_context: new Date(cluster.start_time).toISOString(),
      // ... other fields
    });
    cluster.session_summary_node_id = summaryNode.id;
  }

  let edgesCreated = 0;

  // Link session summary to all nodes in session
  for (const node of cluster.nodes) {
    if (node.id === cluster.session_summary_node_id) continue;

    db.createEdge({
      from_node_id: cluster.session_summary_node_id,
      to_node_id: node.id,
      edge_type: 'contains',
      weight: 1.0,
      context: `session hierarchy`
    });
    edgesCreated++;
  }

  return edgesCreated;
}
```

### 4. Cross-Session Temporal Relationships

#### Edge Type: `followed` (new edge type proposal)
**Semantics**: Session B followed session A chronologically

**Application**:
- Link consecutive sessions for the same agent/project
- Track evolution of work over time
- Enable "what came before/after" queries

```typescript
function createCrossSessionTemporalEdges(
  clusters: SessionCluster[],
  db: SynthesisDatabase
): number {
  // Group sessions by agent or project context
  const sessionSequences = groupSessionsByContext(clusters);

  let edgesCreated = 0;

  for (const sequence of sessionSequences) {
    const sortedSessions = sequence.sort((a, b) => a.start_time - b.start_time);

    for (let i = 0; i < sortedSessions.length - 1; i++) {
      const current = sortedSessions[i];
      const next = sortedSessions[i + 1];

      if (!current.session_summary_node_id || !next.session_summary_node_id) {
        continue;
      }

      // Link session summaries temporally
      db.createEdge({
        from_node_id: current.session_summary_node_id,
        to_node_id: next.session_summary_node_id,
        edge_type: 'followed', // NEW edge type
        weight: 1.0,
        context: `session sequence`
      });
      edgesCreated++;
    }
  }

  return edgesCreated;
}
```

### 5. Causal Relationships from Temporal Context

#### Edge Type: `caused`
**Semantics**: Node A directly led to/caused Node B to occur

**Application**:
- Decision → Event (decision caused an event to happen)
- Event → Learning (event caused a lesson to be learned)
- Task → Decision (completing task required a decision)

```typescript
function createCausalRelationships(
  cluster: SessionCluster,
  db: SynthesisDatabase
): number {
  let edgesCreated = 0;
  const sortedNodes = cluster.nodes.sort((a, b) => a.created_at - b.created_at);

  for (let i = 0; i < sortedNodes.length - 1; i++) {
    const potential_cause = sortedNodes[i];

    // Look forward in time window (next 10 minutes)
    for (let j = i + 1; j < sortedNodes.length; j++) {
      const potential_effect = sortedNodes[j];
      const timeDelta = potential_effect.created_at - potential_cause.created_at;

      if (timeDelta > 10 * 60 * 1000) break; // Stop if > 10 min gap

      if (isCausalPair(potential_cause, potential_effect)) {
        db.createEdge({
          from_node_id: potential_cause.id,
          to_node_id: potential_effect.id,
          edge_type: 'caused',
          weight: 1.0 - (timeDelta / (10 * 60 * 1000)),
          context: `causal inference from temporal proximity`
        });
        edgesCreated++;
      }
    }
  }

  return edgesCreated;
}

function isCausalPair(cause: SynthesisNode, effect: SynthesisNode): boolean {
  // Semantic rules for causal relationships
  const causalPatterns = [
    ['decision', 'event'],    // decisions cause events
    ['decision', 'task'],     // decisions spawn tasks
    ['event', 'learning'],    // events cause learnings
    ['task', 'learning'],     // tasks produce learnings
    ['event', 'decision'],    // events force decisions
  ];

  return causalPatterns.some(([c, e]) =>
    cause.node_type === c && effect.node_type === e
  );
}
```

### 6. Temporal Context Field Mining

The `temporal_context` field contains rich temporal information that can be parsed for relationship discovery:

```typescript
interface ParsedTemporalContext {
  timestamp?: Date;
  duration?: string;
  relative_time?: string; // "18 hours after", "during", "post-"
  reference_event?: string; // "PR #4 merge", "deployment"
}

function parseTemporalContext(context: string | null): ParsedTemporalContext | null {
  if (!context) return null;

  const patterns = {
    iso_timestamp: /(\d{4}-\d{2}-\d{2}T[\d:\.Z]+)/,
    date: /(\d{4}-\d{2}-\d{2})/,
    relative: /(\d+)\s+(hours?|minutes?|days?)\s+(after|before)/,
    during: /during\s+(.+)/,
    post: /post-(.+)/,
  };

  // Extract temporal markers
  // Use to create temporal edges between nodes with related temporal contexts

  return {
    timestamp: extractTimestamp(context, patterns),
    relative_time: extractRelativeTime(context, patterns),
    reference_event: extractReferenceEvent(context, patterns)
  };
}
```

## Proposed Edge Types & Semantics

### Existing Edge Types (keep)

1. **`relates_to`** - Generic relationship (use sparingly, only when other types don't fit)
2. **`caused`** - Direct causal relationship
3. **`preceded`** - Temporal ordering (A happened before B)
4. **`contains`** - Hierarchical containment (session → nodes)
5. **`contradicts`** - Conflicting information
6. **`informs`** - Provides context/background for

### Proposed New Edge Types

7. **`followed`** - Session/temporal sequence at session level
8. **`refined`** - Later node refines/improves earlier node
9. **`implements`** - Node implements a decision from another node
10. **`blocked_by`** - Task/decision blocked by an event/issue

## Implementation: Rebuild Relationships CLI Command

```typescript
// File: src/cli/rebuild-relationships.ts

import { getDatabase } from '../db.js';
import type { SynthesisNode, SynthesisEdge } from '../schema.js';

interface RebuildStats {
  nodes_analyzed: number;
  edges_created: number;
  edges_by_type: Record<string, number>;
  sessions_processed: number;
  orphan_nodes_before: number;
  orphan_nodes_after: number;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const verbose = args.includes('--verbose');

  console.log('Total Recall: Relationship Rebuilder (Temporal/Session Context)');
  console.log('================================================================\n');

  const db = getDatabase();

  // Phase 1: Analyze current state
  console.log('Phase 1: Analyzing current graph state...');
  const allNodes = db.queryNodes({ limit: 10000 });
  const orphansBefore = countOrphanNodes(db, allNodes);

  console.log(`  Total nodes: ${allNodes.length}`);
  console.log(`  Orphan nodes (no edges): ${orphansBefore}`);
  console.log('');

  // Phase 2: Build session clusters
  console.log('Phase 2: Building session clusters...');
  const clusters = buildSessionClusters(db);
  console.log(`  Found ${clusters.length} unique sessions`);
  console.log(`  Largest session: ${Math.max(...clusters.map(c => c.nodes.length))} nodes`);
  console.log('');

  const stats: RebuildStats = {
    nodes_analyzed: allNodes.length,
    edges_created: 0,
    edges_by_type: {},
    sessions_processed: clusters.length,
    orphan_nodes_before: orphansBefore,
    orphan_nodes_after: 0
  };

  // Phase 3: Create session hierarchy edges
  console.log('Phase 3: Creating session hierarchy (contains) edges...');
  for (const cluster of clusters) {
    const created = createSessionHierarchyEdges(cluster, db, dryRun);
    stats.edges_created += created;
    stats.edges_by_type['contains'] = (stats.edges_by_type['contains'] || 0) + created;
  }
  console.log(`  Created ${stats.edges_by_type['contains'] || 0} contains edges`);
  console.log('');

  // Phase 4: Create temporal precedence edges
  console.log('Phase 4: Creating temporal precedence (preceded) edges...');
  for (const cluster of clusters) {
    const created = createTemporalPrecedenceEdges(cluster, db, dryRun);
    stats.edges_created += created;
    stats.edges_by_type['preceded'] = (stats.edges_by_type['preceded'] || 0) + created;
  }
  console.log(`  Created ${stats.edges_by_type['preceded'] || 0} preceded edges`);
  console.log('');

  // Phase 5: Create causal relationships
  console.log('Phase 5: Creating causal (caused) edges...');
  for (const cluster of clusters) {
    const created = createCausalRelationships(cluster, db, dryRun);
    stats.edges_created += created;
    stats.edges_by_type['caused'] = (stats.edges_by_type['caused'] || 0) + created;
  }
  console.log(`  Created ${stats.edges_by_type['caused'] || 0} caused edges`);
  console.log('');

  // Phase 6: Create cross-session temporal edges
  console.log('Phase 6: Creating cross-session temporal (followed) edges...');
  const crossSessionEdges = createCrossSessionTemporalEdges(clusters, db, dryRun);
  stats.edges_created += crossSessionEdges;
  stats.edges_by_type['followed'] = crossSessionEdges;
  console.log(`  Created ${crossSessionEdges} followed edges`);
  console.log('');

  // Phase 7: Final analysis
  console.log('Phase 7: Analyzing results...');
  stats.orphan_nodes_after = countOrphanNodes(db, allNodes);

  console.log('\n=== REBUILD SUMMARY ===');
  console.log(`Nodes analyzed: ${stats.nodes_analyzed}`);
  console.log(`Sessions processed: ${stats.sessions_processed}`);
  console.log(`Total edges created: ${stats.edges_created}`);
  console.log(`Orphan nodes reduced: ${orphansBefore} → ${stats.orphan_nodes_after}`);
  console.log('');
  console.log('Edges by type:');
  for (const [type, count] of Object.entries(stats.edges_by_type)) {
    console.log(`  ${type}: ${count}`);
  }

  if (dryRun) {
    console.log('\n[DRY RUN] No changes were made. Run without --dry-run to apply.');
  }

  db.close();
}

function countOrphanNodes(db: SynthesisDatabase, nodes: SynthesisNode[]): number {
  let orphans = 0;
  for (const node of nodes) {
    const related = db.getRelatedNodes(node.id);
    if (related.length === 0) orphans++;
  }
  return orphans;
}

main().catch(e => {
  console.error('Error:', e);
  process.exit(1);
});
```

## Database Schema Extensions

Add new edge type to schema:

```typescript
// File: src/schema.ts

export type EdgeType =
  | 'relates_to'
  | 'caused'
  | 'preceded'
  | 'contains'
  | 'contradicts'
  | 'informs'
  | 'followed'      // NEW: Cross-session temporal sequence
  | 'refined'       // NEW: Later node refines earlier
  | 'implements'    // NEW: Implements a decision
  | 'blocked_by';   // NEW: Dependency blocking
```

## Cross-Session Relationship Discovery

### Challenge: Identifying Related Sessions

Sessions may be related even without explicit links. Use heuristics:

```typescript
function groupSessionsByContext(clusters: SessionCluster[]): SessionCluster[][] {
  // Group 1: Same telegram chat ID (from session_id pattern)
  const telegramSessions = clusters.filter(c =>
    c.session_id.startsWith('telegram-')
  );

  const groupedByTelegram = new Map<string, SessionCluster[]>();
  for (const cluster of telegramSessions) {
    const chatId = cluster.session_id.split('-')[1];
    if (!groupedByTelegram.has(chatId)) {
      groupedByTelegram.set(chatId, []);
    }
    groupedByTelegram.get(chatId)!.push(cluster);
  }

  // Group 2: Sessions with overlapping entities
  const groupedByEntity = groupSessionsByEntityOverlap(clusters);

  // Group 3: Sequential coordinator sessions
  const coordinatorSessions = clusters.filter(c =>
    c.session_id.startsWith('coordinator-')
  ).sort((a, b) => a.start_time - b.start_time);

  return [
    ...Array.from(groupedByTelegram.values()),
    ...groupedByEntity,
    coordinatorSessions.length > 0 ? [coordinatorSessions] : []
  ].filter(group => group.length > 0);
}
```

## Handling Session Boundaries

### Key Insight
Session boundaries are artificial breaks in continuous work. Relationships can cross sessions when:

1. **Time proximity**: Sessions < 24 hours apart on same project
2. **Entity continuity**: Sessions referencing same entities
3. **Explicit references**: Nodes mentioning previous sessions

```typescript
function findCrossSessionRelationships(
  clusters: SessionCluster[],
  db: SynthesisDatabase
): Array<{ from: string; to: string; edge_type: string; reason: string }> {

  const relationships: Array<{ from: string; to: string; edge_type: string; reason: string }> = [];

  // Sort clusters chronologically
  const sorted = clusters.sort((a, b) => a.start_time - b.start_time);

  for (let i = 0; i < sorted.length - 1; i++) {
    const current = sorted[i];
    const next = sorted[i + 1];

    const timeDelta = next.start_time - current.end_time;

    // If sessions are close in time (< 24 hours)
    if (timeDelta < 24 * 60 * 60 * 1000) {

      // Check for entity overlap
      const currentEntities = extractEntities(current.nodes);
      const nextEntities = extractEntities(next.nodes);
      const overlap = intersection(currentEntities, nextEntities);

      if (overlap.length > 0) {
        // Find relevant nodes in each session referencing shared entities
        for (const entity of overlap) {
          const nodesInCurrent = findNodesReferencingEntity(current.nodes, entity);
          const nodesInNext = findNodesReferencingEntity(next.nodes, entity);

          for (const nodeA of nodesInCurrent) {
            for (const nodeB of nodesInNext) {
              relationships.push({
                from: nodeA.id,
                to: nodeB.id,
                edge_type: 'relates_to',
                reason: `both reference entity: ${entity}`
              });
            }
          }
        }
      }
    }
  }

  return relationships;
}
```

## Risks and Mitigations

### Risk 1: Over-connection
**Problem**: Creating too many edges makes graph noisy

**Mitigation**:
- Use edge weights to indicate confidence (time proximity = higher weight)
- Apply strict type compatibility rules for `preceded` and `caused`
- Limit edges per node (max 20 `preceded` edges per node)
- Use dry-run mode to preview before applying

### Risk 2: Wrong Edge Types
**Problem**: Misclassifying relationships (e.g., `caused` vs `preceded`)

**Mitigation**:
- Conservative rules: only create `caused` for high-confidence pairs
- Fallback to `relates_to` when uncertain
- Store reasoning in edge `context` field for auditability
- Allow manual edge type correction via MCP tool

### Risk 3: Computational Cost
**Problem**: Processing 718 nodes × 718 nodes = 515,524 potential edges

**Mitigation**:
- Process within sessions first (bounded by session size)
- Use time windows to limit pairwise comparisons
- Only check cross-session for recent sessions (last 30 days)
- Batch processing with progress reporting

### Risk 4: Duplicate Edge Creation
**Problem**: Running rebuild multiple times creates duplicate edges

**Mitigation**:
- Check for existing edge before creating: `db.getEdge(from, to, type)`
- Add `skip-existing` flag to CLI
- Support `--clean` mode to remove all auto-generated edges before rebuild

```typescript
function createEdgeIfNotExists(
  db: SynthesisDatabase,
  from: string,
  to: string,
  type: EdgeType,
  weight: number,
  context: string
): boolean {
  // Check if edge already exists
  const existing = db.getEdgeBetween(from, to, type);
  if (existing) {
    return false; // Already exists
  }

  db.createEdge({
    from_node_id: from,
    to_node_id: to,
    edge_type: type,
    weight,
    context
  });

  return true;
}
```

### Risk 5: Temporal Ambiguity
**Problem**: Node creation time != event occurrence time

**Mitigation**:
- Parse `temporal_context` field for actual event time
- Use `first_seen` vs `created_at` distinction
- Default to `created_at` only when no other temporal info available

## Expected Outcomes

### Quantitative Improvements
- **Edges/node**: 0.47 → **2.5-3.5** (5-7x increase)
- **Orphan nodes**: ~360 → **< 50** (85% reduction)
- **Session connectivity**: 108 isolated session summaries → **0 isolated**
- **Edge type diversity**: 91% `relates_to` → **< 40%** (better semantic distribution)

### Qualitative Improvements
1. **Session navigation**: "Show me all nodes from session X" becomes trivial
2. **Temporal queries**: "What decisions led to this event?" becomes answerable
3. **Session sequences**: "What came before/after this work?" enables evolution tracking
4. **Causal understanding**: "Why did this decision happen?" reveals context chain

## Implementation Timeline

1. **Phase 1** (2 hours): Implement core session clustering and hierarchy
2. **Phase 2** (3 hours): Implement temporal precedence and causal edge creation
3. **Phase 3** (2 hours): Implement cross-session relationship discovery
4. **Phase 4** (2 hours): CLI command with dry-run, verbose, and safety features
5. **Phase 5** (2 hours): Testing, validation, and documentation

**Total: ~11 hours**

## CLI Usage Examples

```bash
# Dry run to preview changes
totalrecall rebuild-relationships --dry-run

# Verbose output showing all edge decisions
totalrecall rebuild-relationships --dry-run --verbose

# Apply changes
totalrecall rebuild-relationships

# Clean and rebuild (remove auto-generated edges first)
totalrecall rebuild-relationships --clean

# Only process recent sessions (last 30 days)
totalrecall rebuild-relationships --since=30d

# Export report without making changes
totalrecall rebuild-relationships --report-only > rebuild-report.txt
```

## Code Snippets: Key Database Methods

### Add getEdgeBetween method

```typescript
// File: src/db.ts

getEdgeBetween(
  fromNodeId: string,
  toNodeId: string,
  edgeType?: EdgeType
): SynthesisEdge | undefined {
  let query = 'SELECT * FROM synthesis_edges WHERE from_node_id = ? AND to_node_id = ?';
  const params: string[] = [fromNodeId, toNodeId];

  if (edgeType) {
    query += ' AND edge_type = ?';
    params.push(edgeType);
  }

  return this.db.prepare(query).get(...params) as SynthesisEdge | undefined;
}

queryAllSessions(): string[] {
  const result = this.db.prepare(`
    SELECT DISTINCT source_session_id
    FROM synthesis_nodes
    WHERE source_session_id IS NOT NULL
    ORDER BY source_session_id
  `).all() as Array<{ source_session_id: string }>;

  return result.map(r => r.source_session_id);
}

deleteEdgesByContext(contextPattern: string): number {
  const result = this.db.prepare(`
    DELETE FROM synthesis_edges
    WHERE context LIKE ?
  `).run(`%${contextPattern}%`);

  return result.changes;
}
```

## Validation and Testing

```typescript
// File: test/rebuild-relationships.test.ts

describe('Relationship Rebuilder', () => {
  it('should create session hierarchy for all sessions', async () => {
    const clusters = buildSessionClusters(db);

    for (const cluster of clusters) {
      createSessionHierarchyEdges(cluster, db);

      // Validate
      const summaryNode = db.getNode(cluster.session_summary_node_id!);
      const containedNodes = db.getRelatedNodes(summaryNode.id)
        .filter(r => r.edge.edge_type === 'contains');

      expect(containedNodes.length).toBe(cluster.nodes.length - 1);
    }
  });

  it('should create temporal precedence within time windows', () => {
    // Test implementation
  });

  it('should not create duplicate edges', () => {
    // Run rebuild twice, verify edge count stays same
  });
});
```

## Conclusion

This temporal/session-based approach provides a **systematic, data-driven** method to rebuild the synthesis graph's connectivity. By leveraging existing metadata (`source_session_id`, `created_at`, `temporal_context`), we can infer meaningful relationships without requiring LLM analysis or manual curation.

The proposed implementation is **conservative** (avoids over-connection), **auditable** (stores reasoning in edge context), and **safe** (dry-run mode, duplicate detection). Expected outcome: **5-7x increase in graph connectivity** with **better semantic precision** than current 91% `relates_to` edges.

---

**Next Steps**:
1. Review and approve edge type additions (`followed`, `refined`, `implements`, `blocked_by`)
2. Implement core session clustering logic
3. Implement relationship builders with dry-run testing
4. Run on production graph with dry-run to validate approach
5. Apply and measure improvements
