/**
 * CLI: session-init
 * Background process to create session node and generate embedding
 * Called by session-graft via detached spawn for non-blocking boot
 */

import { getDatabase } from '../db.js';
import { generateSynthesisEmbedding, initEmbeddings } from '../embeddings.js';

async function main() {
  const sessionId = process.env.SESSION_ID;
  if (!sessionId) {
    console.error('SESSION_ID not provided');
    process.exit(1);
  }

  const db = getDatabase();
  await initEmbeddings();

  const now = Date.now();

  // Create session node
  const sessionNode = db.createNode({
    node_type: 'summary',
    one_liner: `Session started: ${new Date(now).toISOString()}`,
    summary: `Session grafted at ${new Date(now).toISOString()}`,
    full_synthesis: `Session ${sessionId} started.`,
    entity_name: null,
    entity_aliases: null,
    temporal_context: `session start: ${new Date(now).toISOString()}`,
    first_seen: now,
    last_updated: now,
    status: null,
    assigned_agent: null,
    priority: null,
    source_session_id: sessionId,
    source_agent_id: null,
    source_repo: null,
  });

  // Generate embedding
  try {
    const embedding = await generateSynthesisEmbedding(
      sessionNode.one_liner,
      sessionNode.summary,
      'summary'
    );
    db.insertEmbedding(sessionNode.id, embedding);
  } catch (e) {
    console.error('Failed to generate embedding:', e);
  }

  db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
