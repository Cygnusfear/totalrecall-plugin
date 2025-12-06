#!/usr/bin/env bun
/**
 * Total Recall CLI
 *
 * Commands:
 *   session-graft     - Graft session to synthesis graph (for hooks)
 *   session-complete  - Complete session with summary (for hooks)
 *   queue-synthesis   - Queue current session for synthesis (for hooks)
 *   backfill          - Backfill unprocessed conversations
 *   recent            - Get recent synthesis nodes
 *   search            - Search synthesis by query
 *   status            - Check system status
 *   worker            - Run standalone synthesis worker (foreground)
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { spawn } from 'child_process';
import { existsSync, realpathSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(realpathSync(__filename));

const [, , command, ...args] = process.argv;

function runCommand(scriptPath, cmdArgs) {
  return new Promise((resolve, reject) => {
    if (!existsSync(scriptPath)) {
      reject(new Error(`Script not found: ${scriptPath}`));
      return;
    }

    const child = spawn('bun', [scriptPath, ...cmdArgs], {
      stdio: 'inherit',
    });

    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Command failed with exit code ${code}`));
    });

    child.on('error', (err) => {
      reject(new Error(`Failed to run command: ${err.message}`));
    });
  });
}

function runBackground(scriptPath, cmdArgs) {
  const child = spawn('bun', [scriptPath, ...cmdArgs], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  console.log('Started in background...');
}

async function main() {
  const srcDir = join(__dirname, '..', 'src');

  try {
    switch (command) {
      case 'session-graft':
        await runCommand(join(srcDir, 'cli', 'session-graft.ts'), args);
        break;

      case 'session-complete':
        await runCommand(join(srcDir, 'cli', 'session-complete.ts'), args);
        break;

      case 'queue-synthesis':
        await runCommand(join(srcDir, 'cli', 'queue-synthesis.ts'), args);
        break;

      case 'backfill':
        if (args.includes('--background')) {
          const filteredArgs = args.filter((a) => a !== '--background');
          runBackground(join(srcDir, 'cli', 'backfill.ts'), filteredArgs);
        } else {
          await runCommand(join(srcDir, 'cli', 'backfill.ts'), args);
        }
        break;

      case 'session-init':
        // Internal command for background session node creation
        await runCommand(join(srcDir, 'cli', 'session-init.ts'), args);
        break;

      case 'recent':
        await runCommand(join(srcDir, 'cli', 'recent.ts'), args);
        break;

      case 'search':
        await runCommand(join(srcDir, 'cli', 'search.ts'), args);
        break;

      case 'status':
        await runCommand(join(srcDir, 'cli', 'status.ts'), args);
        break;

      case 'worker':
        // Run standalone worker (foreground, for systemd)
        await runCommand(join(srcDir, 'standalone-worker.ts'), args);
        break;

      case '--help':
      case '-h':
      case undefined:
        console.log(`Total Recall CLI

Usage: totalrecall <command> [options]

Hook Commands (called automatically):
  session-graft       Graft session to synthesis graph
  session-complete    Complete session with summary
  queue-synthesis     Queue current session for background synthesis
  backfill            Backfill unprocessed conversations
                      Use --background to run in background

User Commands:
  recent              Get recent synthesis nodes
                      --limit=N  Max nodes (default: 5)
                      --format=json|text
  search <query>      Search synthesis by semantic similarity
  status              Check system status

Worker Commands:
  worker              Run standalone synthesis worker (foreground)

Environment:
  ANTHROPIC_API_KEY   Required for background synthesis
  TRANSCRIPT_PATH     Set by Claude Code hooks
`);
        break;

      default:
        console.error(`Unknown command: ${command}`);
        console.error('Try: totalrecall --help');
        process.exit(1);
    }
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`Unexpected error: ${error.message}`);
  process.exit(1);
});
