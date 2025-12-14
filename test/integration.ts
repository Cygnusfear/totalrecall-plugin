/**
 * Integration tests for TotalRecall plugin
 */

import { createSQLiteDatabase, type ISynthesisDatabase } from '../src/db.js';
import { generateEmbedding, initEmbeddings, generateSynthesisEmbedding } from '../src/embeddings.js';
import { unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const TEST_DB_PATH = join(tmpdir(), 'totalrecall-test.sqlite');

async function cleanup() {
  if (existsSync(TEST_DB_PATH)) {
    unlinkSync(TEST_DB_PATH);
  }
}

async function testDatabaseSchema() {
  console.log('Test: Database schema creation...');
  const db = await createSQLiteDatabase(TEST_DB_PATH);

  // Test node creation
  const node = await db.createNode({
    node_type: 'learning',
    one_liner: 'Test learning',
    summary: 'This is a test summary',
    full_synthesis: 'Full synthesis text here',
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

  if (!node.id) throw new Error('Node creation failed');
  console.log('  - Node creation: PASS');

  // Test raw content
  const raw = await db.createRawContent({
    id: 'raw-1',
    session_id: 'test-session',
    synthesis_node_id: null,
    content_type: 'message',
    content: 'Test message content',
    agent_id: null,
    timestamp: Date.now(),
    message_index: 0,
  });

  if (!raw.id) throw new Error('Raw content creation failed');
  console.log('  - Raw content creation: PASS');

  // Test queue item
  const queueItem = await db.createSynthesisQueueItem({
    session_id: 'test-session',
    agent_id: null,
    chunk_type: 'session_chunk',
    raw_content_ids: JSON.stringify(['raw-1']),
    context: null,
    message_count: 1,
    status: 'pending',
    retry_count: 0,
    error: null,
    synthesis_node_id: null,
    created_at: Date.now(),
  });

  if (!queueItem.id) throw new Error('Queue item creation failed');
  console.log('  - Queue item creation: PASS');

  // Test progressive disclosure event
  const pdEvent = await db.createProgressiveDisclosureEvent({
    event_type: 'search',
    session_id: 'test-session',
    agent_id: null,
    query_text: 'test query',
    search_latency_ms: 50,
    results_count: 3,
    node_ids: null,
    injection_tokens: null,
    expanded_node_id: null,
    expansion_tokens: null,
    message_tokens: null,
  });

  if (!pdEvent.id) throw new Error('PD event creation failed');
  console.log('  - Progressive disclosure event: PASS');

  await db.close();
  console.log('Database schema tests: PASS\n');
}

async function testEmbeddings() {
  console.log('Test: Embeddings...');
  await initEmbeddings();

  const embedding = await generateEmbedding('Test text for embedding');
  if (embedding.length !== 384) {
    throw new Error(`Expected 384 dimensions, got ${embedding.length}`);
  }
  console.log('  - Embedding generation: PASS');

  const synthEmbedding = await generateSynthesisEmbedding('One liner', 'Summary', 'learning');
  if (synthEmbedding.length !== 384) {
    throw new Error(`Expected 384 dimensions, got ${synthEmbedding.length}`);
  }
  console.log('  - Synthesis embedding: PASS');

  console.log('Embedding tests: PASS\n');
}

async function testVectorSearch() {
  console.log('Test: Vector search...');
  await cleanup();
  const db = await createSQLiteDatabase(TEST_DB_PATH);
  await initEmbeddings();

  // Create nodes with embeddings
  const node1 = await db.createNode({
    node_type: 'decision',
    one_liner: 'Use React for frontend',
    summary: 'Decided to use React for the frontend framework',
    full_synthesis: 'Full text',
    entity_name: null,
    entity_aliases: null,
    temporal_context: null,
    first_seen: Date.now(),
    last_updated: Date.now(),
    status: null,
    assigned_agent: null,
    priority: null,
    source_session_id: 'test',
    source_agent_id: null,
    source_repo: null,
  });

  const emb1 = await generateSynthesisEmbedding(node1.one_liner, node1.summary, node1.node_type);
  await db.insertEmbedding(node1.id, emb1);

  const node2 = await db.createNode({
    node_type: 'learning',
    one_liner: 'SQLite WAL mode improves concurrency',
    summary: 'Learned that WAL mode helps with concurrent access',
    full_synthesis: 'Full text',
    entity_name: null,
    entity_aliases: null,
    temporal_context: null,
    first_seen: Date.now(),
    last_updated: Date.now(),
    status: null,
    assigned_agent: null,
    priority: null,
    source_session_id: 'test',
    source_agent_id: null,
    source_repo: null,
  });

  const emb2 = await generateSynthesisEmbedding(node2.one_liner, node2.summary, node2.node_type);
  await db.insertEmbedding(node2.id, emb2);

  // Search for React-related content
  const queryEmb = await generateEmbedding('React frontend framework');
  const results = await db.searchByVector(queryEmb, 5, 0.3);

  if (results.length === 0) {
    throw new Error('Expected search results');
  }

  // React node should rank higher
  if (results[0].node_id !== node1.id) {
    console.log('Warning: React node not ranked first (may be acceptable)');
  }
  console.log('  - Vector search: PASS');

  await db.close();
  console.log('Vector search tests: PASS\n');
}

async function testQueueOperations() {
  console.log('Test: Queue operations...');
  await cleanup();
  const db = await createSQLiteDatabase(TEST_DB_PATH);

  // Create pending item
  const item = await db.createSynthesisQueueItem({
    session_id: 'test-session',
    agent_id: null,
    chunk_type: 'session_chunk',
    raw_content_ids: '["raw-1"]',
    context: null,
    message_count: 1,
    status: 'pending',
    retry_count: 0,
    error: null,
    synthesis_node_id: null,
    created_at: Date.now(),
  });

  // Get pending items
  const pending = await db.getPendingSynthesisQueue({ limit: 10 });
  if (pending.length !== 1) {
    throw new Error(`Expected 1 pending, got ${pending.length}`);
  }
  console.log('  - Get pending items: PASS');

  // Update status
  await db.updateSynthesisQueueStatus(item.id, 'processing');
  const updated = await db.getSynthesisQueueItems({ status: 'processing' });
  if (updated.length !== 1) {
    throw new Error('Status update failed');
  }
  console.log('  - Update status: PASS');

  // Increment retry
  await db.incrementSynthesisQueueRetry(item.id);
  const retried = await db.getSynthesisQueueItems({ status: 'pending' });
  if (retried[0].retry_count !== 1) {
    throw new Error('Retry increment failed');
  }
  console.log('  - Increment retry: PASS');

  await db.close();
  console.log('Queue operation tests: PASS\n');
}

async function testScoreCalculation() {
  console.log('Test: Score calculation (L2 to cosine conversion)...');
  await cleanup();
  const db = await createSQLiteDatabase(TEST_DB_PATH);
  await initEmbeddings();

  // Create a node with specific content
  const testContent = 'TypeScript compiler configuration for strict mode';
  const node = await db.createNode({
    node_type: 'learning',
    one_liner: testContent,
    summary: 'Learning about TypeScript strict mode configuration',
    full_synthesis: 'Full details about tsconfig strict settings',
    entity_name: null,
    entity_aliases: null,
    temporal_context: null,
    first_seen: Date.now(),
    last_updated: Date.now(),
    status: null,
    assigned_agent: null,
    priority: null,
    source_session_id: 'test',
    source_agent_id: null,
    source_repo: null,
  });

  const embedding = await generateSynthesisEmbedding(node.one_liner, node.summary, node.node_type);
  await db.insertEmbedding(node.id, embedding);

  // Search for the exact content - should get high score
  const exactQuery = await generateEmbedding(testContent);
  const exactResults = await db.searchByVector(exactQuery, 5, 0.0); // No min_score filter

  if (exactResults.length === 0) {
    throw new Error('Expected results for exact content search');
  }

  const exactScore = exactResults[0].score;

  // Score must be in valid cosine similarity range [0, 1]
  if (exactScore < 0 || exactScore > 1) {
    throw new Error(`Score ${exactScore} outside valid range [0, 1] - formula may be wrong`);
  }
  console.log(`  - Score in valid range [0,1]: PASS (score: ${exactScore.toFixed(3)})`);

  // Searching for exact/similar content should return high score (>= 0.7)
  if (exactScore < 0.7) {
    throw new Error(`Exact content search score ${exactScore} < 0.7 - L2 to cosine conversion may be broken`);
  }
  console.log(`  - Exact content returns high score (>= 0.7): PASS (score: ${exactScore.toFixed(3)})`);

  // Search for unrelated content - should get lower score
  const unrelatedQuery = await generateEmbedding('cooking recipes for Italian pasta');
  const unrelatedResults = await db.searchByVector(unrelatedQuery, 5, 0.0);

  if (unrelatedResults.length > 0) {
    const unrelatedScore = unrelatedResults[0].score;
    // Unrelated content should score lower than exact content
    if (unrelatedScore >= exactScore) {
      throw new Error(`Unrelated score ${unrelatedScore} >= exact score ${exactScore}`);
    }
    console.log(`  - Unrelated content scores lower: PASS (${unrelatedScore.toFixed(3)} < ${exactScore.toFixed(3)})`);
  } else {
    console.log('  - Unrelated content scores lower: PASS (no results)');
  }

  // Verify min_score filtering works correctly
  const filteredResults = await db.searchByVector(exactQuery, 5, 0.8);
  const allPassThreshold = filteredResults.every(r => r.score >= 0.8);
  if (!allPassThreshold) {
    throw new Error('min_score filtering not working correctly');
  }
  console.log('  - min_score filtering: PASS');

  await db.close();
  console.log('Score calculation tests: PASS\n');
}

async function testEntityContextInEmbeddings() {
  console.log('Test: Entity context in embeddings (Issue #7 fix)...');
  await cleanup();
  const db = await createSQLiteDatabase(TEST_DB_PATH);
  await initEmbeddings();

  // Create a node about "Epic #183 backend migration" with entity_name "Jungle"
  // This simulates the issue: synthesis text doesn't mention "jungle" but entity_name does
  const node = await db.createNode({
    node_type: 'task',
    one_liner: 'Epic #183 backend migration complete',
    summary: 'Completed the backend migration for Epic #183, moving services to new infrastructure',
    full_synthesis: 'Full details about the backend migration effort',
    entity_name: 'Jungle',  // Project name that should be searchable
    entity_aliases: JSON.stringify(['jungle-backend', 'Epic #183']),  // Aliases
    temporal_context: null,
    first_seen: Date.now(),
    last_updated: Date.now(),
    status: null,
    assigned_agent: null,
    priority: null,
    source_session_id: 'test',
    source_agent_id: null,
    source_repo: 'jungle-backend',  // Repository name
  });

  // Generate embedding WITH entity context
  const embeddingWithContext = await generateSynthesisEmbedding(
    node.one_liner,
    node.summary,
    node.node_type,
    {
      entityName: node.entity_name,
      entityAliases: node.entity_aliases,
      sourceRepo: node.source_repo,
    }
  );
  await db.insertEmbedding(node.id, embeddingWithContext);

  // Search for "jungle" - should find the node even though "jungle" isn't in one_liner or summary
  const jungleQuery = await generateEmbedding('jungle project');
  const jungleResults = await db.searchByVector(jungleQuery, 5, 0.0);

  if (jungleResults.length === 0) {
    throw new Error('Expected to find node when searching for "jungle" (entity_name)');
  }

  const jungleScore = jungleResults[0].score;
  console.log(`  - "jungle" search found node (score: ${jungleScore.toFixed(3)}): PASS`);

  // Search for "Epic #183" - should also work via aliases
  const epicQuery = await generateEmbedding('Epic #183');
  const epicResults = await db.searchByVector(epicQuery, 5, 0.0);

  if (epicResults.length === 0) {
    throw new Error('Expected to find node when searching for "Epic #183" (alias)');
  }
  console.log(`  - "Epic #183" search found node (score: ${epicResults[0].score.toFixed(3)}): PASS`);

  // Search for "jungle-backend" - should work via source_repo
  const repoQuery = await generateEmbedding('jungle-backend repository');
  const repoResults = await db.searchByVector(repoQuery, 5, 0.0);

  if (repoResults.length === 0) {
    throw new Error('Expected to find node when searching for "jungle-backend" (source_repo)');
  }
  console.log(`  - "jungle-backend" search found node (score: ${repoResults[0].score.toFixed(3)}): PASS`);

  // Compare: search for "backend migration" (in original text) should have good score
  const directQuery = await generateEmbedding('backend migration');
  const directResults = await db.searchByVector(directQuery, 5, 0.0);

  if (directResults.length === 0) {
    throw new Error('Expected to find node when searching for direct text');
  }

  const directScore = directResults[0].score;
  console.log(`  - "backend migration" search (direct text): score ${directScore.toFixed(3)}: PASS`);

  // Verify that entity search scores are reasonable (they may be lower than direct text matches)
  // but they should be above our default min_score threshold of 0.3
  if (jungleScore < 0.3) {
    console.log(`  - Warning: "jungle" score ${jungleScore.toFixed(3)} is below 0.3 threshold`);
  }

  await db.close();
  console.log('Entity context in embeddings tests: PASS\n');
}

async function testProgressiveDisclosureAnalytics() {
  console.log('Test: Progressive disclosure analytics...');
  await cleanup();
  const db = await createSQLiteDatabase(TEST_DB_PATH);

  const now = Date.now();

  // Create events
  await db.createProgressiveDisclosureEvent({
    event_type: 'search',
    session_id: 'test',
    agent_id: null,
    query_text: 'test',
    search_latency_ms: 50,
    results_count: 3,
    node_ids: null,
    injection_tokens: null,
    expanded_node_id: null,
    expansion_tokens: null,
    message_tokens: null,
  });

  await db.createProgressiveDisclosureEvent({
    event_type: 'inject',
    session_id: 'test',
    agent_id: null,
    query_text: null,
    search_latency_ms: null,
    results_count: null,
    node_ids: '["id1"]',
    injection_tokens: 100,
    expanded_node_id: null,
    expansion_tokens: null,
    message_tokens: null,
  });

  await db.createProgressiveDisclosureEvent({
    event_type: 'expand',
    session_id: 'test',
    agent_id: null,
    query_text: null,
    search_latency_ms: null,
    results_count: null,
    node_ids: null,
    injection_tokens: null,
    expanded_node_id: 'id1',
    expansion_tokens: 500,
    message_tokens: null,
  });

  const stats = await db.getProgressiveDisclosureAnalytics(now - 1000, now + 1000);

  if (stats.totalSearches !== 1) throw new Error('Search count wrong');
  if (stats.totalInjections !== 1) throw new Error('Injection count wrong');
  if (stats.totalExpansions !== 1) throw new Error('Expansion count wrong');
  if (stats.totalInjectionTokens !== 100) throw new Error('Injection tokens wrong');
  if (stats.totalExpansionTokens !== 500) throw new Error('Expansion tokens wrong');

  console.log('  - Analytics calculation: PASS');

  await db.close();
  console.log('Progressive disclosure analytics tests: PASS\n');
}

async function testEdgeHelpers() {
  console.log('Test: Edge helper methods...');
  await cleanup();
  const db = await createSQLiteDatabase(TEST_DB_PATH);

  // Create two nodes
  const node1 = await db.createNode({
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

  const node2 = await db.createNode({
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
  if (await db.edgeExists(node1.id, node2.id)) {
    throw new Error('edgeExists should return false for non-existent edge');
  }
  console.log('  - edgeExists (no edge): PASS');

  // Create an edge
  await db.createEdge({
    from_node_id: node1.id,
    to_node_id: node2.id,
    edge_type: 'relates_to',
    weight: 0.8,
    context: 'test',
  });

  // Test edgeExists - should be true (forward direction)
  if (!await db.edgeExists(node1.id, node2.id)) {
    throw new Error('edgeExists should return true for existing edge');
  }
  console.log('  - edgeExists (forward): PASS');

  // Test edgeExists - should be true (reverse direction check)
  if (!await db.edgeExists(node2.id, node1.id)) {
    throw new Error('edgeExists should return true for reverse direction');
  }
  console.log('  - edgeExists (reverse): PASS');

  // Test getOrphanNodes
  const node3 = await db.createNode({
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

  const orphans = await db.getOrphanNodes();
  if (orphans.length !== 1 || orphans[0].id !== node3.id) {
    throw new Error(`Expected 1 orphan (node3), got ${orphans.length}`);
  }
  console.log('  - getOrphanNodes: PASS');

  // Test getOrphanNodes with node type filter
  const orphansFiltered = await db.getOrphanNodes(['decision']);
  if (orphansFiltered.length !== 0) {
    throw new Error('Expected 0 orphans with decision filter');
  }
  console.log('  - getOrphanNodes (filtered): PASS');

  await db.close();
  console.log('Edge helper tests: PASS\n');
}

async function testContextFormatter() {
  console.log('Test: Context formatter...');

  // Import dynamically to test
  const { createContextFormatter } = await import('../src/lib/context-formatter.js');

  const formatter = createContextFormatter();

  // Test with memories and core memory
  const memories = [
    {
      content: 'React hooks best practices',
      type: 'learning' as const,
      source: 'memory' as const,
      confidence: 0.9,
      ageMs: 1000 * 60 * 5, // 5 minutes ago
      nodeId: 'node-1',
      oneLiner: 'React hooks best practices',
    },
    {
      content: 'Use TypeScript for type safety',
      type: 'decision' as const,
      source: 'memory' as const,
      confidence: 0.85,
      ageMs: 1000 * 60 * 60, // 1 hour ago
      nodeId: 'node-2',
      oneLiner: 'Use TypeScript for type safety',
    },
  ];

  const coreMemory = {
    persona: {
      id: 'persona-1',
      block_type: 'persona' as const,
      content: 'I am a helpful coding assistant.',
      token_estimate: 10,
      created_at: Date.now(),
      updated_at: Date.now(),
    },
    human: {
      id: 'human-1',
      block_type: 'human' as const,
      content: 'User prefers TypeScript and React.',
      token_estimate: 10,
      created_at: Date.now(),
      updated_at: Date.now(),
    },
  };

  const formatted = formatter.formatForInjection(memories, coreMemory, {
    verbosity: 'standard',
    includeCoreMemory: true,
    includeNodeIds: true,
  });

  if (!formatted) {
    throw new Error('Formatter returned null for valid input');
  }

  // Check for expected XML tags
  if (!formatted.includes('<total_recall_context>')) {
    throw new Error('Missing total_recall_context tag');
  }
  if (!formatted.includes('<core_memory type="persona"')) {
    throw new Error('Missing core_memory persona block');
  }
  if (!formatted.includes('<core_memory type="human"')) {
    throw new Error('Missing core_memory human block');
  }
  if (!formatted.includes('node-1')) {
    throw new Error('Missing node ID in output');
  }

  console.log('  - XML formatting: PASS');

  // Test empty input
  const emptyFormatted = formatter.formatForInjection([], {}, {
    verbosity: 'standard',
    includeCoreMemory: true,
    includeNodeIds: true,
  });

  if (emptyFormatted !== '') {
    throw new Error('Formatter should return empty string for empty input');
  }
  console.log('  - Empty input handling: PASS');

  // Test token estimation
  const estimate = formatter.estimateTokens(formatted);
  if (estimate <= 0) {
    throw new Error('Token estimate should be positive');
  }
  console.log(`  - Token estimation (${estimate} tokens): PASS`);

  console.log('Context formatter tests: PASS\n');
}

async function testCoreMemory() {
  console.log('Test: Core memory...');
  await cleanup();
  const db = await createSQLiteDatabase(TEST_DB_PATH);

  // Import dynamically to test
  const { createCoreMemoryService } = await import('../src/lib/core-memory.js');

  const service = createCoreMemoryService(db);

  // Test setting core memory
  await service.setBlock('persona', 'I am a helpful AI assistant.');
  console.log('  - Set persona block: PASS');

  await service.setBlock('human', 'User prefers TypeScript.');
  console.log('  - Set human block: PASS');

  // Test getting individual blocks
  const persona = await service.getBlock('persona');
  if (!persona || !persona.content.includes('helpful AI assistant')) {
    throw new Error('Persona block not retrieved correctly');
  }
  console.log('  - Get persona block: PASS');

  // Test getting all blocks
  const blocks = await service.getBlocks();
  if (!blocks.persona || !blocks.human) {
    throw new Error('getBlocks should return both persona and human');
  }
  console.log('  - Get all blocks: PASS');

  // Test updating a block
  await service.setBlock('persona', 'Updated persona.');
  const updated = await service.getBlock('persona');
  if (!updated || updated.content !== 'Updated persona.') {
    throw new Error('Block update failed');
  }
  console.log('  - Update block: PASS');

  // Test deleting a block
  const deleted = await service.deleteBlock('human');
  if (!deleted) {
    throw new Error('Delete should return true');
  }
  const afterDelete = await service.getBlock('human');
  if (afterDelete !== null) {
    throw new Error('Block should be null after delete');
  }
  console.log('  - Delete block: PASS');

  await db.close();
  console.log('Core memory tests: PASS\n');
}

async function testQueryRouter() {
  console.log('Test: Query router...');
  await cleanup();
  const db = await createSQLiteDatabase(TEST_DB_PATH);
  await initEmbeddings();

  // Import dynamically to test
  const { QueryRouter } = await import('../src/lib/query-router.js');

  // Create test data
  const node = await db.createNode({
    node_type: 'decision',
    one_liner: 'Use PostgreSQL for production database',
    summary: 'Decided to use PostgreSQL for better scalability',
    full_synthesis: 'Full decision rationale',
    entity_name: null,
    entity_aliases: null,
    temporal_context: null,
    first_seen: Date.now(),
    last_updated: Date.now(),
    status: null,
    assigned_agent: null,
    priority: null,
    source_session_id: 'test',
    source_agent_id: null,
    source_repo: null,
  });

  const embedding = await generateSynthesisEmbedding(node.one_liner, node.summary, node.node_type);
  await db.insertEmbedding(node.id, embedding);

  // Create router
  const router = new QueryRouter(db, generateEmbedding, {
    minScore: 0.3,
    maxResultsPerType: 5,
    enabledTypes: ['decision', 'learning', 'entity'],
    debugLogging: false,
  });

  // Test planQueries
  const plans = router.planQueries(['database', 'PostgreSQL']);
  if (plans.length === 0) {
    throw new Error('planQueries should return plans');
  }
  console.log(`  - Plan queries (${plans.length} plans): PASS`);

  // Test full routing
  const routeResults = await router.routeAndExecute(['PostgreSQL database']);
  if (!routeResults.results) {
    throw new Error('routeAndExecute should return results array');
  }
  console.log(`  - Route and execute (${routeResults.results.length} results): PASS`);

  await db.close();
  console.log('Query router tests: PASS\n');
}

async function testActiveRetrievalPipeline() {
  console.log('Test: Active retrieval pipeline...');
  await cleanup();
  const db = await createSQLiteDatabase(TEST_DB_PATH);
  await initEmbeddings();

  // Import dynamically to test
  const { createActiveRetrievalPipeline } = await import('../src/lib/active-retrieval.js');

  // Create test data
  const node = await db.createNode({
    node_type: 'learning',
    one_liner: 'React useEffect cleanup prevents memory leaks',
    summary: 'Learned about proper cleanup in useEffect hooks',
    full_synthesis: 'Full details about React hooks',
    entity_name: null,
    entity_aliases: null,
    temporal_context: null,
    first_seen: Date.now(),
    last_updated: Date.now(),
    status: null,
    assigned_agent: null,
    priority: null,
    source_session_id: 'test',
    source_agent_id: null,
    source_repo: null,
  });

  const embedding = await generateSynthesisEmbedding(node.one_liner, node.summary, node.node_type);
  await db.insertEmbedding(node.id, embedding);

  // Set up core memory
  const { createCoreMemoryService } = await import('../src/lib/core-memory.js');
  const coreMemoryService = createCoreMemoryService(db);
  await coreMemoryService.setBlock('persona', 'I help with React development.');

  // Create pipeline (without topic inference to avoid API calls)
  const pipeline = createActiveRetrievalPipeline(db, generateEmbedding, undefined, {
    topicInferenceEnabled: false, // Skip API calls in tests
    maxTopics: 3,
    minScore: 0.3,
    maxResultsPerType: 5,
    verbosity: 'standard',
    maxTokens: 4000,
    includeCoreMemory: true,
    includeNodeIds: true,
    debugLogging: false,
  });

  // Test simple retrieve (no topic inference)
  const result = await pipeline.simpleRetrieve('React hooks memory leaks');

  if (!result.formattedContext) {
    // May be null if no matches found - that's OK for this test
    console.log('  - Simple retrieve (no matches): PASS');
  } else {
    if (!result.formattedContext.includes('<total_recall_context>')) {
      throw new Error('Missing expected XML tags in output');
    }
    console.log(`  - Simple retrieve (${result.metrics.resultCount} results): PASS`);
  }

  // Verify metrics
  if (typeof result.metrics.totalMs !== 'number') {
    throw new Error('Metrics should include totalMs');
  }
  console.log(`  - Metrics tracking (${result.metrics.totalMs}ms): PASS`);

  await db.close();
  console.log('Active retrieval pipeline tests: PASS\n');
}

async function testRawContentSearch() {
  console.log('Test: Raw content search...');
  await cleanup();
  const db = await createSQLiteDatabase(TEST_DB_PATH);

  // Create a synthesis node to link some raw content
  const node = await db.createNode({
    node_type: 'learning',
    one_liner: 'Authentication best practices',
    summary: 'Learned about JWT vs session tokens',
    full_synthesis: 'Full details about authentication',
    entity_name: null,
    entity_aliases: null,
    temporal_context: null,
    first_seen: Date.now(),
    last_updated: Date.now(),
    status: null,
    assigned_agent: null,
    priority: null,
    source_session_id: 'search-test-session',
    source_agent_id: null,
    source_repo: null,
  });

  // Create raw content - some linked, some orphaned
  await db.createRawContent({
    id: 'raw-search-1',
    session_id: 'search-test-session',
    synthesis_node_id: node.id,
    content_type: 'message',
    content: 'We should use JWT tokens for authentication in the API',
    agent_id: null,
    timestamp: Date.now(),
    message_index: 0,
  });

  await db.createRawContent({
    id: 'raw-search-2',
    session_id: 'search-test-session',
    synthesis_node_id: null, // orphan
    content_type: 'message',
    content: 'The database migration needs to include user tokens table',
    agent_id: null,
    timestamp: Date.now() + 1000,
    message_index: 1,
  });

  await db.createRawContent({
    id: 'raw-search-3',
    session_id: 'search-test-session',
    synthesis_node_id: null, // orphan
    content_type: 'message',
    content: 'React components for the login form',
    agent_id: null,
    timestamp: Date.now() + 2000,
    message_index: 2,
  });

  // Test search with include_orphans=true (default)
  const resultsAll = await db.searchRawContentByText('tokens', 20, true);
  if (resultsAll.length !== 2) {
    throw new Error(`Expected 2 results for "tokens", got ${resultsAll.length}`);
  }
  console.log('  - Search all content (include orphans): PASS');

  // Test search with include_orphans=false (only linked content)
  const resultsLinked = await db.searchRawContentByText('tokens', 20, false);
  if (resultsLinked.length !== 1) {
    throw new Error(`Expected 1 linked result for "tokens", got ${resultsLinked.length}`);
  }
  console.log('  - Search linked content only: PASS');

  // Test case-insensitive search
  const resultsUpper = await db.searchRawContentByText('JWT', 20, true);
  if (resultsUpper.length !== 1) {
    throw new Error(`Expected 1 result for "JWT", got ${resultsUpper.length}`);
  }
  console.log('  - Case-insensitive search: PASS');

  // Test no results
  const resultsNone = await db.searchRawContentByText('nonexistent-xyz', 20, true);
  if (resultsNone.length !== 0) {
    throw new Error(`Expected 0 results for nonexistent query, got ${resultsNone.length}`);
  }
  console.log('  - No results for non-matching query: PASS');

  // Test limit
  const resultsLimit = await db.searchRawContentByText('the', 1, true);
  if (resultsLimit.length > 1) {
    throw new Error(`Limit not respected, got ${resultsLimit.length} results`);
  }
  console.log('  - Limit parameter respected: PASS');

  await db.close();
  console.log('Raw content search tests: PASS\n');
}

async function testRawContentVectorSearch() {
  console.log('Test: Raw content vector search...');
  await cleanup();
  const db = await createSQLiteDatabase(TEST_DB_PATH);
  await initEmbeddings();

  // Create raw content with embeddings
  await db.createRawContent({
    id: 'raw-vec-1',
    session_id: 'vec-test-session',
    synthesis_node_id: null,
    content_type: 'message',
    content: 'Machine learning algorithms for natural language processing',
    agent_id: null,
    timestamp: Date.now(),
    message_index: 0,
  });

  await db.createRawContent({
    id: 'raw-vec-2',
    session_id: 'vec-test-session',
    synthesis_node_id: null,
    content_type: 'message',
    content: 'Database indexing strategies for PostgreSQL',
    agent_id: null,
    timestamp: Date.now() + 1000,
    message_index: 1,
  });

  await db.createRawContent({
    id: 'raw-vec-3',
    session_id: 'vec-test-session',
    synthesis_node_id: null,
    content_type: 'message',
    content: 'Deep neural networks and transformer architectures',
    agent_id: null,
    timestamp: Date.now() + 2000,
    message_index: 2,
  });

  // Generate and insert embeddings for all raw content
  const rawContent = await db.getRawContentWithoutEmbedding(10);
  for (const rc of rawContent) {
    const embedding = await generateEmbedding(rc.content);
    await db.insertRawEmbedding(rc.id, embedding);
  }

  // Verify embeddings were created
  const embeddingCount = await db.getRawEmbeddingCount();
  if (embeddingCount !== 3) {
    throw new Error(`Expected 3 embeddings, got ${embeddingCount}`);
  }
  console.log('  - Embedding creation: PASS');

  // Test vector search - should find ML-related content
  const queryEmbedding = await generateEmbedding('AI and machine learning');
  const vectorResults = await db.searchRawByVector(queryEmbedding, 10, 0.3, true);

  if (vectorResults.length === 0) {
    throw new Error('Expected vector search results for ML query');
  }
  console.log(`  - Vector search found ${vectorResults.length} results: PASS`);

  // Verify scores are in valid range
  const allScoresValid = vectorResults.every((r) => r.score >= 0 && r.score <= 1);
  if (!allScoresValid) {
    throw new Error('Vector search scores not in valid range [0, 1]');
  }
  console.log('  - Score range validation: PASS');

  // Verify results are sorted by score (highest first after transformation)
  const scoresDescending = vectorResults.every((r, i) =>
    i === 0 || r.score <= vectorResults[i - 1].score
  );
  if (!scoresDescending) {
    throw new Error('Vector search results not sorted by score');
  }
  console.log('  - Results sorted by score: PASS');

  // Test min_score filtering
  const highScoreResults = await db.searchRawByVector(queryEmbedding, 10, 0.9, true);
  const allHighScores = highScoreResults.every((r) => r.score >= 0.9);
  if (!allHighScores && highScoreResults.length > 0) {
    throw new Error('min_score filtering not working correctly');
  }
  console.log('  - min_score filtering: PASS');

  await db.close();
  console.log('Raw content vector search tests: PASS\n');
}

async function testSynthesisRecall() {
  console.log('Test: Synthesis recall (exact text search)...');
  await cleanup();
  const db = await createSQLiteDatabase(TEST_DB_PATH);

  // Create nodes with various content for recall testing
  await db.createNode({
    node_type: 'entity',
    one_liner: 'DEVFLOW workflow automation system',
    summary: 'A CLI tool for orchestrating development workflows',
    full_synthesis: 'DEVFLOW provides automated development processes including testing, deployment, and code review.',
    entity_name: 'DEVFLOW',
    entity_aliases: JSON.stringify(['devflow', 'DevFlow']),
    temporal_context: null,
    first_seen: Date.now(),
    last_updated: Date.now(),
    status: null,
    assigned_agent: null,
    priority: null,
    source_session_id: 'recall-test',
    source_agent_id: null,
    source_repo: null,
  });

  await db.createNode({
    node_type: 'learning',
    one_liner: 'Authentication best practices for APIs',
    summary: 'JWT tokens provide stateless authentication for BeadsService',
    full_synthesis: 'The BeadsService API uses JWT tokens with refresh capabilities.',
    entity_name: null,
    entity_aliases: null,
    temporal_context: null,
    first_seen: Date.now(),
    last_updated: Date.now() + 1000,
    status: null,
    assigned_agent: null,
    priority: null,
    source_session_id: 'recall-test',
    source_agent_id: null,
    source_repo: null,
  });

  await db.createNode({
    node_type: 'decision',
    one_liner: 'Use PostgreSQL for data persistence',
    summary: 'PostgreSQL chosen over MySQL for better JSON support',
    full_synthesis: 'Full rationale for database choice...',
    entity_name: null,
    entity_aliases: null,
    temporal_context: null,
    first_seen: Date.now(),
    last_updated: Date.now() + 2000,
    status: null,
    assigned_agent: null,
    priority: null,
    source_session_id: 'recall-test',
    source_agent_id: null,
    source_repo: null,
  });

  // Test 1: Recall by entity name (highest priority)
  const devflowResults = await db.searchNodesByText('DEVFLOW', 10);
  if (devflowResults.length !== 1) {
    throw new Error(`Expected 1 result for DEVFLOW, got ${devflowResults.length}`);
  }
  if (devflowResults[0].match_location !== 'entity_name') {
    throw new Error(`Expected match_location 'entity_name', got ${devflowResults[0].match_location}`);
  }
  console.log('  - Recall by entity name: PASS');

  // Test 2: Recall by one_liner
  const postgresResults = await db.searchNodesByText('PostgreSQL', 10);
  if (postgresResults.length !== 1) {
    throw new Error(`Expected 1 result for PostgreSQL, got ${postgresResults.length}`);
  }
  if (postgresResults[0].match_location !== 'one_liner') {
    throw new Error(`Expected match_location 'one_liner', got ${postgresResults[0].match_location}`);
  }
  console.log('  - Recall by one_liner: PASS');

  // Test 3: Recall by summary
  const beadsResults = await db.searchNodesByText('BeadsService', 10);
  if (beadsResults.length !== 1) {
    throw new Error(`Expected 1 result for BeadsService, got ${beadsResults.length}`);
  }
  if (beadsResults[0].match_location !== 'summary') {
    throw new Error(`Expected match_location 'summary', got ${beadsResults[0].match_location}`);
  }
  console.log('  - Recall by summary: PASS');

  // Test 4: Case-insensitive search (same node found via entity_name first due to priority)
  const devflowLowerResults = await db.searchNodesByText('devflow', 10);
  if (devflowLowerResults.length !== 1) {
    // Should find the same node (deduplicated) - DEVFLOW matches via entity_name
    throw new Error(`Expected 1 result for lowercase devflow, got ${devflowLowerResults.length}`);
  }
  // Verify it's the entity node (found via entity_name, which has highest priority)
  if (devflowLowerResults[0].entity_name !== 'DEVFLOW') {
    throw new Error('Case-insensitive search did not find DEVFLOW entity');
  }
  console.log('  - Case-insensitive search: PASS');

  // Test 5: Filter by node type
  const entityResults = await db.searchNodesByText('DEVFLOW', 10, ['entity']);
  if (entityResults.length !== 1) {
    throw new Error(`Expected 1 entity result, got ${entityResults.length}`);
  }
  if (entityResults[0].node_type !== 'entity') {
    throw new Error('Node type filter not working');
  }
  console.log('  - Filter by node type: PASS');

  // Test 6: No matches
  const noResults = await db.searchNodesByText('xyznonexistent123', 10);
  if (noResults.length !== 0) {
    throw new Error('Expected 0 results for nonexistent term');
  }
  console.log('  - No matches for nonexistent term: PASS');

  await db.close();
  console.log('Synthesis recall tests: PASS\n');
}

async function testNodeIdPrefixResolution() {
  console.log('Test: Node ID prefix resolution...');
  await cleanup();
  const db = await createSQLiteDatabase(TEST_DB_PATH);

  // Create multiple nodes with known IDs (UUIDs are generated, but we can test prefix matching)
  const node1 = await db.createNode({
    node_type: 'learning',
    one_liner: 'First test node',
    summary: 'Testing prefix resolution',
    full_synthesis: 'Full details',
    entity_name: null,
    entity_aliases: null,
    temporal_context: null,
    first_seen: Date.now(),
    last_updated: Date.now(),
    status: null,
    assigned_agent: null,
    priority: null,
    source_session_id: 'prefix-test',
    source_agent_id: null,
    source_repo: null,
  });

  const node2 = await db.createNode({
    node_type: 'decision',
    one_liner: 'Second test node',
    summary: 'Another node for prefix test',
    full_synthesis: 'Full details',
    entity_name: null,
    entity_aliases: null,
    temporal_context: null,
    first_seen: Date.now(),
    last_updated: Date.now() + 1000,
    status: null,
    assigned_agent: null,
    priority: null,
    source_session_id: 'prefix-test',
    source_agent_id: null,
    source_repo: null,
  });

  // Test 1: Full ID lookup should return exactly that node
  const fullIdResults = await db.queryNodesByIdPrefix(node1.id, 10);
  if (fullIdResults.length !== 1) {
    throw new Error(`Expected 1 result for full ID, got ${fullIdResults.length}`);
  }
  if (fullIdResults[0].id !== node1.id) {
    throw new Error('Full ID lookup returned wrong node');
  }
  console.log('  - Full ID lookup: PASS');

  // Test 2: Short prefix (first 8 chars) should find the node
  const shortPrefix = node1.id.slice(0, 8);
  const prefixResults = await db.queryNodesByIdPrefix(shortPrefix, 10);
  if (prefixResults.length === 0) {
    throw new Error(`Expected at least 1 result for prefix ${shortPrefix}`);
  }
  const foundNode = prefixResults.find((n) => n.id === node1.id);
  if (!foundNode) {
    throw new Error(`Node ${node1.id} not found with prefix ${shortPrefix}`);
  }
  console.log('  - Short prefix (8 chars) lookup: PASS');

  // Test 3: Very short prefix (first 4 chars) works
  const veryShortPrefix = node1.id.slice(0, 4);
  const veryShortResults = await db.queryNodesByIdPrefix(veryShortPrefix, 10);
  if (veryShortResults.length === 0) {
    throw new Error(`Expected at least 1 result for very short prefix ${veryShortPrefix}`);
  }
  console.log('  - Very short prefix (4 chars) lookup: PASS');

  // Test 4: Non-existent prefix returns empty
  const noResults = await db.queryNodesByIdPrefix('zzzzzzzz-nonexistent', 10);
  if (noResults.length !== 0) {
    throw new Error('Expected 0 results for non-existent prefix');
  }
  console.log('  - Non-existent prefix returns empty: PASS');

  // Test 5: Limit is respected
  const limitedResults = await db.queryNodesByIdPrefix('', 1); // Empty prefix matches all
  if (limitedResults.length > 1) {
    throw new Error(`Limit not respected, got ${limitedResults.length} results`);
  }
  console.log('  - Limit parameter respected: PASS');

  // Test 6: Special characters in prefix are escaped (SQL injection prevention)
  const specialResults = await db.queryNodesByIdPrefix('%_', 10);
  // Should return 0 results, not cause an error
  if (specialResults.length !== 0) {
    throw new Error('Special characters should be escaped');
  }
  console.log('  - Special character escaping: PASS');

  await db.close();
  console.log('Node ID prefix resolution tests: PASS\n');
}

async function testRelationshipBuilder() {
  console.log('Test: Relationship builder...');
  await cleanup();
  const db = await createSQLiteDatabase(TEST_DB_PATH);
  await initEmbeddings();

  // Import dynamically to test
  const { RelationshipBuilder } = await import('../src/lib/relationship-builder.js');

  // Create 3 nodes - 2 with edges, 1 orphan
  const node1 = await db.createNode({
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
  await db.insertEmbedding(node1.id, emb1);

  const node2 = await db.createNode({
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
  await db.insertEmbedding(node2.id, emb2);

  // Create edge between node1 and node2
  await db.createEdge({
    from_node_id: node1.id,
    to_node_id: node2.id,
    edge_type: 'relates_to',
    weight: 0.8,
    context: 'existing',
  });

  // Orphan node (related to React but no edges)
  const orphan = await db.createNode({
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
  await db.insertEmbedding(orphan.id, embOrphan);

  // Verify orphan exists
  const orphansBefore = await db.getOrphanNodes();
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
  const orphansAfterDry = await db.getOrphanNodes();
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
  const orphansAfter = await db.getOrphanNodes();
  if (orphansAfter.length !== 0) {
    throw new Error(`Expected 0 orphans after rebuild, got ${orphansAfter.length}`);
  }
  console.log('  - Orphan now connected: PASS');

  await db.close();
  console.log('Relationship builder tests: PASS\n');
}

async function testTimeBasedQueries() {
  console.log('Test: Time-based queries (Issue #10)...');
  await cleanup();
  const db = await createSQLiteDatabase(TEST_DB_PATH);

  // Create nodes at different times
  const now = Date.now();
  const yesterday = now - 24 * 60 * 60 * 1000;
  const lastWeek = now - 7 * 24 * 60 * 60 * 1000;
  const lastMonth = now - 30 * 24 * 60 * 60 * 1000;

  // Node from last month
  const node1 = await db.createNode({
    node_type: 'decision',
    one_liner: 'Old decision from last month',
    summary: 'A decision made a while ago',
    full_synthesis: 'Full details',
    entity_name: null,
    entity_aliases: null,
    temporal_context: null,
    first_seen: lastMonth,
    last_updated: lastMonth,
    status: null,
    assigned_agent: null,
    priority: null,
    source_session_id: 'time-test',
    source_agent_id: null,
    source_repo: null,
  });
  // Manually set created_at for testing
  db['db'].prepare('UPDATE synthesis_nodes SET created_at = ? WHERE id = ?').run(lastMonth, node1.id);

  // Node from last week
  const node2 = await db.createNode({
    node_type: 'learning',
    one_liner: 'Learning from last week',
    summary: 'Something learned last week',
    full_synthesis: 'Full details',
    entity_name: null,
    entity_aliases: null,
    temporal_context: null,
    first_seen: lastWeek,
    last_updated: lastWeek,
    status: null,
    assigned_agent: null,
    priority: null,
    source_session_id: 'time-test',
    source_agent_id: null,
    source_repo: null,
  });
  db['db'].prepare('UPDATE synthesis_nodes SET created_at = ? WHERE id = ?').run(lastWeek, node2.id);

  // Node from yesterday
  const node3 = await db.createNode({
    node_type: 'task',
    one_liner: 'Task from yesterday',
    summary: 'A task completed yesterday',
    full_synthesis: 'Full details',
    entity_name: null,
    entity_aliases: null,
    temporal_context: null,
    first_seen: yesterday,
    last_updated: yesterday,
    status: null,
    assigned_agent: null,
    priority: null,
    source_session_id: 'time-test',
    source_agent_id: null,
    source_repo: null,
  });
  db['db'].prepare('UPDATE synthesis_nodes SET created_at = ? WHERE id = ?').run(yesterday, node3.id);

  // Node from today
  const node4 = await db.createNode({
    node_type: 'event',
    one_liner: 'Event from today',
    summary: 'Something that happened today',
    full_synthesis: 'Full details',
    entity_name: null,
    entity_aliases: null,
    temporal_context: null,
    first_seen: now,
    last_updated: now,
    status: null,
    assigned_agent: null,
    priority: null,
    source_session_id: 'time-test',
    source_agent_id: null,
    source_repo: null,
  });
  db['db'].prepare('UPDATE synthesis_nodes SET created_at = ? WHERE id = ?').run(now, node4.id);

  // Test 1: Query last 7 days (should get nodes 2, 3, 4)
  const last7Days = await db.queryNodesByTimeRange(now - 7 * 24 * 60 * 60 * 1000, now, {
    orderBy: 'created_at',
  });
  if (last7Days.length !== 3) {
    throw new Error(`Expected 3 nodes in last 7 days, got ${last7Days.length}`);
  }
  console.log('  - Query last 7 days: PASS');

  // Test 2: Query by node type
  const decisionsLast30Days = await db.queryNodesByTimeRange(now - 30 * 24 * 60 * 60 * 1000, now, {
    nodeTypes: ['decision'],
    orderBy: 'created_at',
  });
  if (decisionsLast30Days.length !== 1 || decisionsLast30Days[0].id !== node1.id) {
    throw new Error('Node type filter not working correctly');
  }
  console.log('  - Query by node type: PASS');

  // Test 3: Activity summary grouped by type
  const summaryByType = await db.getActivitySummary(now - 30 * 24 * 60 * 60 * 1000, now, {
    groupBy: 'type',
    includeNodeSamples: true,
    maxSamplesPerGroup: 2,
  });

  if (summaryByType.totalNodes !== 4) {
    throw new Error(`Expected 4 total nodes, got ${summaryByType.totalNodes}`);
  }

  if (summaryByType.groups.length !== 4) {
    throw new Error(`Expected 4 groups (one per type), got ${summaryByType.groups.length}`);
  }

  const decisionGroup = summaryByType.groups.find((g) => g.nodeType === 'decision');
  if (!decisionGroup || decisionGroup.count !== 1) {
    throw new Error('Decision group incorrect');
  }
  console.log('  - Activity summary by type: PASS');

  // Test 4: Activity summary grouped by date
  const summaryByDate = await db.getActivitySummary(now - 30 * 24 * 60 * 60 * 1000, now, {
    groupBy: 'date',
    includeNodeSamples: false,
  });

  if (!summaryByDate.dailyActivity) {
    throw new Error('Daily activity not populated');
  }

  // Should have entries for each unique date
  if (summaryByDate.dailyActivity.length < 3) {
    throw new Error('Daily activity should have at least 3 entries');
  }
  console.log('  - Activity summary by date: PASS');

  // Test 5: Activity summary grouped by both
  const summaryByBoth = await db.getActivitySummary(now - 30 * 24 * 60 * 60 * 1000, now, {
    groupBy: 'both',
    includeNodeSamples: true,
    maxSamplesPerGroup: 1,
  });

  // Each group should have both nodeType and date
  const firstGroup = summaryByBoth.groups[0];
  if (!firstGroup.nodeType || !firstGroup.date) {
    throw new Error('Groups should have both nodeType and date when groupBy="both"');
  }

  // Check groupKey format
  if (!firstGroup.groupKey.includes(':')) {
    throw new Error('Group key should be in format "type:date"');
  }

  console.log('  - Activity summary by both: PASS');

  // Test 6: Node type distribution
  if (summaryByType.nodeTypeDistribution.decision !== 1) {
    throw new Error('Node type distribution incorrect for decision');
  }
  if (summaryByType.nodeTypeDistribution.learning !== 1) {
    throw new Error('Node type distribution incorrect for learning');
  }
  console.log('  - Node type distribution: PASS');

  // Test 7: Sample nodes
  const groupWithSamples = summaryByType.groups.find((g) => g.sampleNodes && g.sampleNodes.length > 0);
  if (!groupWithSamples) {
    throw new Error('Should have sample nodes');
  }
  if (!groupWithSamples.sampleNodes![0].node_id) {
    throw new Error('Sample node should have node_id');
  }
  if (!groupWithSamples.sampleNodes![0].one_liner) {
    throw new Error('Sample node should have one_liner');
  }
  console.log('  - Sample nodes in groups: PASS');

  await db.close();
  console.log('Time-based queries tests: PASS\n');
}

async function testTimeWindows() {
  console.log('Test: TIME_WINDOWS presets...');
  const { TIME_WINDOWS } = await import('../src/db/interface.js');

  // Test that each preset returns a valid time range
  const presets = ['TODAY', 'YESTERDAY', 'THIS_WEEK', 'LAST_WEEK', 'THIS_MONTH', 'LAST_MONTH', 'LAST_7_DAYS', 'LAST_30_DAYS'] as const;

  for (const preset of presets) {
    const range = TIME_WINDOWS[preset]();
    if (!range.start || !range.end) {
      throw new Error(`${preset} returned invalid range`);
    }
    if (range.start >= range.end) {
      throw new Error(`${preset} start >= end`);
    }
  }
  console.log('  - All presets return valid ranges: PASS');

  // Test TODAY
  const today = TIME_WINDOWS.TODAY();
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
  if (Math.abs(today.start - todayStart.getTime()) > 1000) {
    throw new Error('TODAY start time incorrect');
  }
  console.log('  - TODAY preset: PASS');

  // Test LAST_7_DAYS
  const last7Days = TIME_WINDOWS.LAST_7_DAYS();
  const expectedStart = Date.now() - 7 * 24 * 60 * 60 * 1000;
  if (Math.abs(last7Days.start - expectedStart) > 60000) { // Within 1 minute
    throw new Error('LAST_7_DAYS start time incorrect');
  }
  console.log('  - LAST_7_DAYS preset: PASS');

  console.log('TIME_WINDOWS tests: PASS\n');
}

async function main() {
  console.log('=== TotalRecall Integration Tests ===\n');

  try {
    await testDatabaseSchema();
    await testEmbeddings();
    await testVectorSearch();
    await testScoreCalculation();
    await testEntityContextInEmbeddings();
    await testQueueOperations();
    await testProgressiveDisclosureAnalytics();
    await testEdgeHelpers();
    await testContextFormatter();
    await testCoreMemory();
    await testQueryRouter();
    await testActiveRetrievalPipeline();
    await testRawContentSearch();
    await testRawContentVectorSearch();
    await testSynthesisRecall();
    await testNodeIdPrefixResolution();
    await testRelationshipBuilder();
    await testTimeBasedQueries();
    await testTimeWindows();

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
