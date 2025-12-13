/**
 * CLI: session-graft
 * Called by SessionStart hook to provide context and graft session to synthesis graph
 *
 * Fast path: Query existing nodes and output context immediately
 * Background: Spawn session-init to create node + embedding (non-blocking)
 */

import { spawn } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { getDatabase } from '../db.js';
import { readHookInput } from './hook-utils.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliPath = join(__dirname, '..', '..', 'cli', 'totalrecall.js');

async function main() {
  const db = getDatabase();

  // Read hook input from stdin (Claude Code delivers data this way)
  const input = await readHookInput();
  const sessionId = input?.session_id || `session-${Date.now()}`;

  // FAST: Query recent syntheses for context injection
  const recent = db.queryNodes({ limit: 5, order_by: 'last_updated' });

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

  db.close();

  // BACKGROUND: Spawn session-init to create node + embedding (non-blocking)
  spawn('node', [cliPath, 'session-init'], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, SESSION_ID: sessionId },
  }).unref();
}

main().catch((e) => {
  console.error('[session-graft] Error:', e);
  process.exit(1);
});
