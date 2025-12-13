/**
 * CLI: session-complete
 * Called by SessionEnd hook to create session summary
 */

import { getDatabase } from '../db.js';
import { generateSynthesisEmbedding, initEmbeddings } from '../embeddings.js';

async function main() {
  const db = getDatabase();
  await initEmbeddings();

  const transcriptPath = process.env.TRANSCRIPT_PATH;
  const sessionId = transcriptPath
    ? transcriptPath.split('/').pop()?.replace('.jsonl', '') || `session-${Date.now()}`
    : `session-${Date.now()}`;

  const now = Date.now();

  // Get syntheses created during this session
  const sessionSyntheses = db.queryNodes({
    session_id: sessionId,
    limit: 100,
    order_by: 'created_at',
  });

  if (sessionSyntheses.length === 0) {
    console.log('No syntheses created during this session');
    db.close();
    return;
  }

  // Create summary of what was accomplished
  const decisions = sessionSyntheses.filter((s) => s.node_type === 'decision');
  const learnings = sessionSyntheses.filter((s) => s.node_type === 'learning');

  const summaryParts = [];
  if (decisions.length > 0) {
    summaryParts.push(`Made ${decisions.length} decision(s)`);
  }
  if (learnings.length > 0) {
    summaryParts.push(`Captured ${learnings.length} learning(s)`);
  }

  const summary =
    summaryParts.length > 0
      ? summaryParts.join(', ')
      : `Created ${sessionSyntheses.length} synthesis node(s)`;

  // Create session completion node
  const completionNode = db.createNode({
    node_type: 'summary',
    one_liner: `Session complete: ${summary}`,
    summary: `Session ${sessionId} completed at ${new Date(now).toISOString()}. ${summary}.`,
    full_synthesis: `Session ${sessionId} completed.\n\nSyntheses created:\n${sessionSyntheses.map((s) => `- [${s.node_type}] ${s.one_liner}`).join('\n')}`,
    entity_name: null,
    entity_aliases: null,
    temporal_context: `session end: ${new Date(now).toISOString()}`,
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
      completionNode.one_liner,
      completionNode.summary,
      'summary'
    );
    db.insertEmbedding(completionNode.id, embedding);
  } catch (e) {
    console.error('Failed to generate embedding:', e);
  }

  // Link to session syntheses
  for (const synthesis of sessionSyntheses.slice(0, 10)) {
    db.createEdge({
      from_node_id: completionNode.id,
      to_node_id: synthesis.id,
      edge_type: 'contains',
      weight: 1.0,
      context: 'session summary',
    });
  }

  console.log(`Session complete: ${completionNode.id}`);
  db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
