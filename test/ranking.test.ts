/**
 * Tests for search ranking feature (Issue #11)
 * Tests recency, node type importance, and relationship density ranking
 */

import { createSQLiteDatabase, type ISynthesisDatabase } from '../src/db.js';
import {
  calculateRecencyScore,
  calculateTypeScore,
  calculateRelationshipScore,
  applySearchRanking,
  DEFAULT_RANKING_CONFIG,
  type SearchRankingConfig,
} from '../src/db/interface.js';
import type { SearchResult, NodeType } from '../src/schema.js';
import { unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const TEST_DB_PATH = join(tmpdir(), 'totalrecall-ranking-test.sqlite');

async function cleanup() {
  if (existsSync(TEST_DB_PATH)) {
    unlinkSync(TEST_DB_PATH);
  }
}

// ============ Unit Tests for Ranking Functions ============

function testRecencyScore() {
  console.log('Test: Recency score calculation...');

  const now = Date.now();
  const oneDayAgo = now - 1000 * 60 * 60 * 24;
  const thirtyDaysAgo = now - 1000 * 60 * 60 * 24 * 30;
  const sixtyDaysAgo = now - 1000 * 60 * 60 * 24 * 60;

  // Recent nodes should score near 1.0
  const recentScore = calculateRecencyScore(oneDayAgo, 30);
  if (recentScore < 0.95) throw new Error(`Recent score too low: ${recentScore}`);

  // Nodes at decay boundary should score ~0.37 (e^-1)
  const decayScore = calculateRecencyScore(thirtyDaysAgo, 30);
  if (Math.abs(decayScore - 0.368) > 0.05)
    throw new Error(`Decay score incorrect: ${decayScore}`);

  // Old nodes should score near 0
  const oldScore = calculateRecencyScore(sixtyDaysAgo, 30);
  if (oldScore > 0.2) throw new Error(`Old score too high: ${oldScore}`);

  console.log('  - Recency decay: PASS');
  console.log(`    Recent (1 day): ${recentScore.toFixed(3)}`);
  console.log(`    At decay (30 days): ${decayScore.toFixed(3)}`);
  console.log(`    Old (60 days): ${oldScore.toFixed(3)}`);
}

function testTypeScore() {
  console.log('\nTest: Node type importance scores...');

  const scores = DEFAULT_RANKING_CONFIG.nodeTypeScores;

  // Verify expected hierarchy
  if (scores.decision <= scores.entity)
    throw new Error('Decision should rank higher than entity');
  if (scores.entity <= scores.learning)
    throw new Error('Entity should rank higher than learning');
  if (scores.learning <= scores.task) throw new Error('Learning should rank higher than task');
  if (scores.task <= scores.summary) throw new Error('Task should rank higher than summary');
  if (scores.summary <= scores.event) throw new Error('Summary should rank higher than event');

  console.log('  - Type hierarchy: PASS');
  for (const [type, score] of Object.entries(scores)) {
    console.log(`    ${type}: ${score}`);
  }
}

function testRelationshipScore() {
  console.log('\nTest: Relationship density scoring...');

  const noEdges = calculateRelationshipScore(0);
  const fewEdges = calculateRelationshipScore(5);
  const manyEdges = calculateRelationshipScore(50);
  const maxEdges = calculateRelationshipScore(100);

  if (noEdges !== 0) throw new Error(`Zero edges should score 0: ${noEdges}`);
  if (fewEdges >= manyEdges)
    throw new Error('More edges should score higher');
  if (manyEdges >= maxEdges) throw new Error('100 edges should score highest');
  if (maxEdges > 1.0) throw new Error('Max score should not exceed 1.0');

  console.log('  - Relationship scaling: PASS');
  console.log(`    0 edges: ${noEdges.toFixed(3)}`);
  console.log(`    5 edges: ${fewEdges.toFixed(3)}`);
  console.log(`    50 edges: ${manyEdges.toFixed(3)}`);
  console.log(`    100 edges: ${maxEdges.toFixed(3)}`);
}

function testApplySearchRanking() {
  console.log('\nTest: Multi-factor ranking application...');

  const now = Date.now();
  const results: SearchResult[] = [
    {
      node_id: '1',
      one_liner: 'Recent decision, high similarity',
      score: 0.9, // High similarity
      node_type: 'decision', // High type score
      created_at: now - 1000 * 60 * 60 * 24, // 1 day old (high recency)
    },
    {
      node_id: '2',
      one_liner: 'Old event, low similarity',
      score: 0.5, // Medium similarity
      node_type: 'event', // Low type score
      created_at: now - 1000 * 60 * 60 * 24 * 60, // 60 days old (low recency)
    },
    {
      node_id: '3',
      one_liner: 'Recent entity, medium similarity, many edges',
      score: 0.7, // Medium similarity
      node_type: 'entity', // High type score
      created_at: now - 1000 * 60 * 60 * 24 * 3, // 3 days old (high recency)
    },
  ];

  const edgeCounts = new Map([
    ['1', 2], // Few edges
    ['2', 0], // No edges
    ['3', 50], // Many edges
  ]);

  const ranked = applySearchRanking(results, edgeCounts);

  // Node 1 should rank first (recent, high type, high similarity)
  if (ranked[0].node_id !== '1')
    throw new Error(`Expected node 1 first, got ${ranked[0].node_id}`);

  // Node 3 should rank second (recent, high type, many edges)
  if (ranked[1].node_id !== '3')
    throw new Error(`Expected node 3 second, got ${ranked[1].node_id}`);

  // Node 2 should rank last (old, low type, no edges)
  if (ranked[2].node_id !== '2')
    throw new Error(`Expected node 2 last, got ${ranked[2].node_id}`);

  console.log('  - Ranking order: PASS');
  for (let i = 0; i < ranked.length; i++) {
    console.log(`    ${i + 1}. Node ${ranked[i].node_id}: score=${ranked[i].rankingScore.toFixed(3)}`);
    console.log(
      `       (sim=${ranked[i].score.toFixed(2)}, recency=${ranked[i].recencyScore?.toFixed(2)}, type=${ranked[i].typeScore?.toFixed(2)}, edges=${ranked[i].edgeCount})`
    );
  }
}

// ============ Integration Tests with Database ============

async function testDatabaseRankingIntegration() {
  console.log('\nTest: Database integration with ranking...');

  const db = await createSQLiteDatabase(TEST_DB_PATH);
  const now = Date.now();

  // Create nodes with different characteristics
  // Node 1: Recent decision (should rank high)
  const node1 = await db.createNode({
    node_type: 'decision',
    one_liner: 'Use microservices architecture',
    summary: 'Decision to adopt microservices',
    full_synthesis: 'We decided to use microservices for scalability',
    entity_name: null,
    entity_aliases: null,
    temporal_context: null,
    first_seen: now - 1000 * 60 * 60 * 24,
    last_updated: now - 1000 * 60 * 60 * 24,
    status: null,
    assigned_agent: null,
    priority: null,
    source_session_id: 'test-session',
    source_agent_id: null,
    source_repo: null,
  });

  // Node 2: Old event (should rank low)
  const node2 = await db.createNode({
    node_type: 'event',
    one_liner: 'Database migration completed',
    summary: 'Completed migration to PostgreSQL',
    full_synthesis: 'Migration completed successfully',
    entity_name: null,
    entity_aliases: null,
    temporal_context: null,
    first_seen: now - 1000 * 60 * 60 * 24 * 60,
    last_updated: now - 1000 * 60 * 60 * 24 * 60,
    status: null,
    assigned_agent: null,
    priority: null,
    source_session_id: 'test-session',
    source_agent_id: null,
    source_repo: null,
  });

  // Node 3: Recent entity with edges (should rank high)
  const node3 = await db.createNode({
    node_type: 'entity',
    one_liner: 'UserService component',
    summary: 'Core user authentication service',
    full_synthesis: 'Service handling user auth and sessions',
    entity_name: 'UserService',
    entity_aliases: null,
    temporal_context: null,
    first_seen: now - 1000 * 60 * 60 * 24 * 3,
    last_updated: now - 1000 * 60 * 60 * 24 * 3,
    status: null,
    assigned_agent: null,
    priority: null,
    source_session_id: 'test-session',
    source_agent_id: null,
    source_repo: null,
  });

  // Create edges for node 3 (many connections)
  for (let i = 0; i < 10; i++) {
    const relatedNode = await db.createNode({
      node_type: 'learning',
      one_liner: `Related learning ${i}`,
      summary: `Learning about aspect ${i}`,
      full_synthesis: `Details about aspect ${i}`,
      entity_name: null,
      entity_aliases: null,
      temporal_context: null,
      first_seen: now,
      last_updated: now,
      status: null,
      assigned_agent: null,
      priority: null,
      source_session_id: 'test-session',
      source_agent_id: null,
      source_repo: null,
    });

    await db.createEdge({
      from_node_id: node3.id,
      to_node_id: relatedNode.id,
      edge_type: 'relates_to',
      weight: 1.0,
      context: null,
    });
  }

  // Add embeddings (dummy vectors for testing)
  const dummyEmbedding = new Array(384).fill(0);
  dummyEmbedding[0] = 1.0; // Make them similar

  await db.insertEmbedding(node1.id, dummyEmbedding);
  await db.insertEmbedding(node2.id, dummyEmbedding);
  await db.insertEmbedding(node3.id, dummyEmbedding);

  // Test search WITHOUT ranking (similarity only)
  const unrankedResults = await db.searchByVector(dummyEmbedding, 10, 0.0);
  console.log('  - Without ranking (similarity only):');
  for (let i = 0; i < Math.min(3, unrankedResults.length); i++) {
    const node = await db.getNode(unrankedResults[i].node_id);
    console.log(
      `    ${i + 1}. ${node?.node_type}: ${unrankedResults[i].one_liner} (score: ${unrankedResults[i].score.toFixed(3)})`
    );
  }

  // Test search WITH ranking
  const rankedResults = await db.searchByVector(dummyEmbedding, 10, 0.0, undefined, {});
  console.log('\n  - With ranking (multi-factor):');
  for (let i = 0; i < Math.min(3, rankedResults.length); i++) {
    const node = await db.getNode(rankedResults[i].node_id);
    console.log(
      `    ${i + 1}. ${node?.node_type}: ${rankedResults[i].one_liner} (score: ${rankedResults[i].score.toFixed(3)})`
    );
  }

  // Verify ranking improves relevance
  // Node3 (entity with many edges) or Node1 (recent decision) should rank first
  const topNode = await db.getNode(rankedResults[0].node_id);
  if (!topNode || (topNode.node_type !== 'entity' && topNode.node_type !== 'decision')) {
    throw new Error(
      `Expected entity or decision to rank first, got ${topNode?.node_type}`
    );
  }

  // Node2 (old event) should NOT rank first
  if (topNode.id === node2.id) {
    throw new Error('Old event should not rank first with ranking enabled');
  }

  console.log('  - Ranking improves relevance: PASS');

  await db.close();
}

async function testCustomRankingWeights() {
  console.log('\nTest: Custom ranking weights...');

  const db = await createSQLiteDatabase(TEST_DB_PATH);
  const now = Date.now();

  // Create two nodes: one recent with low type, one old with high type
  const recentEvent = await db.createNode({
    node_type: 'event',
    one_liner: 'Recent event',
    summary: 'A recent event',
    full_synthesis: 'Details about recent event',
    entity_name: null,
    entity_aliases: null,
    temporal_context: null,
    first_seen: now - 1000 * 60 * 60 * 24,
    last_updated: now - 1000 * 60 * 60 * 24,
    status: null,
    assigned_agent: null,
    priority: null,
    source_session_id: 'test-session',
    source_agent_id: null,
    source_repo: null,
  });

  const oldDecision = await db.createNode({
    node_type: 'decision',
    one_liner: 'Old decision',
    summary: 'An old but important decision',
    full_synthesis: 'Details about old decision',
    entity_name: null,
    entity_aliases: null,
    temporal_context: null,
    first_seen: now - 1000 * 60 * 60 * 24 * 60,
    last_updated: now - 1000 * 60 * 60 * 24 * 60,
    status: null,
    assigned_agent: null,
    priority: null,
    source_session_id: 'test-session',
    source_agent_id: null,
    source_repo: null,
  });

  // Create different embeddings so they have different similarity scores
  const queryEmbedding = new Array(384).fill(0);
  queryEmbedding[0] = 1.0;

  // Recent event embedding - moderate match
  const recentEmbedding = new Array(384).fill(0);
  recentEmbedding[0] = 0.7;
  recentEmbedding[1] = 0.3;

  // Old decision embedding - also moderate match
  const oldEmbedding = new Array(384).fill(0);
  oldEmbedding[0] = 0.6;
  oldEmbedding[1] = 0.4;

  await db.insertEmbedding(recentEvent.id, recentEmbedding);
  await db.insertEmbedding(oldDecision.id, oldEmbedding);

  // Config 1: Strongly prioritize recency (recent event should win)
  const recencyConfig: SearchRankingConfig = {
    recencyWeight: 0.9,
    nodeTypeWeight: 0.0,
    relationshipWeight: 0.0,
    similarityWeight: 0.1,
  };

  const recencyResults = await db.searchByVector(
    queryEmbedding,
    10,
    0.0,
    undefined,
    recencyConfig
  );
  console.log(
    `    Recency priority: ${recencyResults[0].one_liner} (score: ${recencyResults[0].score.toFixed(3)})`
  );
  console.log(
    `                      ${recencyResults[1].one_liner} (score: ${recencyResults[1].score.toFixed(3)})`
  );

  if (recencyResults[0].node_id !== recentEvent.id) {
    throw new Error('With high recency weight, recent event should rank first');
  }
  console.log('  - High recency weight prioritizes recent nodes: PASS');

  // Config 2: Strongly prioritize type (old decision should win)
  const typeConfig: SearchRankingConfig = {
    recencyWeight: 0.0,
    nodeTypeWeight: 0.9,
    relationshipWeight: 0.0,
    similarityWeight: 0.1,
  };

  const typeResults = await db.searchByVector(queryEmbedding, 10, 0.0, undefined, typeConfig);
  console.log(
    `    Type priority: ${typeResults[0].one_liner} (score: ${typeResults[0].score.toFixed(3)})`
  );
  console.log(
    `                   ${typeResults[1].one_liner} (score: ${typeResults[1].score.toFixed(3)})`
  );

  if (typeResults[0].node_id !== oldDecision.id) {
    throw new Error('With high type weight, important decision should rank first');
  }
  console.log('  - High type weight prioritizes important types: PASS');

  await db.close();
}

async function testBackwardsCompatibility() {
  console.log('\nTest: Backwards compatibility (no ranking config)...');

  const db = await createSQLiteDatabase(TEST_DB_PATH);
  const now = Date.now();

  // Create a node
  const node = await db.createNode({
    node_type: 'learning',
    one_liner: 'Test backwards compatibility',
    summary: 'Testing that old code still works',
    full_synthesis: 'Full details',
    entity_name: null,
    entity_aliases: null,
    temporal_context: null,
    first_seen: now,
    last_updated: now,
    status: null,
    assigned_agent: null,
    priority: null,
    source_session_id: 'test-session',
    source_agent_id: null,
    source_repo: null,
  });

  const dummyEmbedding = new Array(384).fill(0);
  dummyEmbedding[0] = 1.0;
  await db.insertEmbedding(node.id, dummyEmbedding);

  // Call searchByVector without rankingConfig (backwards compatibility)
  const results = await db.searchByVector(dummyEmbedding, 10, 0.0);

  if (results.length === 0) {
    throw new Error('Search should still work without ranking config');
  }

  if (results[0].node_id !== node.id) {
    throw new Error('Should find the node without ranking config');
  }

  console.log('  - Search works without ranking config: PASS');
  console.log('  - Backwards compatibility maintained: PASS');

  await db.close();
}

// ============ Main Test Runner ============

async function runAllTests() {
  console.log('='.repeat(60));
  console.log('Search Ranking Tests (Issue #11)');
  console.log('='.repeat(60));

  try {
    await cleanup();

    // Unit tests for ranking functions
    testRecencyScore();
    testTypeScore();
    testRelationshipScore();
    testApplySearchRanking();

    // Integration tests
    await testDatabaseRankingIntegration();
    await cleanup();

    await testCustomRankingWeights();
    await cleanup();

    await testBackwardsCompatibility();
    await cleanup();

    console.log('\n' + '='.repeat(60));
    console.log('All ranking tests PASSED ✓');
    console.log('='.repeat(60));
    process.exit(0);
  } catch (error) {
    console.error('\n' + '='.repeat(60));
    console.error('Test FAILED ✗');
    console.error('='.repeat(60));
    console.error(error);
    await cleanup();
    process.exit(1);
  }
}

runAllTests();
