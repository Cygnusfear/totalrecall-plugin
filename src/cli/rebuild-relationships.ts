/**
 * CLI: rebuild-relationships
 * Rebuild graph edges for orphan or all nodes
 */

import { getDatabase } from '../db.js';
import { initEmbeddings } from '../embeddings.js';
import { RelationshipBuilder } from '../lib/relationship-builder.js';

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

Options:
  --dry-run              Show what would be done without making changes
  --orphans-only         Only rebuild relationships for orphan nodes (RECOMMENDED)
  --full                 Rebuild relationships for all nodes (SLOW)
  --session-id=<id>      Rebuild relationships for specific session
  --min-similarity=0.5   Minimum similarity score for relationships (default: 0.5)
  --max-edges=5          Max edges to create per node (default: 5)
  --batch-size=50        Nodes to process per batch (default: 50)
  --verbose              Show detailed progress

Examples:
  # Dry run to see what would be done
  totalrecall rebuild-relationships --orphans-only --dry-run

  # Rebuild relationships for orphan nodes
  totalrecall rebuild-relationships --orphans-only

  # Rebuild for specific session
  totalrecall rebuild-relationships --session-id=abc-123

  # Full rebuild (SLOW)
  totalrecall rebuild-relationships --full --verbose
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const dryRun = args['dry-run'] === true;
  const orphansOnly = args['orphans-only'] === true;
  const full = args['full'] === true;
  const verbose = args['verbose'] === true;
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
    console.log(`Duplicates skipped:   ${stats!.duplicatesSkipped}`);
    console.log(`Orphans fixed:        ${stats!.orphansFixed}`);
    console.log(`Errors:               ${stats!.errors}`);
    console.log(`Duration:             ${duration}s`);

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
