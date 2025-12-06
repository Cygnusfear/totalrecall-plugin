/**
 * CLI: rebuild-relationships
 * Rebuild graph edges for orphan or all nodes
 *
 * Supports two modes:
 * 1. Semantic similarity only (fast, may have false positives)
 * 2. LLM-validated (slower, more accurate - uses Claude to verify relationships)
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { getDatabase } from '../db.js';
import { initEmbeddings } from '../embeddings.js';
import { RelationshipBuilder } from '../lib/relationship-builder.js';
import { getTotalRecallDir } from '../paths.js';

// Lock file to prevent multiple instances
const LOCK_FILE = join(getTotalRecallDir(), 'rebuild-relationships.lock');
const LOCK_STALE_MS = 4 * 60 * 60 * 1000; // 4 hours - consider lock stale after this

function acquireLock(): boolean {
  try {
    if (existsSync(LOCK_FILE)) {
      const lockData = JSON.parse(readFileSync(LOCK_FILE, 'utf-8'));
      const lockAge = Date.now() - lockData.timestamp;

      // Check if lock is stale
      if (lockAge > LOCK_STALE_MS) {
        console.warn(`Stale lock found (${(lockAge / 1000 / 60).toFixed(0)} min old), removing...`);
        unlinkSync(LOCK_FILE);
      } else {
        // Check if process is still running
        try {
          process.kill(lockData.pid, 0); // Signal 0 = check if process exists
          return false; // Process still running
        } catch {
          // Process not running, lock is orphaned
          console.warn(`Orphaned lock found (PID ${lockData.pid} not running), removing...`);
          unlinkSync(LOCK_FILE);
        }
      }
    }

    // Create lock file
    writeFileSync(LOCK_FILE, JSON.stringify({
      pid: process.pid,
      timestamp: Date.now(),
      started: new Date().toISOString(),
    }));
    return true;
  } catch (e) {
    console.error('Failed to acquire lock:', e);
    return false;
  }
}

function releaseLock(): void {
  try {
    if (existsSync(LOCK_FILE)) {
      const lockData = JSON.parse(readFileSync(LOCK_FILE, 'utf-8'));
      // Only release if we own the lock
      if (lockData.pid === process.pid) {
        unlinkSync(LOCK_FILE);
      }
    }
  } catch {
    // Ignore errors during cleanup
  }
}

// Ensure lock is released on exit
process.on('exit', releaseLock);
process.on('SIGINT', () => { releaseLock(); process.exit(130); });
process.on('SIGTERM', () => { releaseLock(); process.exit(143); });

function parseArgs(args: string[]) {
  const result: Record<string, string | boolean> = {};

  for (const arg of args) {
    if (arg.startsWith('--')) {
      const [key, value] = arg.slice(2).split('=');
      result[key] = value ?? true;
    }
  }

  return result;
}

function printHelp() {
  console.log(`Total Recall - Rebuild Relationships

Usage: totalrecall rebuild-relationships [OPTIONS]

Modes (pick one):
  --orphans-only         Only rebuild relationships for orphan nodes (RECOMMENDED)
  --full                 Rebuild relationships for all nodes (SLOW)
  --session-id=<id>      Rebuild relationships for specific session

Options:
  --dry-run              Show what would be done without making changes
  --use-llm              Use Claude to validate relationships (slower but accurate)
  --min-similarity=0.5   Minimum similarity score for candidates (default: 0.5)
  --max-edges=5          Max edges to create per node (default: 5)
  --batch-size=50        Nodes to process per batch (default: 50)
  --verbose              Show detailed progress

LLM Mode:
  When --use-llm is enabled:
  - Each candidate pair is sent to Claude for validation
  - Claude determines: is this a real relationship? what type?
  - Spurious matches (keyword overlap only) are rejected
  - Uses Claude CLI (subscription) if no API key set

  Without --use-llm:
  - Relationships are based on embedding similarity only
  - Faster but may create false positive connections

Examples:
  # Preview what would be done (no changes)
  totalrecall rebuild-relationships --orphans-only --dry-run

  # Fast rebuild using similarity only
  totalrecall rebuild-relationships --orphans-only

  # Accurate rebuild with LLM validation (recommended for production)
  totalrecall rebuild-relationships --orphans-only --use-llm --verbose

  # Full rebuild with LLM (very slow, use for initial setup)
  totalrecall rebuild-relationships --full --use-llm --batch-size=10 --verbose
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Check for help first
  if (args['help'] === true || args['h'] === true) {
    printHelp();
    process.exit(0);
  }

  // Acquire lock to prevent multiple instances
  if (!acquireLock()) {
    console.error('ERROR: Another rebuild-relationships process is already running.');
    console.error(`Lock file: ${LOCK_FILE}`);
    console.error('If you believe this is a mistake, delete the lock file and try again.');
    process.exit(1);
  }
  console.log(`Lock acquired (PID ${process.pid})\n`);

  const dryRun = args['dry-run'] === true;
  const orphansOnly = args['orphans-only'] === true;
  const full = args['full'] === true;
  const verbose = args['verbose'] === true;
  const useLLM = args['use-llm'] === true;
  const sessionId = typeof args['session-id'] === 'string' ? args['session-id'] : undefined;
  const minSimilarity = typeof args['min-similarity'] === 'string'
    ? parseFloat(args['min-similarity'])
    : 0.5;
  const maxEdges = typeof args['max-edges'] === 'string'
    ? parseInt(args['max-edges'])
    : 5;
  const batchSize = typeof args['batch-size'] === 'string'
    ? parseInt(args['batch-size'])
    : 50;

  if (!orphansOnly && !full && !sessionId) {
    printHelp();
    process.exit(0);
  }

  console.log('Total Recall - Rebuild Relationships');
  console.log('====================================\n');

  if (dryRun) {
    console.log('DRY RUN MODE - No changes will be made\n');
  }

  console.log('Configuration:');
  console.log(`  Min similarity: ${minSimilarity}`);
  console.log(`  Max edges/node: ${maxEdges}`);
  console.log(`  Batch size:     ${batchSize}`);
  console.log(`  LLM validation: ${useLLM ? 'ENABLED (accurate but slower)' : 'disabled (fast)'}`);
  console.log('');

  const db = getDatabase();

  // Show initial stats
  const orphansBefore = db.getOrphanNodes();
  const totalNodes = db.queryNodes({ limit: 10000 }).length;
  console.log(`Initial state:`);
  console.log(`  Total nodes:  ${totalNodes}`);
  console.log(`  Orphan nodes: ${orphansBefore.length} (${((orphansBefore.length / totalNodes) * 100).toFixed(1)}%)`);
  console.log('');

  console.log('Loading embedding model...');
  await initEmbeddings();

  const builder = new RelationshipBuilder(db, {
    minSimilarity,
    maxEdgesPerNode: maxEdges,
    batchSize,
    dryRun,
    verbose,
    useLLM,
  });

  const startTime = Date.now();
  let stats;

  try {
    if (sessionId) {
      console.log(`\nMode: Rebuild session ${sessionId}\n`);
      stats = await builder.rebuildSession(sessionId);
    } else if (orphansOnly) {
      console.log('\nMode: Rebuild orphans only\n');
      stats = await builder.rebuildOrphans();
    } else if (full) {
      console.log('\nMode: Full rebuild (all nodes)\n');
      stats = await builder.rebuildAll();
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log('\n====================================');
    console.log('Rebuild Complete');
    console.log('====================================');
    console.log(`Nodes processed:      ${stats!.nodesProcessed}`);
    console.log(`Edges created:        ${stats!.edgesCreated}`);
    if (useLLM) {
      console.log(`Rejected by LLM:      ${stats!.edgesRejectedByLLM}`);
    }
    console.log(`Duplicates skipped:   ${stats!.duplicatesSkipped}`);
    console.log(`Orphans fixed:        ${stats!.orphansFixed}`);
    console.log(`Errors:               ${stats!.errors}`);
    console.log(`Duration:             ${duration}s`);

    if (stats!.backupPath) {
      console.log('');
      console.log(`Backup created:       ${stats!.backupPath}`);
    }

    if (!dryRun) {
      const orphansAfter = db.getOrphanNodes();
      console.log('');
      console.log(`Final state:`);
      console.log(`  Orphan nodes: ${orphansAfter.length} (${((orphansAfter.length / totalNodes) * 100).toFixed(1)}%)`);
      console.log(`  Reduction:    ${orphansBefore.length - orphansAfter.length} nodes connected`);
    }

    if (dryRun) {
      console.log('\nDRY RUN - No changes were made. Remove --dry-run to apply changes.');
    }
  } catch (error) {
    console.error('Error during rebuild:', error);
    process.exit(1);
  } finally {
    db.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
