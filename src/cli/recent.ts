/**
 * CLI: recent
 * Get recent synthesis nodes
 */

import { getDatabase } from '../db.js';

async function main() {
  const args = process.argv.slice(2);
  const limit = parseInt(args.find((a) => a.startsWith('--limit='))?.split('=')[1] || '5');
  const format = args.find((a) => a.startsWith('--format='))?.split('=')[1] || 'text';

  const db = getDatabase();
  const nodes = await db.queryNodes({ limit, order_by: 'last_updated' });

  if (format === 'json') {
    console.log(JSON.stringify(nodes, null, 2));
  } else {
    for (const node of nodes) {
      console.log(`[${node.node_type}] ${node.one_liner}`);
    }
  }

  await db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
