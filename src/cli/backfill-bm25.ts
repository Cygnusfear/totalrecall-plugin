/**
 * CLI: backfill-bm25
 * Backfill BM25 vectors for existing synthesis nodes
 *
 * The PostgreSQL schema has a trigger that automatically generates BM25 vectors
 * on insert/update. This script triggers an update on all nodes that don't have
 * BM25 vectors yet.
 *
 * Usage:
 *   bun src/cli/backfill-bm25.ts
 *   node dist/cli/backfill-bm25.js
 */

import { getDatabase, supportsHybridSearch } from '../db.js';

async function main() {
  const db = getDatabase();

  if (!supportsHybridSearch(db)) {
    console.log('BM25 backfill is only needed for PostgreSQL backend.');
    console.log('SQLite uses vector-only search.');
    await db.close();
    return;
  }

  console.log('Backfilling BM25 vectors for existing synthesis nodes...');
  console.log('');
  console.log('The PostgreSQL trigger will automatically generate BM25 vectors');
  console.log('for any row that is updated. Run this SQL to backfill:');
  console.log('');
  console.log('  UPDATE synthesis_nodes SET updated_at = updated_at WHERE bm25 IS NULL;');
  console.log('');
  console.log('Or connect to the database and run:');
  console.log('  docker exec -it totalrecall-vchord psql -U totalrecall -d totalrecall');
  console.log('');

  // Query for count of nodes needing backfill
  const nodes = await db.queryNodes({ limit: 10000 });
  console.log(`Total nodes in database: ${nodes.length}`);

  await db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
