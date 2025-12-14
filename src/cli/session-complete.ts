/**
 * CLI: session-complete
 * Called by SessionEnd hook to ensure final transcript content is captured
 *
 * This NO LONGER creates garbage "Session complete: N nodes" summaries.
 * Instead, it ensures the transcript is queued for synthesis (catching any final exchanges).
 */

import { spawn } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { readHookInput } from './hook-utils.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliPath = join(__dirname, '..', '..', 'cli', 'totalrecall.js');

async function main() {
  // Read hook input from stdin (Claude Code delivers data this way)
  const input = await readHookInput();
  const sessionId = input?.session_id || `session-${Date.now()}`;

  // Run queue-synthesis to capture any final transcript content
  // This ensures the last exchanges are queued for the background worker
  spawn('node', [cliPath, 'queue-synthesis'], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, SESSION_ID: sessionId },
  }).unref();

  // That's it - no garbage "Session complete" nodes
  // The background synthesis worker will create REAL nodes from the transcript
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
