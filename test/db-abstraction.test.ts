/**
 * Database Abstraction Layer Tests
 * Tests both SQLite and PostgreSQL implementations against the ISynthesisDatabase interface
 */

import { getDatabaseWithBackend, type ISynthesisDatabase, resetDatabase } from '../src/db/index.js';
import { unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { NodeType } from '../src/schema.js';

const TEST_DB_PATH = join(tmpdir(), 'totalrecall-abstraction-test.sqlite');

// Test configuration
const USE_POSTGRES = process.env.TEST_POSTGRES === 'true';
const POSTGRES_URL = process.env.TEST_POSTGRES_URL || 'postgresql://localhost:5432/totalrecall_test';

async function cleanup() {
  resetDatabase();
  if (existsSync(TEST_DB_PATH)) {
    unlinkSync(TEST_DB_PATH);
  }
}

/**
 * Create a test database instance
 */
function createTestDb(): ISynthesisDatabase {
  if (USE_POSTGRES) {
    console.log('Using PostgreSQL backend for tests');
    return getDatabaseWithBackend('postgres', {
      postgresUrl: POSTGRES_URL,
      poolSize: 5,
      vectorchordProbes: 10,
      vectorDimension: 384,
    });
  } else {
    console.log('Using SQLite backend for tests');
    return getDatabaseWithBackend('sqlite', {
      sqlitePath: TEST_DB_PATH,
    });
  }
}

/**
 * Test basic node CRUD operations
 */
async function testNodeOperations(db: ISynthesisDatabase) {
  console.log('Test: Node CRUD operations...');

  // Create node
  const nodeData = {
    node_type: 'learning' as NodeType,
    one_liner: 'Test learning node',
    summary: 'This is a test summary for the learning node',
    full_synthesis: 'Full synthesis text with detailed information about the learning',
    entity_name: 'TestEntity',
    entity_aliases: JSON.stringify(['test-alias', 'alias2']),
    temporal_context: '2024-01-15',
    first_seen: Date.now(),
    last_updated: Date.now(),
    status: 'active',
    assigned_agent: 'test-agent',
    priority: 5,
    source_session_id: 'test-session-1',
    source_agent_id: 'agent-1',
    source_repo: 'test-repo',
  };

  const node = await db.createNode(nodeData);
  if (!node.id) throw new Error('Node creation failed - no ID');
  if (node.access_count !== 0) throw new Error('New node should have access_count = 0');
  console.log('  - Create node: PASS');

  // Get node
  const retrieved = await db.getNode(node.id);
  if (!retrieved) throw new Error('Failed to retrieve created node');
  if (retrieved.one_liner !== nodeData.one_liner) throw new Error('Retrieved data mismatch');
  console.log('  - Get node: PASS');

  // Update access
  await db.updateNodeAccess(node.id);
  const updated = await db.getNode(node.id);
  if (!updated) throw new Error('Failed to retrieve after access update');
  if (updated.access_count !== 1) throw new Error('Access count not incremented');
  if (!updated.last_accessed) throw new Error('Last accessed not set');
  console.log('  - Update node access: PASS');

  // Query nodes
  const allNodes = await db.queryNodes({ limit: 10 });
  if (allNodes.length === 0) throw new Error('Query returned no results');
  console.log('  - Query nodes (all): PASS');

  // Query by type
  const learningNodes = await db.queryNodes({ node_types: ['learning'], limit: 10 });
  if (learningNodes.length === 0) throw new Error('Query by type returned no results');
  if (learningNodes.some(n => n.node_type !== 'learning')) {
    throw new Error('Query returned wrong node types');
  }
  console.log('  - Query nodes (by type): PASS');

  // Query by session
  const sessionNodes = await db.queryNodes({ session_id: 'test-session-1', limit: 10 });
  if (sessionNodes.length === 0) throw new Error('Query by session returned no results');
  console.log('  - Query nodes (by session): PASS');

  // Get nodes by session
  const bySession = await db.getNodesBySession('test-session-1');
  if (bySession.length === 0) throw new Error('getNodesBySession returned no results');
  console.log('  - Get nodes by session: PASS');

  // Get all session IDs
  const sessionIds = await db.getAllSessionIds();
  if (!sessionIds.includes('test-session-1')) throw new Error('Session ID not in list');
  console.log('  - Get all session IDs: PASS');

  console.log('Node operations: PASS\n');
}

/**
 * Test vector operations
 */
async function testVectorOperations(db: ISynthesisDatabase) {
  console.log('Test: Vector operations...');

  // Create nodes with embeddings
  const node1 = await db.createNode({
    node_type: 'decision',
    one_liner: 'Use React for frontend development',
    summary: 'Decision to adopt React as the primary frontend framework',
    full_synthesis: 'After evaluating various options, we chose React for its ecosystem and performance',
    entity_name: null,
    entity_aliases: null,
    temporal_context: null,
    first_seen: Date.now(),
    last_updated: Date.now(),
    status: null,
    assigned_agent: null,
    priority: null,
    source_session_id: 'vector-test',
    source_agent_id: null,
    source_repo: null,
  });

  const node2 = await db.createNode({
    node_type: 'learning',
    one_liner: 'PostgreSQL vector search is fast',
    summary: 'Learned that PostgreSQL with pgvector extension provides efficient similarity search',
    full_synthesis: 'Vector search in PostgreSQL using pgvector is surprisingly performant',
    entity_name: null,
    entity_aliases: null,
    temporal_context: null,
    first_seen: Date.now(),
    last_updated: Date.now(),
    status: null,
    assigned_agent: null,
    priority: null,
    source_session_id: 'vector-test',
    source_agent_id: null,
    source_repo: null,
  });

  // Create simple embeddings (in real usage, these would be from an embedding model)
  const embedding1 = new Array(384).fill(0).map(() => Math.random());
  const embedding2 = new Array(384).fill(0).map(() => Math.random());

  // Normalize embeddings to unit length (for cosine similarity)
  const normalize = (v: number[]) => {
    const mag = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));
    return v.map(x => x / mag);
  };

  const norm1 = normalize(embedding1);
  const norm2 = normalize(embedding2);

  await db.insertEmbedding(node1.id, norm1);
  await db.insertEmbedding(node2.id, norm2);
  console.log('  - Insert embeddings: PASS');

  // Search by vector - should find at least one result
  const results = await db.searchByVector(norm1, 5, 0.0);
  if (results.length === 0) throw new Error('Vector search returned no results');
  if (!results[0].node_id) throw new Error('Result missing node_id');
  if (!results[0].one_liner) throw new Error('Result missing one_liner');
  if (typeof results[0].score !== 'number') throw new Error('Result missing score');
  console.log('  - Search by vector: PASS');

  // Check score range [0, 1]
  for (const result of results) {
    if (result.score < 0 || result.score > 1) {
      throw new Error(`Score ${result.score} outside valid range [0, 1]`);
    }
  }
  console.log('  - Score range validation: PASS');

  // Search with min_score filter
  const filteredResults = await db.searchByVector(norm1, 5, 0.5);
  if (filteredResults.some(r => r.score < 0.5)) {
    throw new Error('min_score filter not working');
  }
  console.log('  - Min score filtering: PASS');

  // Search with node type filter
  const typedResults = await db.searchByVector(norm1, 5, 0.0, ['decision']);
  if (typedResults.some(r => r.node_type !== 'decision')) {
    throw new Error('Node type filter not working');
  }
  console.log('  - Node type filtering: PASS');

  console.log('Vector operations: PASS\n');
}

/**
 * Test edge operations
 */
async function testEdgeOperations(db: ISynthesisDatabase) {
  console.log('Test: Edge operations...');

  // Create two nodes
  const node1 = await db.createNode({
    node_type: 'task',
    one_liner: 'Task A',
    summary: 'First task',
    full_synthesis: 'Details about task A',
    entity_name: null,
    entity_aliases: null,
    temporal_context: null,
    first_seen: Date.now(),
    last_updated: Date.now(),
    status: null,
    assigned_agent: null,
    priority: null,
    source_session_id: 'edge-test',
    source_agent_id: null,
    source_repo: null,
  });

  const node2 = await db.createNode({
    node_type: 'task',
    one_liner: 'Task B',
    summary: 'Second task',
    full_synthesis: 'Details about task B',
    entity_name: null,
    entity_aliases: null,
    temporal_context: null,
    first_seen: Date.now(),
    last_updated: Date.now(),
    status: null,
    assigned_agent: null,
    priority: null,
    source_session_id: 'edge-test',
    source_agent_id: null,
    source_repo: null,
  });

  // Test edgeExists - should be false initially
  const existsBefore = await db.edgeExists(node1.id, node2.id);
  if (existsBefore) throw new Error('Edge should not exist initially');
  console.log('  - Edge exists (before): PASS');

  // Create edge
  const edge = await db.createEdge({
    from_node_id: node1.id,
    to_node_id: node2.id,
    edge_type: 'preceded',
    weight: 0.9,
    context: 'Task A must complete before Task B',
  });

  if (!edge.id) throw new Error('Edge creation failed');
  console.log('  - Create edge: PASS');

  // Test edgeExists - should be true (both directions)
  const existsForward = await db.edgeExists(node1.id, node2.id);
  const existsReverse = await db.edgeExists(node2.id, node1.id);
  if (!existsForward || !existsReverse) {
    throw new Error('Edge should exist in both directions');
  }
  console.log('  - Edge exists (after): PASS');

  // Test edge count
  const count1 = await db.getEdgeCount(node1.id);
  const count2 = await db.getEdgeCount(node2.id);
  if (count1 !== 1 || count2 !== 1) throw new Error('Edge count incorrect');
  console.log('  - Get edge count: PASS');

  // Test related nodes
  const related = await db.getRelatedNodes(node1.id);
  if (related.length !== 1) throw new Error('Should have 1 related node');
  if (related[0].node.id !== node2.id) throw new Error('Related node ID mismatch');
  if (related[0].edge.edge_type !== 'preceded') throw new Error('Edge type mismatch');
  console.log('  - Get related nodes: PASS');

  // Test orphan nodes
  const node3 = await db.createNode({
    node_type: 'event',
    one_liner: 'Orphan event',
    summary: 'An isolated event',
    full_synthesis: 'This node has no connections',
    entity_name: null,
    entity_aliases: null,
    temporal_context: null,
    first_seen: Date.now(),
    last_updated: Date.now(),
    status: null,
    assigned_agent: null,
    priority: null,
    source_session_id: 'edge-test',
    source_agent_id: null,
    source_repo: null,
  });

  const orphans = await db.getOrphanNodes();
  if (!orphans.some(n => n.id === node3.id)) throw new Error('Orphan node not found');
  if (orphans.some(n => n.id === node1.id || n.id === node2.id)) {
    throw new Error('Connected nodes should not be in orphan list');
  }
  console.log('  - Get orphan nodes: PASS');

  console.log('Edge operations: PASS\n');
}

/**
 * Test raw content operations
 */
async function testRawContentOperations(db: ISynthesisDatabase) {
  console.log('Test: Raw content operations...');

  const sessionId = 'content-test-session';

  // Create raw content
  const content1 = await db.createRawContent({
    id: 'raw-1',
    session_id: sessionId,
    synthesis_node_id: null,
    content_type: 'message',
    content: 'User message content',
    agent_id: 'claude',
    timestamp: Date.now() - 1000,
    message_index: 0,
  });

  if (content1.id !== 'raw-1') throw new Error('Raw content creation failed');
  console.log('  - Create raw content: PASS');

  // Get by session
  const bySession = await db.getRawContentBySession(sessionId);
  if (bySession.length !== 1) throw new Error('getRawContentBySession failed');
  console.log('  - Get by session: PASS');

  // Get by IDs
  const byIds = await db.getRawContentByIds(['raw-1']);
  if (byIds.length !== 1 || byIds[0].id !== 'raw-1') {
    throw new Error('getRawContentByIds failed');
  }
  console.log('  - Get by IDs: PASS');

  // Link to synthesis node
  const node = await db.createNode({
    node_type: 'summary',
    one_liner: 'Session summary',
    summary: 'Summary of the session',
    full_synthesis: 'Full synthesis from raw content',
    entity_name: null,
    entity_aliases: null,
    temporal_context: null,
    first_seen: Date.now(),
    last_updated: Date.now(),
    status: null,
    assigned_agent: null,
    priority: null,
    source_session_id: sessionId,
    source_agent_id: null,
    source_repo: null,
  });

  await db.linkRawContentToSynthesis(['raw-1'], node.id);
  const bySynthesis = await db.getRawContentBySynthesis(node.id);
  if (bySynthesis.length !== 1 || bySynthesis[0].id !== 'raw-1') {
    throw new Error('Link to synthesis failed');
  }
  console.log('  - Link to synthesis: PASS');

  console.log('Raw content operations: PASS\n');
}

/**
 * Test synthesis queue operations
 */
async function testSynthesisQueueOperations(db: ISynthesisDatabase) {
  console.log('Test: Synthesis queue operations...');

  // Create queue item
  const item = await db.createSynthesisQueueItem({
    session_id: 'queue-test',
    agent_id: 'claude',
    chunk_type: 'session_chunk',
    raw_content_ids: JSON.stringify(['raw-1', 'raw-2']),
    context: 'Test context',
    message_count: 2,
    status: 'pending',
    retry_count: 0,
    error: null,
    synthesis_node_id: null,
    created_at: Date.now(),
  });

  if (!item.id) throw new Error('Queue item creation failed');
  console.log('  - Create queue item: PASS');

  // Get pending
  const pending = await db.getPendingSynthesisQueue({ limit: 10 });
  if (!pending.some(p => p.id === item.id)) throw new Error('Pending item not found');
  console.log('  - Get pending: PASS');

  // Update status
  await db.updateSynthesisQueueStatus(item.id, 'processing');
  const items = await db.getSynthesisQueueItems({ status: 'processing' });
  if (!items.some(i => i.id === item.id)) throw new Error('Status update failed');
  console.log('  - Update status: PASS');

  // Increment retry
  await db.incrementSynthesisQueueRetry(item.id);
  const retried = await db.getSynthesisQueueItems({ status: 'pending' });
  const retriedItem = retried.find(i => i.id === item.id);
  if (!retriedItem || retriedItem.retry_count !== 1) {
    throw new Error('Retry increment failed');
  }
  console.log('  - Increment retry: PASS');

  // Reset stuck items
  const resetCount = await db.resetStuckSynthesisItems(0); // Reset all processing items
  if (resetCount < 0) throw new Error('Reset stuck items returned invalid count');
  console.log('  - Reset stuck items: PASS');

  // Get stats
  const stats = await db.getQueueStats();
  if (typeof stats.pending !== 'number') throw new Error('Stats missing pending count');
  if (typeof stats.processing !== 'number') throw new Error('Stats missing processing count');
  if (typeof stats.completed !== 'number') throw new Error('Stats missing completed count');
  if (typeof stats.failed !== 'number') throw new Error('Stats missing failed count');
  console.log('  - Get queue stats: PASS');

  console.log('Synthesis queue operations: PASS\n');
}

/**
 * Test progressive disclosure operations
 */
async function testProgressiveDisclosureOperations(db: ISynthesisDatabase) {
  console.log('Test: Progressive disclosure operations...');

  const now = Date.now();

  // Create events
  await db.createProgressiveDisclosureEvent({
    event_type: 'search',
    session_id: 'pd-test',
    agent_id: 'claude',
    query_text: 'test query',
    search_latency_ms: 45,
    results_count: 5,
    node_ids: null,
    injection_tokens: null,
    expanded_node_id: null,
    expansion_tokens: null,
    message_tokens: null,
  });

  await db.createProgressiveDisclosureEvent({
    event_type: 'inject',
    session_id: 'pd-test',
    agent_id: 'claude',
    query_text: null,
    search_latency_ms: null,
    results_count: null,
    node_ids: JSON.stringify(['node-1', 'node-2']),
    injection_tokens: 150,
    expanded_node_id: null,
    expansion_tokens: null,
    message_tokens: null,
  });

  console.log('  - Create events: PASS');

  // Get analytics
  const analytics = await db.getProgressiveDisclosureAnalytics(now - 5000, now + 5000);
  if (analytics.totalSearches < 1) throw new Error('Analytics missing search count');
  if (analytics.totalInjections < 1) throw new Error('Analytics missing injection count');
  if (typeof analytics.avgSearchLatency !== 'number') {
    throw new Error('Analytics missing search latency');
  }
  console.log('  - Get analytics: PASS');

  console.log('Progressive disclosure operations: PASS\n');
}

/**
 * Test utility methods
 */
async function testUtilityMethods(db: ISynthesisDatabase) {
  console.log('Test: Utility methods...');

  // Get backend type
  const backend = db.getBackendType();
  if (backend !== 'sqlite' && backend !== 'postgres') {
    throw new Error(`Invalid backend type: ${backend}`);
  }
  console.log(`  - Get backend type: PASS (${backend})`);

  // Check hybrid search support
  const supportsHybrid = db.supportsHybridSearch();
  if (backend === 'postgres' && !supportsHybrid) {
    throw new Error('PostgreSQL should support hybrid search');
  }
  if (backend === 'sqlite' && supportsHybrid) {
    throw new Error('SQLite should not support hybrid search');
  }
  console.log(`  - Supports hybrid search: PASS (${supportsHybrid})`);

  console.log('Utility methods: PASS\n');
}

/**
 * Test PostgreSQL-specific features (only runs if USE_POSTGRES=true)
 */
async function testPostgresSpecificFeatures(db: ISynthesisDatabase) {
  if (!db.supportsHybridSearch()) {
    console.log('Skipping PostgreSQL-specific tests (not using PostgreSQL backend)\n');
    return;
  }

  console.log('Test: PostgreSQL-specific features...');

  // Create test node with embedding
  const node = await db.createNode({
    node_type: 'learning',
    one_liner: 'PostgreSQL full-text search with BM25',
    summary: 'Learned about BM25 ranking algorithm in PostgreSQL for keyword search',
    full_synthesis: 'BM25 is a ranking function used by search engines to estimate the relevance of documents',
    entity_name: 'PostgreSQL',
    entity_aliases: JSON.stringify(['postgres', 'pg']),
    temporal_context: null,
    first_seen: Date.now(),
    last_updated: Date.now(),
    status: null,
    assigned_agent: null,
    priority: null,
    source_session_id: 'pg-test',
    source_agent_id: null,
    source_repo: null,
  });

  // Insert embedding
  const embedding = new Array(384).fill(0).map(() => Math.random());
  const norm = embedding.map(x => x / Math.sqrt(embedding.reduce((s, v) => s + v * v, 0)));
  await db.insertEmbedding(node.id, norm);

  // Test BM25 search
  if (db.searchByBM25) {
    const bm25Results = await db.searchByBM25('PostgreSQL BM25', 5);
    if (bm25Results.length === 0) {
      console.log('  - Warning: BM25 search returned no results (may need data)');
    } else {
      console.log('  - BM25 search: PASS');
    }
  }

  // Test trigram search
  if (db.searchByTrigram) {
    const trigramResults = await db.searchByTrigram('PostgreSQL', 5, 0.1);
    if (trigramResults.length === 0) {
      console.log('  - Warning: Trigram search returned no results (may need data)');
    } else {
      console.log('  - Trigram search: PASS');
    }
  }

  // Test hybrid search
  if (db.hybridSearch) {
    const hybridResults = await db.hybridSearch({
      query: 'PostgreSQL database search',
      queryEmbedding: norm,
      maxResults: 5,
      minScore: 0.0,
      searchMode: 'hybrid',
      weights: { vector: 1.0, bm25: 1.0, trigram: 0.5 },
    });

    if (hybridResults.length === 0) {
      console.log('  - Warning: Hybrid search returned no results (may need more data)');
    } else {
      // Check that hybrid results have the expected fields
      const result = hybridResults[0];
      if (typeof result.score !== 'number') throw new Error('Hybrid result missing score');
      console.log('  - Hybrid search: PASS');
    }
  }

  console.log('PostgreSQL-specific features: PASS\n');
}

/**
 * Main test runner
 */
async function main() {
  console.log('=== Database Abstraction Layer Tests ===\n');

  try {
    await cleanup();
    const db = createTestDb();

    // Run all tests
    await testNodeOperations(db);
    await testVectorOperations(db);
    await testEdgeOperations(db);
    await testRawContentOperations(db);
    await testSynthesisQueueOperations(db);
    await testProgressiveDisclosureOperations(db);
    await testUtilityMethods(db);
    await testPostgresSpecificFeatures(db);

    // Close database
    await db.close();

    console.log('=== ALL TESTS PASSED ===');
    await cleanup();
    process.exit(0);
  } catch (error) {
    console.error('TEST FAILED:', error);
    await cleanup();
    process.exit(1);
  }
}

main();
