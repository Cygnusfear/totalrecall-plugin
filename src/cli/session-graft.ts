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
import { createCoreMemoryService } from '../lib/core-memory.js';
import { createContextFormatter, type FormattedMemory } from '../lib/context-formatter.js';

async function main() {
  const db = getDatabase();

  try {
    // Read hook input from stdin (Claude Code delivers data this way)
    const input = await readHookInput();

    // FAST: Query recent syntheses for context injection
    const recent = await db.queryNodes({ limit: 5, order_by: 'last_updated' });

    // Get core memory blocks (persona, human)
    const coreMemoryService = createCoreMemoryService(db);
    const coreMemory = await coreMemoryService.getBlocks();

    // Format memories for injection
    const formattedMemories: FormattedMemory[] = recent.map((n) => ({
      content: n.one_liner,
      type: n.node_type,
      source: 'memory',
      confidence: 1.0, // Recent memories have high relevance
      ageMs: Date.now() - n.last_updated,
      nodeId: n.id,
      oneLiner: n.one_liner,
    }));

    // Use context formatter for consistent output
    const formatter = createContextFormatter();
    const formattedContext = formatter.formatForInjection(formattedMemories, coreMemory, {
      verbosity: 'standard',
      includeCoreMemory: true,
      includeNodeIds: true,
    });

    // Fallback if formatter returns empty
    const contextOutput =
      formattedContext ||
      `<total_recall_context>
No memories found. Use synthesis_search(query) to find specific context.
</total_recall_context>`;

    // Output hook response immediately
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: contextOutput,
        },
      })
    );
  } finally {
    await db.close();
  }

  // NOTE: We no longer spawn session-init here.
  // session-init was creating garbage "Session started: timestamp" nodes.
  // Hooks should NEVER create synthesis nodes directly.
  // All real nodes are created by the background synthesis worker via LLM.
}

main().catch((e) => {
  console.error('[session-graft] Error:', e);
  process.exit(1);
});
