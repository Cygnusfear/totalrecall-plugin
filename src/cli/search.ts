/**
 * CLI: search
 * Search synthesis by semantic similarity (or hybrid on PostgreSQL)
 */

import { getDatabase, supportsHybridSearch } from '../db.js';
import { generateEmbedding, initEmbeddings } from '../embeddings.js';

async function main() {
  const args = process.argv.slice(2);
  const forceVector = args.includes('--vector');
  const query = args.filter((a) => !a.startsWith('--')).join(' ');

  if (!query) {
    console.error('Usage: totalrecall search <query> [--vector]');
    console.error('  --vector  Force vector-only search (skip BM25/trigram)');
    process.exit(1);
  }

  const db = getDatabase();

  try {
    await initEmbeddings();

    // Generate embedding once (used by both search modes)
    const embedding = await generateEmbedding(query);

    let results;
    let searchMode = 'vector';

    // Use hybrid search on PostgreSQL unless --vector flag is set
    if (!forceVector && supportsHybridSearch(db)) {
      results = await db.hybridSearch({
        query,
        queryEmbedding: embedding,
        maxResults: 10,
        minScore: 0.3,
        searchMode: 'hybrid',
      });
      searchMode = 'hybrid';
    } else {
      results = await db.searchByVector(embedding, 10, 0.3);
    }

    console.log(`Search mode: ${searchMode}`);
    console.log('---');

    for (const r of results) {
      const pct = Math.round(r.score * 100);
      console.log(`[${r.node_type}] ${pct}% - ${r.one_liner}`);
    }
  } catch (error) {
    console.error('Search failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  } finally {
    await db.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
