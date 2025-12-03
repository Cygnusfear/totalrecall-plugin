/**
 * CLI: search
 * Search synthesis by semantic similarity
 */

import { getDatabase } from '../db.js';
import { generateEmbedding, initEmbeddings } from '../embeddings.js';

async function main() {
  const args = process.argv.slice(2);
  const query = args.filter((a) => !a.startsWith('--')).join(' ');

  if (!query) {
    console.error('Usage: totalrecall search <query>');
    process.exit(1);
  }

  const db = getDatabase();
  await initEmbeddings();

  const embedding = await generateEmbedding(query);
  const results = db.searchByVector(embedding, 5, 0.3);

  for (const r of results) {
    const pct = Math.round(r.score * 100);
    console.log(`[${r.node_type}] ${pct}% - ${r.one_liner}`);
  }

  db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
