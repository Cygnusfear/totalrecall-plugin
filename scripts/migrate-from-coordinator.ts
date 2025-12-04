#!/usr/bin/env bun
/**
 * Migration script: Coordinator DB -> Plugin DB
 *
 * Usage:
 *   bun scripts/migrate-from-coordinator.ts /path/to/coordinator.db
 *
 * What it does:
 *   1. Copies synthesis_nodes (without embedding column)
 *   2. Copies synthesis_edges
 *   3. Copies raw_content
 *   4. Copies synthesis_queue
 *   5. Copies progressive_disclosure_events
 *   6. Regenerates embeddings for all nodes
 */

import { Database } from 'bun:sqlite';
import { getDatabase } from '../src/db.js';
import { generateSynthesisEmbedding, initEmbeddings } from '../src/embeddings.js';

const BATCH_SIZE = 50;

async function migrate(coordinatorDbPath: string) {
  console.log('=== TotalRecall Migration: Coordinator -> Plugin ===\n');

  // Open coordinator DB (read-only)
  const coordDb = new Database(coordinatorDbPath, { readonly: true });
  console.log(`Source: ${coordinatorDbPath}`);

  // Open plugin DB
  const pluginDb = getDatabase();
  console.log(`Target: ~/.config/totalrecall/synthesis.sqlite\n`);

  // Get counts
  const counts = {
    nodes: coordDb.prepare('SELECT COUNT(*) as c FROM synthesis_nodes').get() as { c: number },
    edges: coordDb.prepare('SELECT COUNT(*) as c FROM synthesis_edges').get() as { c: number },
    raw: coordDb.prepare('SELECT COUNT(*) as c FROM raw_content').get() as { c: number },
    queue: coordDb.prepare('SELECT COUNT(*) as c FROM synthesis_queue').get() as { c: number },
    events: coordDb.prepare('SELECT COUNT(*) as c FROM progressive_disclosure_events').get() as { c: number },
  };

  console.log('Data to migrate:');
  console.log(`  synthesis_nodes: ${counts.nodes.c}`);
  console.log(`  synthesis_edges: ${counts.edges.c}`);
  console.log(`  raw_content: ${counts.raw.c}`);
  console.log(`  synthesis_queue: ${counts.queue.c}`);
  console.log(`  progressive_disclosure_events: ${counts.events.c}`);
  console.log('');

  // 1. Migrate synthesis_nodes
  console.log('Migrating synthesis_nodes...');
  const nodes = coordDb.prepare(`
    SELECT id, node_type, one_liner, summary, full_synthesis,
           entity_name, entity_aliases, temporal_context,
           first_seen, last_updated, status, assigned_agent, priority,
           source_session_id, source_agent_id, source_repo,
           access_count, last_accessed, created_at, updated_at
    FROM synthesis_nodes
  `).all() as Array<{
    id: string;
    node_type: string;
    one_liner: string;
    summary: string;
    full_synthesis: string;
    entity_name: string | null;
    entity_aliases: string | null;
    temporal_context: string | null;
    first_seen: number;
    last_updated: number;
    status: string | null;
    assigned_agent: string | null;
    priority: number | null;
    source_session_id: string | null;
    source_agent_id: string | null;
    source_repo: string | null;
    access_count: number;
    last_accessed: number | null;
    created_at: number;
    updated_at: number;
  }>;

  const insertNode = pluginDb.db.prepare(`
    INSERT OR REPLACE INTO synthesis_nodes (
      id, node_type, one_liner, summary, full_synthesis,
      entity_name, entity_aliases, temporal_context,
      first_seen, last_updated, status, assigned_agent, priority,
      source_session_id, source_agent_id, source_repo,
      access_count, last_accessed, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const node of nodes) {
    insertNode.run(
      node.id, node.node_type, node.one_liner, node.summary, node.full_synthesis,
      node.entity_name, node.entity_aliases, node.temporal_context,
      node.first_seen, node.last_updated, node.status, node.assigned_agent, node.priority,
      node.source_session_id, node.source_agent_id, node.source_repo,
      node.access_count, node.last_accessed, node.created_at, node.updated_at
    );
  }
  console.log(`  Migrated ${nodes.length} nodes`);

  // 2. Migrate synthesis_edges
  console.log('Migrating synthesis_edges...');
  const edges = coordDb.prepare(`
    SELECT from_node_id, to_node_id, edge_type, weight, context, created_at
    FROM synthesis_edges
  `).all() as Array<{
    from_node_id: string;
    to_node_id: string;
    edge_type: string;
    weight: number;
    context: string | null;
    created_at: number;
  }>;

  const insertEdge = pluginDb.db.prepare(`
    INSERT INTO synthesis_edges (from_node_id, to_node_id, edge_type, weight, context, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  for (const edge of edges) {
    try {
      insertEdge.run(edge.from_node_id, edge.to_node_id, edge.edge_type, edge.weight, edge.context, edge.created_at);
    } catch (e) {
      // Skip duplicate edges
    }
  }
  console.log(`  Migrated ${edges.length} edges`);

  // 3. Migrate raw_content
  console.log('Migrating raw_content...');
  const rawContent = coordDb.prepare(`
    SELECT id, session_id, synthesis_node_id, content_type, content,
           agent_id, timestamp, message_index, created_at
    FROM raw_content
  `).all() as Array<{
    id: string;
    session_id: string;
    synthesis_node_id: string | null;
    content_type: string;
    content: string;
    agent_id: string | null;
    timestamp: number;
    message_index: number | null;
    created_at: number;
  }>;

  const insertRaw = pluginDb.db.prepare(`
    INSERT OR REPLACE INTO raw_content (
      id, session_id, synthesis_node_id, content_type, content,
      agent_id, timestamp, message_index, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const raw of rawContent) {
    insertRaw.run(
      raw.id, raw.session_id, raw.synthesis_node_id, raw.content_type, raw.content,
      raw.agent_id, raw.timestamp, raw.message_index, raw.created_at
    );
  }
  console.log(`  Migrated ${rawContent.length} raw_content entries`);

  // 4. Migrate synthesis_queue
  console.log('Migrating synthesis_queue...');
  const queue = coordDb.prepare(`
    SELECT session_id, agent_id, chunk_type, raw_content_ids, context,
           message_count, status, retry_count, error, synthesis_node_id,
           created_at, started_at, completed_at
    FROM synthesis_queue
  `).all() as Array<{
    session_id: string;
    agent_id: string | null;
    chunk_type: string;
    raw_content_ids: string;
    context: string | null;
    message_count: number | null;
    status: string;
    retry_count: number;
    error: string | null;
    synthesis_node_id: string | null;
    created_at: number;
    started_at: number | null;
    completed_at: number | null;
  }>;

  const insertQueue = pluginDb.db.prepare(`
    INSERT INTO synthesis_queue (
      session_id, agent_id, chunk_type, raw_content_ids, context,
      message_count, status, retry_count, error, synthesis_node_id,
      created_at, started_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const q of queue) {
    try {
      insertQueue.run(
        q.session_id, q.agent_id, q.chunk_type, q.raw_content_ids, q.context,
        q.message_count, q.status, q.retry_count, q.error, q.synthesis_node_id,
        q.created_at, q.started_at, q.completed_at
      );
    } catch (e) {
      // Skip duplicates
    }
  }
  console.log(`  Migrated ${queue.length} queue items`);

  // 5. Migrate progressive_disclosure_events
  console.log('Migrating progressive_disclosure_events...');
  const events = coordDb.prepare(`
    SELECT event_type, session_id, agent_id, query_text, search_latency_ms,
           results_count, node_ids, injection_tokens, expanded_node_id,
           expansion_tokens, message_tokens, created_at
    FROM progressive_disclosure_events
  `).all() as Array<{
    event_type: string;
    session_id: string | null;
    agent_id: string | null;
    query_text: string | null;
    search_latency_ms: number | null;
    results_count: number | null;
    node_ids: string | null;
    injection_tokens: number | null;
    expanded_node_id: string | null;
    expansion_tokens: number | null;
    message_tokens: number | null;
    created_at: number;
  }>;

  const insertEvent = pluginDb.db.prepare(`
    INSERT INTO progressive_disclosure_events (
      event_type, session_id, agent_id, query_text, search_latency_ms,
      results_count, node_ids, injection_tokens, expanded_node_id,
      expansion_tokens, message_tokens, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const e of events) {
    try {
      insertEvent.run(
        e.event_type, e.session_id, e.agent_id, e.query_text, e.search_latency_ms,
        e.results_count, e.node_ids, e.injection_tokens, e.expanded_node_id,
        e.expansion_tokens, e.message_tokens, e.created_at
      );
    } catch (err) {
      // Skip duplicates
    }
  }
  console.log(`  Migrated ${events.length} events`);

  // 6. Regenerate embeddings
  console.log('\nRegenerating embeddings (this may take a while)...');
  await initEmbeddings();

  let embedded = 0;
  let failed = 0;

  for (let i = 0; i < nodes.length; i += BATCH_SIZE) {
    const batch = nodes.slice(i, i + BATCH_SIZE);

    for (const node of batch) {
      try {
        const embedding = await generateSynthesisEmbedding(
          node.one_liner,
          node.summary,
          node.node_type
        );
        pluginDb.insertEmbedding(node.id, embedding);
        embedded++;
      } catch (e) {
        failed++;
      }
    }

    process.stdout.write(`\r  Progress: ${Math.min(i + BATCH_SIZE, nodes.length)}/${nodes.length} (${failed} failed)`);
  }
  console.log(`\n  Generated ${embedded} embeddings, ${failed} failed`);

  // Close
  coordDb.close();
  pluginDb.close();

  console.log('\n=== Migration Complete ===');
  console.log(`Total: ${nodes.length} nodes, ${edges.length} edges, ${rawContent.length} raw, ${queue.length} queue, ${events.length} events`);
}

// Main
const coordPath = process.argv[2];
if (!coordPath) {
  console.error('Usage: npx tsx scripts/migrate-from-coordinator.ts /path/to/coordinator.db');
  process.exit(1);
}

migrate(coordPath).catch((e) => {
  console.error('Migration failed:', e);
  process.exit(1);
});
