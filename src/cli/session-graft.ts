/**
 * CLI: session-graft
 * Called by SessionStart hook to graft current session to synthesis graph
 */

import { getDatabase } from '../db.js';
import { generateSynthesisEmbedding, initEmbeddings } from '../embeddings.js';

async function main() {
  const db = getDatabase();
  await initEmbeddings();

  // Get session info from environment (set by Claude Code hooks)
  const transcriptPath = process.env.TRANSCRIPT_PATH;
  const sessionId = transcriptPath
    ? transcriptPath.split('/').pop()?.replace('.jsonl', '') || `session-${Date.now()}`
    : `session-${Date.now()}`;

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

  // Query recent syntheses for context injection
  const recent = db.queryNodes({ limit: 5, order_by: 'last_updated' });

  // Format for hook output
  const contextMsg =
    recent.length > 0
      ? recent.map((n) => `- [${n.node_type}] ${n.one_liner}`).join('\n')
      : 'No recent synthesis nodes found.';

  // Output hook response
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: `<total_recall_context>
Recent memories:
${contextMsg}

Use synthesis_unfold(node_id) to expand any node.
Use synthesis_search(query) to find specific context.
</total_recall_context>`,
      },
    })
  );

  db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
