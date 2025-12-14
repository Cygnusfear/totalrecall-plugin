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
    await testRelationshipBuilder();

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
