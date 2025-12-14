/**
 * CLI: session-graft
 * Called by SessionStart hook to provide context from synthesis graph
 *
 * This ONLY injects context - it does NOT create any nodes.
 * Hooks should NEVER create synthesis nodes directly.
 * All nodes are created by the background synthesis worker via LLM.
 */

import { getDatabase } from '../db.js';
import { readHookInput } from './hook-utils.js';

async function main() {
  const db = getDatabase();

  // Read hook input from stdin (Claude Code delivers data this way)
  const input = await readHookInput();
  const sessionId = input?.session_id || `session-${Date.now()}`;

  // FAST: Query recent syntheses for context injection
  const recent = await db.queryNodes({ limit: 5, order_by: 'last_updated' });

  // Format for hook output
  const contextMsg =
    recent.length > 0
      ? recent.map((n) => `- [${n.node_type}] ${n.one_liner}`).join('\n')
      : 'No recent synthesis nodes found.';

  // Output hook response immediately
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

  await db.close();

  // NOTE: We no longer spawn session-init here.
  // session-init was creating garbage "Session started: timestamp" nodes.
  // Hooks should NEVER create synthesis nodes directly.
  // All real nodes are created by the background synthesis worker via LLM.
}

main().catch((e) => {
  console.error('[session-graft] Error:', e);
  process.exit(1);
});
