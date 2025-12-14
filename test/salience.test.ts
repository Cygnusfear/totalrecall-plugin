/**
 * Tests for salience scoring / memory consolidation (Issue #13)
 * Tests access-based importance, memory decay, and consolidation
 */

import { createSQLiteDatabase, type ISynthesisDatabase } from '../src/db.js';
import {
  calculateAccessScore,
  calculateAccessRecencyScore,
  calculateSalienceScore,
  applySalienceDecay,
  DEFAULT_SALIENCE_CONFIG,
  type SalienceConfig,
} from '../src/db/interface.js';
import type { NodeType } from '../src/schema.js';
import { unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const TEST_DB_PATH = join(tmpdir(), 'totalrecall-salience-test.sqlite');

async function cleanup() {
  if (existsSync(TEST_DB_PATH)) {
    unlinkSync(TEST_DB_PATH);
  }
}

// ============ Unit Tests for Salience Functions ============

function testAccessScore() {
  console.log('Test: Access frequency scoring...');

  const noAccess = calculateAccessScore(0);
  const lowAccess = calculateAccessScore(5);
  const mediumAccess = calculateAccessScore(50);
  const highAccess = calculateAccessScore(500);
  const veryHighAccess = calculateAccessScore(1000);

  if (noAccess !== 0) throw new Error(`Zero access should score 0: ${noAccess}`);
  if (lowAccess >= mediumAccess) throw new Error('More access should score higher');
  if (mediumAccess >= highAccess) throw new Error('More access should score higher');
  if (veryHighAccess > 1.0) throw new Error('Max score should not exceed 1.0');

  console.log('  - Access scoring: PASS');
  console.log(`    0 accesses: ${noAccess.toFixed(3)}`);
  console.log(`    5 accesses: ${lowAccess.toFixed(3)}`);
  console.log(`    50 accesses: ${mediumAccess.toFixed(3)}`);
  console.log(`    500 accesses: ${highAccess.toFixed(3)}`);
  console.log(`    1000 accesses: ${veryHighAccess.toFixed(3)}`);
}

function testAccessRecencyScore() {
  console.log('\nTest: Access recency scoring with decay...');

  const now = Date.now();
  const oneDayAgo = now - 1000 * 60 * 60 * 24;
  const halfLifeAgo = now - 1000 * 60 * 60 * 24 * 90; // 90 days
  const twoHalfLivesAgo = now - 1000 * 60 * 60 * 24 * 180;

  const neverAccessed = calculateAccessRecencyScore(null, 90);
  const recentAccess = calculateAccessRecencyScore(oneDayAgo, 90);
  const halfLifeAccess = calculateAccessRecencyScore(halfLifeAgo, 90);
  const oldAccess = calculateAccessRecencyScore(twoHalfLivesAgo, 90);

  if (neverAccessed !== 0) throw new Error('Never accessed should score 0');
  if (recentAccess < 0.95) throw new Error(`Recent access too low: ${recentAccess}`);
  if (Math.abs(halfLifeAccess - 0.5) > 0.05)
    throw new Error(`Half-life should score ~0.5: ${halfLifeAccess}`);
  if (Math.abs(oldAccess - 0.25) > 0.05)
    throw new Error(`2x half-life should score ~0.25: ${oldAccess}`);

  console.log('  - Access recency decay: PASS');
  console.log(`    Never accessed: ${neverAccessed.toFixed(3)}`);
  console.log(`    1 day ago: ${recentAccess.toFixed(3)}`);
  console.log(`    90 days ago (half-life): ${halfLifeAccess.toFixed(3)}`);
  console.log(`    180 days ago (2x half-life): ${oldAccess.toFixed(3)}`);
}

function testSalienceCalculation() {
  console.log('\nTest: Salience score calculation...');

  // High-salience memory: frequently accessed, recent, many edges, important type
  const highSalience = calculateSalienceScore(100, Date.now() - 1000 * 60 * 60 * 24, 20, 'decision');

  // Low-salience memory: never accessed, no edges, low-importance type
  const lowSalience = calculateSalienceScore(0, null, 0, 'event');

  // Medium-salience memory: some access, moderate age, few edges
  const now = Date.now();
  const thirtyDaysAgo = now - 1000 * 60 * 60 * 24 * 30;
  const mediumSalience = calculateSalienceScore(10, thirtyDaysAgo, 5, 'learning');

  if (highSalience <= lowSalience) throw new Error('High salience should exceed low salience');
  if (mediumSalience <= lowSalience) throw new Error('Medium should exceed low');
  if (mediumSalience >= highSalience) throw new Error('High should exceed medium');
  if (highSalience > 1.0) throw new Error('Salience should not exceed 1.0');
  if (lowSalience < 0.0) throw new Error('Salience should not be negative');

  console.log('  - Salience calculation: PASS');
  console.log(`    High salience (decision, 100 accesses, recent): ${highSalience.toFixed(3)}`);
  console.log(`    Medium salience (learning, 10 accesses, 30d ago): ${mediumSalience.toFixed(3)}`);
  console.log(`    Low salience (event, never accessed): ${lowSalience.toFixed(3)}`);
}

function testSalienceDecay() {
  console.log('\nTest: Salience decay over time...');

  const initialSalience = 0.8;

  // No decay if accessed today
  const noDecay = applySalienceDecay(initialSalience, 0, 90);
  if (noDecay !== initialSalience) throw new Error('Should not decay if just accessed');

  // Half decay at half-life
  const halfLifeDecay = applySalienceDecay(initialSalience, 90, 90);
  const expectedHalfLife = initialSalience * 0.5;
  if (Math.abs(halfLifeDecay - expectedHalfLife) > 0.01)
    throw new Error(`Half-life decay incorrect: ${halfLifeDecay} vs ${expectedHalfLife}`);

  // Quarter at 2x half-life
  const doubleHalfLifeDecay = applySalienceDecay(initialSalience, 180, 90);
  const expectedDouble = initialSalience * 0.25;
  if (Math.abs(doubleHalfLifeDecay - expectedDouble) > 0.01)
    throw new Error(
      `2x half-life decay incorrect: ${doubleHalfLifeDecay} vs ${expectedDouble}`
    );

  console.log('  - Salience decay: PASS');
  console.log(`    No decay (0 days): ${noDecay.toFixed(3)}`);
  console.log(`    Half-life (90 days): ${halfLifeDecay.toFixed(3)}`);
  console.log(`    2x half-life (180 days): ${doubleHalfLifeDecay.toFixed(3)}`);
}

function testCustomSalienceWeights() {
  console.log('\nTest: Custom salience configuration...');

  const now = Date.now();
  const accessCount = 50;
  const lastAccessed = now - 1000 * 60 * 60 * 24 * 30; // 30 days ago
  const edgeCount = 10;
  const nodeType: NodeType = 'learning';

  // Config 1: Heavily prioritize access frequency
  const accessConfig: SalienceConfig = {
    accessWeight: 0.9,
    accessRecencyWeight: 0.05,
    relationshipWeight: 0.025,
    nodeTypeWeight: 0.025,
  };
  const accessFocused = calculateSalienceScore(
    accessCount,
    lastAccessed,
    edgeCount,
    nodeType,
    accessConfig
  );

  // Config 2: Heavily prioritize relationships
  const relationshipConfig: SalienceConfig = {
    accessWeight: 0.05,
    accessRecencyWeight: 0.05,
    relationshipWeight: 0.85,
    nodeTypeWeight: 0.05,
  };
  const relationshipFocused = calculateSalienceScore(
    accessCount,
    lastAccessed,
    edgeCount,
    nodeType,
    relationshipConfig
  );

  // Different configs should produce different scores
  if (Math.abs(accessFocused - relationshipFocused) < 0.01) {
    throw new Error('Different configs should produce different scores');
  }

  console.log('  - Custom weights: PASS');
  console.log(`    Access-focused: ${accessFocused.toFixed(3)}`);
  console.log(`    Relationship-focused: ${relationshipFocused.toFixed(3)}`);
}

// ============ Integration Tests with Database ============

async function testDatabaseSalienceCalculation() {
  console.log('\nTest: Database salience calculation...');

  const db = await createSQLiteDatabase(TEST_DB_PATH);
  const now = Date.now();

  // Create high-salience node: frequent access, recent, many edges
  const highNode = await db.createNode({
    node_type: 'decision',
    one_liner: 'Critical architecture decision',
    summary: 'Decided to use microservices',
    full_synthesis: 'Full details about the decision',
    entity_name: null,
    entity_aliases: null,
    temporal_context: null,
    first_seen: now - 1000 * 60 * 60 * 24 * 7, // 7 days ago
    last_updated: now - 1000 * 60 * 60 * 24 * 7,
    status: null,
    assigned_agent: null,
    priority: null,
    source_session_id: 'test-session',
    source_agent_id: null,
    source_repo: null,
  });

  // Simulate frequent access
  for (let i = 0; i < 50; i++) {
    await db.updateNodeAccess(highNode.id);
  }

  // Create edges to related nodes
  for (let i = 0; i < 15; i++) {
    const relatedNode = await db.createNode({
      node_type: 'learning',
      one_liner: `Related learning ${i}`,
      summary: `Details ${i}`,
      full_synthesis: `Full details ${i}`,
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
      from_node_id: highNode.id,
      to_node_id: relatedNode.id,
      edge_type: 'relates_to',
      weight: 1.0,
      context: null,
    });
  }

  // Create low-salience node: never accessed, old, no edges
  const lowNode = await db.createNode({
    node_type: 'event',
    one_liner: 'Old completed migration',
    summary: 'Database migration from 2 years ago',
    full_synthesis: 'Full details',
    entity_name: null,
    entity_aliases: null,
    temporal_context: null,
    first_seen: now - 1000 * 60 * 60 * 24 * 730, // 2 years ago
    last_updated: now - 1000 * 60 * 60 * 24 * 730,
    status: null,
    assigned_agent: null,
    priority: null,
    source_session_id: 'test-session',
    source_agent_id: null,
    source_repo: null,
  });

  // Calculate salience
  const salienceResults = await db.calculateMemorySalience();

  // Find our nodes in the results
  const highResult = salienceResults.find((r) => r.node_id === highNode.id);
  const lowResult = salienceResults.find((r) => r.node_id === lowNode.id);

  if (!highResult) throw new Error('High-salience node not found in results');
  if (!lowResult) throw new Error('Low-salience node not found in results');

  // Verify high node has higher salience
  if (highResult.salience_score <= lowResult.salience_score) {
    throw new Error(
      `High node should have higher salience: ${highResult.salience_score} vs ${lowResult.salience_score}`
    );
  }

  // High node should have high salience (>0.5)
  if (highResult.salience_score < 0.5) {
    throw new Error(`High node salience too low: ${highResult.salience_score}`);
  }

  // Low node should have low salience (<0.3)
  if (lowResult.salience_score > 0.3) {
    throw new Error(`Low node salience too high: ${lowResult.salience_score}`);
  }

  console.log('  - Database salience calculation: PASS');
  console.log(`    High-salience node: ${highResult.salience_score.toFixed(3)}`);
  console.log(`      - Access count: ${highResult.access_count}`);
  console.log(`      - Edge count: ${highResult.edge_count}`);
  console.log(`    Low-salience node: ${lowResult.salience_score.toFixed(3)}`);
  console.log(`      - Access count: ${lowResult.access_count}`);
  console.log(`      - Edge count: ${lowResult.edge_count}`);

  await db.close();
}

async function testLowSalienceDetection() {
  console.log('\nTest: Low-salience node detection...');

  const db = await createSQLiteDatabase(TEST_DB_PATH);
  const now = Date.now();

  // Create a mix of high and low salience nodes
  const nodes = [];

  // 5 high-salience nodes
  for (let i = 0; i < 5; i++) {
    const node = await db.createNode({
      node_type: 'decision',
      one_liner: `Important decision ${i}`,
      summary: `Details ${i}`,
      full_synthesis: `Full details ${i}`,
      entity_name: null,
      entity_aliases: null,
      temporal_context: null,
      first_seen: now - 1000 * 60 * 60 * 24 * 7,
      last_updated: now - 1000 * 60 * 60 * 24 * 7,
      status: null,
      assigned_agent: null,
      priority: null,
      source_session_id: 'test-session',
      source_agent_id: null,
      source_repo: null,
    });

    // Simulate access
    for (let j = 0; j < 20; j++) {
      await db.updateNodeAccess(node.id);
    }

    nodes.push(node);
  }

  // 10 low-salience nodes
  for (let i = 0; i < 10; i++) {
    const node = await db.createNode({
      node_type: 'event',
      one_liner: `Old event ${i}`,
      summary: `Details ${i}`,
      full_synthesis: `Full details ${i}`,
      entity_name: null,
      entity_aliases: null,
      temporal_context: null,
      first_seen: now - 1000 * 60 * 60 * 24 * 365, // 1 year ago
      last_updated: now - 1000 * 60 * 60 * 24 * 365,
      status: null,
      assigned_agent: null,
      priority: null,
      source_session_id: 'test-session',
      source_agent_id: null,
      source_repo: null,
    });

    nodes.push(node);
  }

  // Get low-salience nodes with default threshold (0.1)
  const lowSalienceNodes = await db.getLowSalienceNodes();

  // Should find mostly low-salience nodes
  if (lowSalienceNodes.length === 0) {
    throw new Error('Should detect some low-salience nodes');
  }

  // All returned nodes should be below threshold
  for (const node of lowSalienceNodes) {
    if (node.salience_score >= DEFAULT_SALIENCE_CONFIG.minSalienceThreshold) {
      throw new Error(
        `Node ${node.node_id} should be below threshold: ${node.salience_score}`
      );
    }
  }

  // Verify sorting (lowest first)
  for (let i = 1; i < lowSalienceNodes.length; i++) {
    if (lowSalienceNodes[i].salience_score < lowSalienceNodes[i - 1].salience_score) {
      throw new Error('Low-salience nodes should be sorted ascending');
    }
  }

  console.log('  - Low-salience detection: PASS');
  console.log(`    Found ${lowSalienceNodes.length} low-salience nodes`);
  console.log(
    `    Lowest salience: ${lowSalienceNodes[0].salience_score.toFixed(3)}`
  );
  if (lowSalienceNodes.length > 1) {
    console.log(
      `    Highest low-salience: ${lowSalienceNodes[lowSalienceNodes.length - 1].salience_score.toFixed(3)}`
    );
  }

  await db.close();
}

async function testSalienceSorting() {
  console.log('\nTest: Salience-based sorting...');

  const db = await createSQLiteDatabase(TEST_DB_PATH);
  const now = Date.now();

  // Create nodes with varying characteristics
  const nodeData = [
    { access: 0, age: 730, edges: 0, type: 'event' as NodeType }, // Very low
    { access: 5, age: 365, edges: 2, type: 'summary' as NodeType }, // Low
    { access: 20, age: 90, edges: 5, type: 'learning' as NodeType }, // Medium
    { access: 50, age: 30, edges: 10, type: 'entity' as NodeType }, // High
    { access: 100, age: 7, edges: 20, type: 'decision' as NodeType }, // Very high
  ];

  for (const data of nodeData) {
    const node = await db.createNode({
      node_type: data.type,
      one_liner: `Node with ${data.access} accesses`,
      summary: 'Summary',
      full_synthesis: 'Full synthesis',
      entity_name: null,
      entity_aliases: null,
      temporal_context: null,
      first_seen: now - 1000 * 60 * 60 * 24 * data.age,
      last_updated: now - 1000 * 60 * 60 * 24 * data.age,
      status: null,
      assigned_agent: null,
      priority: null,
      source_session_id: 'test-session',
      source_agent_id: null,
      source_repo: null,
    });

    // Simulate access
    for (let i = 0; i < data.access; i++) {
      await db.updateNodeAccess(node.id);
    }

    // Create edges
    for (let i = 0; i < data.edges; i++) {
      const relatedNode = await db.createNode({
        node_type: 'learning',
        one_liner: `Related ${i}`,
        summary: 'Summary',
        full_synthesis: 'Full synthesis',
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
        from_node_id: node.id,
        to_node_id: relatedNode.id,
        edge_type: 'relates_to',
        weight: 1.0,
        context: null,
      });
    }
  }

  // Get all nodes sorted by salience
  const results = await db.calculateMemorySalience(undefined, 100);

  // Should be sorted descending
  for (let i = 1; i < results.length; i++) {
    if (results[i].salience_score > results[i - 1].salience_score) {
      throw new Error('Results should be sorted by salience descending');
    }
  }

  // Top node should have highest access count
  const topNode = results[0];
  if (topNode.access_count < 50) {
    throw new Error(`Top node should have high access: ${topNode.access_count}`);
  }

  console.log('  - Salience sorting: PASS');
  console.log(`    Top node: ${topNode.one_liner}`);
  console.log(`      - Salience: ${topNode.salience_score.toFixed(3)}`);
  console.log(`      - Access count: ${topNode.access_count}`);
  console.log(`      - Edge count: ${topNode.edge_count}`);

  await db.close();
}

// ============ Main Test Runner ============

async function runAllTests() {
  console.log('='.repeat(60));
  console.log('Salience Scoring / Memory Consolidation Tests (Issue #13)');
  console.log('='.repeat(60));

  try {
    await cleanup();

    // Unit tests for salience functions
    testAccessScore();
    testAccessRecencyScore();
    testSalienceCalculation();
    testSalienceDecay();
    testCustomSalienceWeights();

    // Integration tests
    await testDatabaseSalienceCalculation();
    await cleanup();

    await testLowSalienceDetection();
    await cleanup();

    await testSalienceSorting();
    await cleanup();

    console.log('\n' + '='.repeat(60));
    console.log('All salience scoring tests PASSED ✓');
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
