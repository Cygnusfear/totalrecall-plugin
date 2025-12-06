/**
 * CLI: status
 * Check system status including graph health
 */

import { getDatabase } from '../db.js';

async function main() {
  const db = getDatabase();

  const nodes = db.queryNodes({ limit: 10000 });
  const queueItems = db.getSynthesisQueueItems({ limit: 1000 });
  const orphans = db.getOrphanNodes();

  const pending = queueItems.filter((i) => i.status === 'pending').length;
  const processing = queueItems.filter((i) => i.status === 'processing').length;
  const completed = queueItems.filter((i) => i.status === 'completed').length;
  const failed = queueItems.filter((i) => i.status === 'failed').length;

  // Count edges (approximate via edge count on nodes)
  let totalEdges = 0;
  for (const node of nodes.slice(0, 100)) {
    totalEdges += db.getEdgeCount(node.id);
  }
  // Edges are counted twice (from and to), so divide
  const estimatedEdges = Math.round((totalEdges / 100) * nodes.length / 2);
  const edgesPerNode = nodes.length > 0 ? (estimatedEdges / nodes.length).toFixed(2) : '0.00';

  console.log('Total Recall Status');
  console.log('==================');
  console.log('');
  console.log('Graph Health:');
  console.log(`  Synthesis nodes:  ${nodes.length}`);
  console.log(`  Estimated edges:  ~${estimatedEdges}`);
  console.log(`  Edges per node:   ~${edgesPerNode}`);
  console.log(`  Orphan nodes:     ${orphans.length} (${((orphans.length / nodes.length) * 100).toFixed(1)}%)`);

  if (orphans.length > 50) {
    console.log('');
    console.log('  ⚠️  High orphan count! Run: totalrecall rebuild-relationships --orphans-only');
  }

  console.log('');
  console.log('Queue Status:');
  console.log(`  Pending:    ${pending}`);
  console.log(`  Processing: ${processing}`);
  console.log(`  Completed:  ${completed}`);
  console.log(`  Failed:     ${failed}`);
  console.log('');
  console.log(`Worker: ${process.env.ANTHROPIC_API_KEY ? 'Enabled' : 'Disabled (no API key)'}`);

  db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
