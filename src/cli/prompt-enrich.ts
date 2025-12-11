/**
 * CLI: prompt-enrich
 * Called by UserPromptSubmit hook to inject relevant memory context per-message
 *
 * Reads user prompt from stdin, performs semantic search, and outputs
 * ~200 tokens of relevant synthesis nodes as additionalContext.
 */

import { getDatabase } from '../db.js';
import { generateEmbedding, initEmbeddings } from '../embeddings.js';

interface HookInput {
  prompt?: string;
  transcript_path?: string;
}

const MIN_SCORE = 0.5; // Higher threshold for relevance
const MAX_RESULTS = 4; // ~200 tokens (4 one-liners at ~50 tokens each)

async function main() {
  // Check for disable toggle
  if (process.env.TOTALRECALL_ENRICH === 'false') {
    process.exit(0);
  }

  // Read hook input from stdin
  let input: HookInput = {};
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    const stdinData = Buffer.concat(chunks).toString('utf-8').trim();
    if (stdinData) {
      input = JSON.parse(stdinData);
    }
  } catch {
    // No stdin or invalid JSON - skip enrichment
    process.exit(0);
  }

  const prompt = input.prompt;
  if (!prompt || prompt.length < 10) {
    // Skip very short prompts (likely commands or acknowledgments)
    process.exit(0);
  }

  try {
    // Initialize embeddings (cold start ~1-2s)
    await initEmbeddings();

    // Generate embedding for user's prompt
    const queryEmbedding = await generateEmbedding(prompt);

    // Search for relevant synthesis nodes
    const db = getDatabase();
    const results = db.searchByVector(queryEmbedding, MAX_RESULTS, MIN_SCORE);
    db.close();

    if (results.length === 0) {
      // No relevant context found - don't inject noise
      process.exit(0);
    }

    // Format results as one-liners
    const contextLines = results
      .map((r) => `- [${r.node_type}] ${r.one_liner} (${r.node_id.slice(0, 8)})`)
      .join('\n');

    // Output hook response
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: `<total_recall_relevant>
Relevant memories for your query:
${contextLines}

Use synthesis_unfold(node_id) for more detail.
</total_recall_relevant>`,
        },
      })
    );
  } catch (error) {
    // On error, fail silently to not block user prompt
    console.error(`[totalrecall] prompt-enrich error: ${error}`);
    process.exit(0);
  }
}

main();
