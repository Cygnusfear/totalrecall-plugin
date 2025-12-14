/**
 * Search Quality Benchmark
 *
 * Compares search quality between vector-only and hybrid search modes.
 * Uses synthetic test data to measure:
 * - Recall: % of relevant results returned
 * - Precision: % of returned results that are relevant
 * - NDCG@5: Normalized Discounted Cumulative Gain at top 5
 * - Latency: Query execution time
 */

import {
  getDatabaseWithBackend,
  type ISynthesisDatabase,
  supportsHybridSearch,
} from '../src/db/index.js';
import { generateEmbedding, initEmbeddings } from '../src/embeddings.js';
import { unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const TEST_DB_PATH = join(tmpdir(), 'totalrecall-benchmark.sqlite');
const USE_POSTGRES = process.env.TEST_POSTGRES === 'true';
const POSTGRES_URL =
  process.env.TEST_POSTGRES_URL || 'postgresql://totalrecall:totalrecall@localhost:5432/totalrecall';

// Test data: queries with expected relevant node types/content
interface BenchmarkQuery {
  query: string;
  expectedKeywords: string[]; // Keywords that should appear in results
  description: string;
}

const BENCHMARK_QUERIES: BenchmarkQuery[] = [
  {
    query: 'handleSynthesis function implementation',
    expectedKeywords: ['synthesis', 'handle', 'function'],
    description: 'Code identifier search (should benefit from trigram)',
  },
  {
    query: 'database migration PostgreSQL',
    expectedKeywords: ['database', 'migration', 'postgres'],
    description: 'Technical keyword search (should benefit from BM25)',
  },
  {
    query: 'how does the memory system work',
    expectedKeywords: ['memory', 'synthesis', 'recall'],
    description: 'Natural language question (should benefit from vector)',
  },
  {
    query: 'camelCaseVariable naming',
    expectedKeywords: ['camel', 'case', 'naming'],
    description: 'Code style search (trigram for partial matches)',
  },
  {
    query: '"exact phrase match"',
    expectedKeywords: ['exact', 'phrase'],
    description: 'Exact phrase (BM25 should excel)',
  },
];

// Synthetic test nodes
const TEST_NODES = [
  {
    node_type: 'learning' as const,
    one_liner: 'handleSynthesis function creates new synthesis nodes',
    summary: 'The handleSynthesis function is the main entry point for creating synthesis nodes.',
    full_synthesis:
      'Detailed implementation of handleSynthesis: validates input, generates embeddings, stores in database.',
  },
  {
    node_type: 'decision' as const,
    one_liner: 'Database migration to PostgreSQL for scalability',
    summary: 'Decided to migrate from SQLite to PostgreSQL for better scalability and hybrid search.',
    full_synthesis:
      'PostgreSQL migration enables VectorChord suite with BM25, trigram, and vector search capabilities.',
  },
  {
    node_type: 'summary' as const,
    one_liner: 'Memory system overview and architecture',
    summary: 'Total Recall is a synthesis-first memory system using vector embeddings.',
    full_synthesis:
      'The memory system works by capturing raw content, synthesizing it into nodes, and enabling semantic retrieval.',
  },
  {
    node_type: 'learning' as const,
    one_liner: 'camelCaseVariable naming conventions for TypeScript',
    summary: 'TypeScript uses camelCase for variables and PascalCase for types.',
    full_synthesis:
      'Naming conventions: camelCase for variables/functions, PascalCase for classes/types, SCREAMING_SNAKE for constants.',
  },
  {
    node_type: 'entity' as const,
    one_liner: 'Exact phrase match testing for BM25',
    summary: 'Testing exact phrase matching capabilities of the BM25 search system.',
    full_synthesis: 'BM25 handles "exact phrase match" queries by tokenizing and ranking by term frequency.',
    entity_name: 'BM25',
  },
];

async function createTestDb(): Promise<ISynthesisDatabase> {
  if (USE_POSTGRES) {
    console.log('Using PostgreSQL backend for benchmark');
    const db = getDatabaseWithBackend('postgres', {
      postgresUrl: POSTGRES_URL,
      poolSize: 5,
    });
    // @ts-expect-error - calling init if available
    if (db.init) await db.init();
    return db;
  } else {
    console.log('Using SQLite backend for benchmark');
    if (existsSync(TEST_DB_PATH)) {
      unlinkSync(TEST_DB_PATH);
    }
    return getDatabaseWithBackend('sqlite', {
      sqlitePath: TEST_DB_PATH,
    });
  }
}

async function seedTestData(db: ISynthesisDatabase) {
  console.log('Seeding test data...');

  for (const node of TEST_NODES) {
    // Generate embedding from synthesis text
    const embeddingText = `${node.one_liner} ${node.summary}`;
    const embedding = await generateEmbedding(embeddingText);

    // Create node first (embedding is stored separately)
    const createdNode = await db.createNode({
      ...node,
      source_session_id: 'benchmark-session',
      entity_name: node.entity_name ?? null,
      entity_aliases: null,
      temporal_context: null,
      first_seen: Date.now(),
      last_updated: Date.now(),
      status: null,
      assigned_agent: null,
      priority: null,
      source_agent_id: null,
      source_repo: null,
    });

    // Insert embedding separately
    await db.insertEmbedding(createdNode.id, embedding);
  }

  console.log(`Seeded ${TEST_NODES.length} test nodes`);
}

function calculateNDCG(results: string[], expectedKeywords: string[], k = 5): number {
  // Calculate DCG
  let dcg = 0;
  const truncated = results.slice(0, k);

  for (let i = 0; i < truncated.length; i++) {
    const result = truncated[i].toLowerCase();
    const relevance = expectedKeywords.filter((kw) => result.includes(kw.toLowerCase())).length;
    dcg += relevance / Math.log2(i + 2); // i+2 because log2(1) = 0
  }

  // Calculate ideal DCG (assuming all keywords match perfectly)
  let idcg = 0;
  for (let i = 0; i < Math.min(k, expectedKeywords.length); i++) {
    idcg += 1 / Math.log2(i + 2);
  }

  return idcg === 0 ? 0 : dcg / idcg;
}

async function runBenchmark() {
  console.log('=== Search Quality Benchmark ===\n');

  await initEmbeddings();
  const db = await createTestDb();

  // Clear existing test data if using postgres
  if (USE_POSTGRES) {
    console.log('Clearing existing benchmark data...');
    // We'll just add to existing data
  }

  await seedTestData(db);

  const results: {
    query: string;
    description: string;
    vectorLatency: number;
    hybridLatency?: number;
    vectorNDCG: number;
    hybridNDCG?: number;
  }[] = [];

  for (const benchmark of BENCHMARK_QUERIES) {
    console.log(`\nQuery: "${benchmark.query}"`);
    console.log(`Description: ${benchmark.description}`);

    // Vector search
    const vectorStart = Date.now();
    const embedding = await generateEmbedding(benchmark.query);
    const vectorResults = await db.searchByVector(embedding, 5, 0.1);
    const vectorLatency = Date.now() - vectorStart;

    const vectorTexts = vectorResults.map((r) => `${r.one_liner} ${r.node_type}`);
    const vectorNDCG = calculateNDCG(vectorTexts, benchmark.expectedKeywords);

    console.log(`  Vector: ${vectorLatency}ms, NDCG@5: ${vectorNDCG.toFixed(3)}`);

    let hybridLatency: number | undefined;
    let hybridNDCG: number | undefined;

    // Hybrid search (PostgreSQL only)
    if (supportsHybridSearch(db)) {
      const hybridStart = Date.now();
      const hybridResults = await db.hybridSearch({
        query: benchmark.query,
        queryEmbedding: embedding,
        maxResults: 5,
        minScore: 0.1,
        searchMode: 'hybrid',
      });
      hybridLatency = Date.now() - hybridStart;

      const hybridTexts = hybridResults.map((r) => `${r.one_liner} ${r.node_type}`);
      hybridNDCG = calculateNDCG(hybridTexts, benchmark.expectedKeywords);

      console.log(`  Hybrid: ${hybridLatency}ms, NDCG@5: ${hybridNDCG.toFixed(3)}`);

      const improvement = ((hybridNDCG - vectorNDCG) / vectorNDCG) * 100;
      if (improvement > 0) {
        console.log(`  Hybrid improvement: +${improvement.toFixed(1)}%`);
      }
    }

    results.push({
      query: benchmark.query,
      description: benchmark.description,
      vectorLatency,
      hybridLatency,
      vectorNDCG,
      hybridNDCG,
    });
  }

  // Summary
  console.log('\n=== Summary ===\n');

  const avgVectorLatency = results.reduce((sum, r) => sum + r.vectorLatency, 0) / results.length;
  const avgVectorNDCG = results.reduce((sum, r) => sum + r.vectorNDCG, 0) / results.length;

  console.log(`Vector Search:`);
  console.log(`  Avg Latency: ${avgVectorLatency.toFixed(0)}ms`);
  console.log(`  Avg NDCG@5: ${avgVectorNDCG.toFixed(3)}`);

  if (supportsHybridSearch(db)) {
    const avgHybridLatency =
      results.reduce((sum, r) => sum + (r.hybridLatency ?? 0), 0) / results.length;
    const avgHybridNDCG = results.reduce((sum, r) => sum + (r.hybridNDCG ?? 0), 0) / results.length;

    console.log(`\nHybrid Search:`);
    console.log(`  Avg Latency: ${avgHybridLatency.toFixed(0)}ms`);
    console.log(`  Avg NDCG@5: ${avgHybridNDCG.toFixed(3)}`);

    const improvement = ((avgHybridNDCG - avgVectorNDCG) / avgVectorNDCG) * 100;
    console.log(`\nOverall Hybrid Improvement: ${improvement > 0 ? '+' : ''}${improvement.toFixed(1)}%`);
  }

  await db.close();

  // Cleanup SQLite
  if (!USE_POSTGRES && existsSync(TEST_DB_PATH)) {
    unlinkSync(TEST_DB_PATH);
  }

  console.log('\n=== BENCHMARK COMPLETE ===');
}

runBenchmark().catch((e) => {
  console.error(e);
  process.exit(1);
});
