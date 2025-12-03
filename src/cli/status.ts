/**
 * CLI: status
 * Check system status
 */

import { getDatabase } from '../db.js';

async function main() {
  const db = getDatabase();

  const nodes = db.queryNodes({ limit: 1000 });
  const queueItems = db.getSynthesisQueueItems({ limit: 1000 });

  const pending = queueItems.filter((i) => i.status === 'pending').length;
  const processing = queueItems.filter((i) => i.status === 'processing').length;
  const completed = queueItems.filter((i) => i.status === 'completed').length;
  const failed = queueItems.filter((i) => i.status === 'failed').length;

  console.log('Total Recall Status');
  console.log('==================');
  console.log(`Synthesis nodes: ${nodes.length}`);
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
