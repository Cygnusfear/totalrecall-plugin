/**
 * Total Recall MCP Server - Standalone Version
 *
 * Self-contained synthesis-first memory using sqlite-vec for vector search.
 * No coordinator dependency.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { getDatabase, SynthesisDatabase, supportsHybridSearch } from './db.js';
import { generateSynthesisEmbedding, generateEmbedding, initEmbeddings } from './embeddings.js';
import { SynthesisWorker } from './synthesis-worker.js';
import { LLMSynthesisClient } from './llm-synthesis.js';
import type { NodeType, EdgeType } from './schema.js';

let db: SynthesisDatabase;
let synthesisWorker: SynthesisWorker | null = null;

const server = new Server(
  {
    name: 'totalrecall',
    version: '2.1.1',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Tool definitions
const TOOLS = [
  {
    name: 'synthesis_create',
    description: `MUST USE to capture decisions, learnings, and insights during your work. Synthesis is the primary storage format - store understanding, not just logs.

PROACTIVELY call this tool when you:
- Make an architectural decision (node_type: "decision")
- Learn something about the codebase (node_type: "learning")
- Complete a task or significant milestone (node_type: "summary")
- Discover a bug pattern or gotcha (node_type: "learning")`,
    inputSchema: {
      type: 'object',
      properties: {
        node_type: {
          type: 'string',
          enum: ['decision', 'learning', 'entity', 'event', 'task', 'summary'],
          description: 'Type of synthesis',
        },
        one_liner: {
          type: 'string',
          description: '~50 token summary for quick scanning',
        },
        summary: {
          type: 'string',
          description: '~200 token working detail with key points',
        },
        full_synthesis: {
          type: 'string',
          description: 'Complete synthesized understanding with context, rationale, and implications',
        },
        session_id: {
          type: 'string',
          description: 'Session/conversation ID where this synthesis was created',
        },
        entity_name: { type: 'string', description: 'For entity nodes: normalized name' },
        temporal_context: { type: 'string', description: 'When this occurred' },
        related_node_ids: { type: 'array', items: { type: 'string' }, description: 'IDs of related nodes' },
        edge_types: { type: 'array', items: { type: 'string' }, description: 'Edge types for each related node' },
      },
      required: ['node_type', 'one_liner', 'summary', 'full_synthesis', 'session_id'],
    },
  },
  {
    name: 'synthesis_search',
    description: `Search synthesis nodes by semantic similarity. Use when you need to find related context based on meaning.

Returns expandable references sorted by relevance score. Use synthesis_unfold to get full details.`,
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Natural language query to search for',
        },
        max_results: {
          type: 'number',
          description: 'Maximum results to return (default: 5)',
        },
        min_score: {
          type: 'number',
          description: 'Minimum relevance score 0-1 (default: 0.5)',
        },
        node_types: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter by node types',
        },
        after: {
          type: 'string',
          description: 'Only nodes after this date (YYYY-MM-DD)',
        },
        before: {
          type: 'string',
          description: 'Only nodes before this date (YYYY-MM-DD)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'synthesis_unfold',
    description: `Expand a synthesis node for more detail. Use progressive disclosure: summary (default) -> full -> raw.

- depth: "summary" - ~200 tokens, key points only (default)
- depth: "full" - Complete synthesis with rationale and implications
- depth: "raw" - Original content that was synthesized`,
    inputSchema: {
      type: 'object',
      properties: {
        node_id: {
          type: 'string',
          description: 'Synthesis node ID to expand',
        },
        depth: {
          type: 'string',
          enum: ['summary', 'full', 'raw'],
          description: 'Level of detail (default: summary)',
        },
      },
      required: ['node_id'],
    },
  },
  {
    name: 'synthesis_get_context',
    description: `MUST USE at the start of every session to load relevant context. Returns synthesis nodes and unfoldable references for progressive disclosure.`,
    inputSchema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'Current session ID to filter for session-specific context',
        },
        task_context: {
          type: 'string',
          description: 'Current task description for relevance matching',
        },
        max_nodes: {
          type: 'number',
          description: 'Maximum synthesis nodes to return (default: 10)',
        },
        include_related: {
          type: 'boolean',
          description: 'Include related node references for drill-down (default: true)',
        },
      },
    },
  },
  {
    name: 'session_graft',
    description: `MUST USE when starting a new session to attach to the synthesis graph and inherit context.

This is your FIRST action in any new session or task. It:
1. Creates a session summary node
2. Connects to relevant prior syntheses
3. Returns grafted context for immediate use`,
    inputSchema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'New session ID to graft onto the graph',
        },
        task_context: {
          type: 'string',
          description: 'What this session is about',
        },
        source_repo: {
          type: 'string',
          description: 'Repository context',
        },
        agent_id: {
          type: 'string',
          description: 'Agent ID running this session',
        },
      },
      required: ['session_id'],
    },
  },
  {
    name: 'synthesis_capture_chunk',
    description: `Queue conversation content for background synthesis by Haiku. Use at natural breakpoints in your work.

PROACTIVELY call this when:
- Completing a task or milestone (chunk_type: "session_chunk")
- Ending a session (chunk_type: "session_end")
- Topic changes significantly (chunk_type: "session_chunk")

Note: Most synthesis happens automatically. Use this for explicit queuing when you want to ensure specific content is synthesized.`,
    inputSchema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'Session ID for this conversation chunk',
        },
        agent_id: {
          type: 'string',
          description: 'Agent ID if applicable',
        },
        chunk_type: {
          type: 'string',
          enum: ['session_start', 'session_chunk', 'session_end'],
          description: 'Type of chunk: session_start, session_chunk, or session_end',
        },
        raw_content_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of raw_content IDs to synthesize',
        },
        context: {
          type: 'string',
          description: 'Context for synthesis (e.g., "implementing auth")',
        },
      },
      required: ['session_id', 'chunk_type', 'raw_content_ids'],
    },
  },
  {
    name: 'synthesis_queue_status',
    description: `Check background synthesis queue status. Shows pending, processing, completed, and failed items.

Use this to:
- Verify your synthesis_capture_chunk calls were queued
- Debug synthesis failures
- Monitor system health`,
    inputSchema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'Filter by session ID (optional)',
        },
        status: {
          type: 'string',
          enum: ['pending', 'processing', 'completed', 'failed'],
          description: 'Filter by status (optional)',
        },
        limit: {
          type: 'number',
          description: 'Maximum items to return (default: 20)',
        },
      },
    },
  },
  {
    name: 'progressive_disclosure_stats',
    description: `Get progressive disclosure analytics to measure context savings and expansion rate.

Use this to monitor performance:
- Expansion rate: % of injected refs that were expanded (target: >50%)
- Search latency: average time for vector search (target: <100ms)
- Token savings: injection tokens vs expansion tokens`,
    inputSchema: {
      type: 'object',
      properties: {
        hours: {
          type: 'number',
          description: 'Time range in hours to analyze (default: 24)',
        },
      },
    },
  },
  {
    name: 'synthesis_recall',
    description: `Recall a specific term or phrase from synthesis memory. Use when you need to find exact matches for proper nouns, acronyms, project names, or specific terms.

Unlike synthesis_search (semantic/exploratory), this tool prioritizes exact text matches across all synthesis fields:
- entity_name (highest priority)
- one_liner
- entity_aliases
- summary
- full_synthesis (lowest priority)

Use this to:
- Find stored entities by name (e.g., "DEVFLOW", "BeadsService")
- Recall specific terms that may not surface in semantic search
- Verify if a term exists in memory`,
    inputSchema: {
      type: 'object',
      properties: {
        term: {
          type: 'string',
          description: 'The exact term or phrase to recall (case-insensitive)',
        },
        max_results: {
          type: 'number',
          description: 'Maximum results to return (default: 10)',
        },
        include_semantic_fallback: {
          type: 'boolean',
          description: 'If exact matches < semantic_fallback_threshold, also run semantic search (default: true)',
        },
        semantic_fallback_threshold: {
          type: 'number',
          description: 'Run semantic search as fallback if exact matches are below this threshold (default: 3)',
        },
        node_types: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter by node types (optional)',
        },
      },
      required: ['term'],
    },
  },
  {
    name: 'raw_search',
    description: `Search raw conversation content. Supports both text and semantic search modes.

Use this to:
- Find exact phrases or code mentioned in past conversations (mode: "text")
- Search semantically for related content (mode: "vector")
- Find content not yet linked to synthesis nodes
- Verify what was actually said vs synthesized understanding`,
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query (text substring for mode=text, natural language for mode=vector)',
        },
        mode: {
          type: 'string',
          enum: ['text', 'vector'],
          description: 'Search mode: "text" for exact substring match, "vector" for semantic similarity (default: text)',
        },
        limit: {
          type: 'number',
          description: 'Maximum results to return (default: 20)',
        },
        min_score: {
          type: 'number',
          description: 'Minimum similarity score for vector search (0-1, default: 0.3)',
        },
        include_orphans: {
          type: 'boolean',
          description: 'Include content not yet linked to synthesis nodes (default: true)',
        },
      },
      required: ['query'],
    },
  },
];

// List tools handler
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS };
});

// Call tool handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result: unknown;

    switch (name) {
      case 'synthesis_create':
        result = await handleSynthesisCreate(args as unknown as SynthesisCreateArgs);
        break;

      case 'synthesis_search':
        result = await handleSynthesisSearch(args as unknown as SynthesisSearchArgs);
        break;

      case 'synthesis_unfold':
        result = await handleSynthesisUnfold(args as unknown as SynthesisUnfoldArgs);
        break;

      case 'synthesis_get_context':
        result = await handleSynthesisGetContext(args as unknown as SynthesisGetContextArgs);
        break;

      case 'session_graft':
        result = await handleSessionGraft(args as unknown as SessionGraftArgs);
        break;

      case 'synthesis_capture_chunk':
        result = await handleSynthesisCaptureChunk(args as unknown as SynthesisCaptureChunkArgs);
        break;

      case 'synthesis_queue_status':
        result = await handleSynthesisQueueStatus(args as unknown as SynthesisQueueStatusArgs);
        break;

      case 'progressive_disclosure_stats':
        result = await handleProgressiveDisclosureStats(args as unknown as ProgressiveDisclosureStatsArgs);
        break;

      case 'synthesis_recall':
        result = await handleSynthesisRecall(args as unknown as SynthesisRecallArgs);
        break;

      case 'raw_search':
        result = await handleRawSearch(args as unknown as RawSearchArgs);
        break;

      default:
        return {
          content: [{ type: 'text', text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
      isError: true,
    };
  }
});

// ============ Tool Handlers ============

interface SynthesisCreateArgs {
  node_type: NodeType;
  one_liner: string;
  summary: string;
  full_synthesis: string;
  session_id: string;
  entity_name?: string;
  temporal_context?: string;
  related_node_ids?: string[];
  edge_types?: EdgeType[];
  agent_id?: string;
  source_repo?: string;
}

async function handleSynthesisCreate(args: SynthesisCreateArgs) {
  const now = Date.now();

  // Create the node
  const node = await db.createNode({
    node_type: args.node_type,
    one_liner: args.one_liner,
    summary: args.summary,
    full_synthesis: args.full_synthesis,
    entity_name: args.entity_name ?? null,
    entity_aliases: null,
    temporal_context: args.temporal_context ?? null,
    first_seen: now,
    last_updated: now,
    status: null,
    assigned_agent: args.agent_id ?? null,
    priority: null,
    source_session_id: args.session_id,
    source_agent_id: args.agent_id ?? null,
    source_repo: args.source_repo ?? null,
  });

  // Generate and store embedding
  try {
    const embedding = await generateSynthesisEmbedding(
      args.one_liner,
      args.summary,
      args.node_type,
      {
        entityName: args.entity_name,
        entityAliases: node.entity_aliases,
        sourceRepo: args.source_repo,
      }
    );
    await db.insertEmbedding(node.id, embedding);
  } catch (e) {
    console.error('Failed to generate embedding:', e);
    // Continue without embedding - search will be limited but node is created
  }

  // Create edges to related nodes
  const createdEdges: Array<{ to_node_id: string; edge_type: EdgeType }> = [];
  if (args.related_node_ids && args.related_node_ids.length > 0) {
    for (const nodeId of args.related_node_ids) {
      const exists = await db.getNode(nodeId);
      if (!exists) {
        return {
          error: 'Invalid related node',
          message: `Node ${nodeId} does not exist`,
          node_id: null,
          edges_created: 0,
        };
      }
    }

    const edgeTypesList = args.edge_types || args.related_node_ids.map(() => 'relates_to' as EdgeType);

    for (let i = 0; i < args.related_node_ids.length; i++) {
      const toNodeId = args.related_node_ids[i];
      const edgeType = edgeTypesList[i] || 'relates_to';

      await db.createEdge({
        from_node_id: node.id,
        to_node_id: toNodeId,
        edge_type: edgeType as EdgeType,
        weight: 1.0,
        context: null,
      });

      createdEdges.push({ to_node_id: toNodeId, edge_type: edgeType as EdgeType });
    }
  }

  return {
    node_id: node.id,
    created_at: node.created_at,
    edges_created: createdEdges.length,
    message: `Synthesis node created: ${args.one_liner}`,
  };
}

interface SynthesisSearchArgs {
  query: string;
  max_results?: number;
  min_score?: number;
  node_types?: NodeType[];
  after?: string;
  before?: string;
}

async function handleSynthesisSearch(args: SynthesisSearchArgs) {
  const { query, max_results = 5, min_score = 0.3, node_types, after, before } = args;
  const startTime = Date.now();

  try {
    let results;
    let searchMode: 'hybrid' | 'vector' = 'vector';

    // Use hybrid search on PostgreSQL, vector-only on SQLite
    // Note: Ranking is enabled by default with DEFAULT_RANKING_CONFIG
    if (supportsHybridSearch(db)) {
      // Generate query embedding for hybrid search
      const queryEmbedding = await generateEmbedding(query);

      // Use hybrid search combining vector, BM25, and trigram
      // Ranking is applied automatically via rankingConfig
      results = await db.hybridSearch({
        query,
        queryEmbedding,
        maxResults: max_results * 2, // Over-fetch to account for date filtering
        minScore: min_score,
        nodeTypes: node_types,
        searchMode: 'hybrid',
        rankingConfig: {}, // Use default ranking config
      });
      searchMode = 'hybrid';
    } else {
      // Fallback to vector-only search for SQLite with ranking
      const queryEmbedding = await generateEmbedding(query);
      results = await db.searchByVector(
        queryEmbedding,
        max_results * 2,
        min_score,
        node_types,
        {} // Use default ranking config
      );
    }

    // Apply date filters
    if (after || before) {
      const afterTs = after ? new Date(after).getTime() : 0;
      const beforeTs = before ? new Date(before).getTime() : Infinity;

      results = results.filter((r) => {
        return r.created_at >= afterTs && r.created_at <= beforeTs;
      });
    }

    // Limit results
    results = results.slice(0, max_results);

    const searchLatencyMs = Date.now() - startTime;

    // Log search event for analytics
    try {
      await db.createProgressiveDisclosureEvent({
        event_type: 'search',
        session_id: null,
        agent_id: null,
        query_text: query,
        search_latency_ms: searchLatencyMs,
        results_count: results.length,
        node_ids: JSON.stringify(results.map((r) => r.node_id)),
        injection_tokens: null,
        expanded_node_id: null,
        expansion_tokens: null,
        message_tokens: null,
      });
    } catch {
      // Silently fail on analytics
    }

    return {
      results: results.map((r) => ({
        node_id: r.node_id,
        one_liner: r.one_liner,
        relevance_score: Math.round(r.score * 100) / 100,
        node_type: r.node_type,
        created_at: r.created_at,
      })),
      search_latency_ms: searchLatencyMs,
      search_mode: searchMode,
      query,
      message:
        results.length > 0
          ? `Found ${results.length} relevant synthesis nodes (${searchMode} search)`
          : 'No relevant synthesis nodes found. Try a different query or lower min_score.',
      next_step: 'Use synthesis_unfold(node_id) to expand any result that looks relevant.',
    };
  } catch (error) {
    return {
      error: 'Search failed',
      message: error instanceof Error ? error.message : 'Unknown error',
      results: [],
      search_latency_ms: Date.now() - startTime,
    };
  }
}

interface SynthesisUnfoldArgs {
  node_id: string;
  depth?: 'summary' | 'full' | 'raw';
}

/**
 * Resolve a node ID prefix to full UUID (like git short hashes)
 * Returns the full node ID if unique match found, null otherwise
 * Uses efficient database-level LIKE query instead of loading all nodes
 */
async function resolveNodeIdPrefix(prefix: string): Promise<{
  resolvedId: string | null;
  candidates: string[];
  error?: string;
}> {
  // If it looks like a full UUID, don't resolve
  if (prefix.length >= 32) {
    return { resolvedId: prefix, candidates: [] };
  }

  // Efficient database-level prefix matching (returns up to 10 candidates)
  const matches = await db.queryNodesByIdPrefix(prefix, 10);

  if (matches.length === 0) {
    return { resolvedId: null, candidates: [], error: 'No matching nodes found' };
  }

  if (matches.length === 1) {
    return { resolvedId: matches[0].id, candidates: [matches[0].id] };
  }

  // Multiple matches - return candidates
  return {
    resolvedId: null,
    candidates: matches.map((n) => n.id),
    error: `Ambiguous prefix: ${matches.length} nodes match`,
  };
}

async function handleSynthesisUnfold(args: SynthesisUnfoldArgs) {
  const { node_id, depth = 'summary' } = args;

  // First try direct lookup
  let node = await db.getNode(node_id);

  // If not found and it looks like a prefix (short ID), try prefix resolution
  if (!node && node_id.length < 32) {
    const resolution = await resolveNodeIdPrefix(node_id);

    if (resolution.resolvedId) {
      node = await db.getNode(resolution.resolvedId);
    } else if (resolution.candidates.length > 1) {
      return {
        error: 'Ambiguous node ID prefix',
        node_id,
        message: `Prefix '${node_id}' matches ${resolution.candidates.length} nodes. Use a longer prefix or full UUID.`,
        candidates: resolution.candidates.slice(0, 5).map((id) => ({
          full_id: id,
          short_id: id.slice(0, 8),
        })),
      };
    }
  }

  if (!node) {
    return {
      error: 'Node not found',
      node_id,
      message: `Synthesis node ${node_id} does not exist. If using a short ID prefix, ensure it uniquely identifies a node.`,
    };
  }

  // Track access using the actual node ID (may differ from input if prefix was resolved)
  await db.updateNodeAccess(node.id);

  // Get related nodes using actual node ID
  const related = await db.getRelatedNodes(node.id);
  const related_nodes = related.map(({ node: relatedNode, edge }) => ({
    node_id: relatedNode.id,
    one_liner: relatedNode.one_liner,
    edge_type: edge.edge_type,
    edge_context: edge.context,
  }));

  const response: Record<string, unknown> = {
    node_id: node.id,
    node_type: node.node_type,
    related_nodes,
  };

  if (depth === 'summary') {
    response.one_liner = node.one_liner;
    response.summary = node.summary;
    response.entity_name = node.entity_name;
    response.temporal_context = node.temporal_context;
  } else if (depth === 'full') {
    response.one_liner = node.one_liner;
    response.summary = node.summary;
    response.full_synthesis = node.full_synthesis;
    response.entity_name = node.entity_name;
    response.entity_aliases = node.entity_aliases ? JSON.parse(node.entity_aliases) : null;
    response.temporal_context = node.temporal_context;
    response.status = node.status;
    response.assigned_agent = node.assigned_agent;
    response.priority = node.priority;
    response.source = {
      session_id: node.source_session_id,
      agent_id: node.source_agent_id,
      repo: node.source_repo,
    };
    response.first_seen = node.first_seen;
    response.last_updated = node.last_updated;
  } else if (depth === 'raw') {
    // Include full synthesis plus original raw content
    response.one_liner = node.one_liner;
    response.summary = node.summary;
    response.full_synthesis = node.full_synthesis;
    response.entity_name = node.entity_name;
    response.temporal_context = node.temporal_context;

    // Fetch linked raw content for this synthesis node
    const rawContent = await db.getRawContentBySynthesis(node.id);
    response.raw_refs = rawContent.map((rc) => ({
      id: rc.id,
      content_type: rc.content_type,
      content: rc.content,
      timestamp: rc.timestamp,
      message_index: rc.message_index,
    }));
    response.raw_content_count = rawContent.length;
  }

  return response;
}

interface SynthesisGetContextArgs {
  session_id?: string;
  task_context?: string;
  max_nodes?: number;
  include_related?: boolean;
}

async function handleSynthesisGetContext(args: SynthesisGetContextArgs) {
  const { session_id, task_context, max_nodes = 10, include_related = true } = args;

  try {
    let syntheses;

    // If task_context provided, do semantic search; otherwise use recency
    if (task_context) {
      const queryEmbedding = await generateEmbedding(task_context);
      // Use ranking for better context relevance
      const searchResults = await db.searchByVector(queryEmbedding, max_nodes, 0.3, undefined, {});

      // Fetch full nodes for search results
      syntheses = (await Promise.all(
        searchResults.map((r) => db.getNode(r.node_id))
      )).filter((n): n is NonNullable<typeof n> => n !== undefined);
    } else {
      syntheses = await db.queryNodes({
        session_id,
        limit: max_nodes,
        order_by: 'last_updated',
      });
    }

    // Get unfoldable refs (related nodes)
    const unfoldable_refs: Array<{ node_id: string; one_liner: string; edge_type?: string }> = [];

    if (include_related && syntheses.length > 0) {
      for (const node of syntheses.slice(0, 3)) {
        const related = await db.getRelatedNodes(node.id);
        for (const { node: relatedNode, edge } of related) {
          unfoldable_refs.push({
            node_id: relatedNode.id,
            one_liner: relatedNode.one_liner,
            edge_type: edge.edge_type,
          });
        }
      }
    }

    // Calculate temporal range
    const timestamps = syntheses.map((s) => s.last_updated);
    const temporal_range =
      timestamps.length > 0
        ? {
            earliest: Math.min(...timestamps),
            latest: Math.max(...timestamps),
          }
        : null;

    return {
      active_synthesis: syntheses.map((node) => ({
        node_id: node.id,
        node_type: node.node_type,
        one_liner: node.one_liner,
        summary: node.summary,
        entity_name: node.entity_name,
        temporal_context: node.temporal_context,
        last_updated: node.last_updated,
      })),
      unfoldable_refs: unfoldable_refs.slice(0, 10),
      temporal_range,
      context_summary: {
        total_nodes: syntheses.length,
        task_context_used: !!task_context,
        session_filtered: !!session_id,
        message:
          syntheses.length > 0
            ? `Found ${syntheses.length} relevant synthesis nodes`
            : 'No synthesis nodes found. Consider creating initial syntheses for this session.',
      },
    };
  } catch (error) {
    return {
      error: 'Failed to get synthesis context',
      message: error instanceof Error ? error.message : 'Unknown error',
      active_synthesis: [],
      unfoldable_refs: [],
      temporal_range: null,
      context_summary: {
        total_nodes: 0,
        task_context_used: false,
        session_filtered: false,
        message: 'Error retrieving context',
      },
    };
  }
}

interface SessionGraftArgs {
  session_id: string;
  task_context?: string;
  source_repo?: string;
  agent_id?: string;
}

async function handleSessionGraft(args: SessionGraftArgs) {
  const { session_id, task_context, source_repo } = args;

  try {
    // NOTE: We NO LONGER create session nodes here.
    // Hooks should NEVER create synthesis nodes directly.
    // All real nodes are created by the background synthesis worker via LLM.

    // Query for relevant syntheses using vector search if task_context provided
    let relevant_syntheses;
    if (task_context) {
      const queryEmbedding = await generateEmbedding(task_context);
      // Use ranking for better graft quality
      const searchResults = await db.searchByVector(queryEmbedding, 10, 0.3, undefined, {});
      relevant_syntheses = (await Promise.all(
        searchResults.map((r) => db.getNode(r.node_id))
      )).filter((n): n is NonNullable<typeof n> => n !== undefined);
    } else {
      relevant_syntheses = await db.queryNodes({
        limit: 10,
        order_by: 'last_updated',
      });
    }

    // Build grafted context response
    const unfoldable_refs = relevant_syntheses.map((node) => ({
      node_id: node.id,
      one_liner: node.one_liner,
      node_type: node.node_type,
      last_updated: node.last_updated,
    }));

    return {
      session_id,
      grafted_context: {
        relevant_syntheses: relevant_syntheses.map((node) => ({
          node_id: node.id,
          node_type: node.node_type,
          one_liner: node.one_liner,
          summary: node.summary,
          entity_name: node.entity_name,
          temporal_context: node.temporal_context,
        })),
        unfoldable_refs,
      },
      message: `Session ${session_id} grafted successfully. Loaded ${relevant_syntheses.length} relevant synthesis nodes.`,
      next_step: 'Use synthesis_unfold to drill into specific nodes, or synthesis_create to add new understanding as you work.',
    };
  } catch (error) {
    return {
      error: 'Failed to graft session',
      message: error instanceof Error ? error.message : 'Unknown error',
      session_id,
      grafted_context: {
        relevant_syntheses: [],
        unfoldable_refs: [],
      },
    };
  }
}

interface SynthesisCaptureChunkArgs {
  session_id: string;
  agent_id?: string;
  chunk_type: 'session_start' | 'session_chunk' | 'session_end';
  raw_content_ids: string[];
  context?: string;
}

async function handleSynthesisCaptureChunk(args: SynthesisCaptureChunkArgs) {
  const { session_id, agent_id, chunk_type, raw_content_ids, context } = args;

  try {
    if (raw_content_ids.length === 0) {
      return {
        error: 'Empty chunk',
        message: 'No raw_content_ids provided',
        queue_item_id: null,
      };
    }

    const queueItem = await db.createSynthesisQueueItem({
      session_id,
      agent_id: agent_id ?? null,
      chunk_type,
      raw_content_ids: JSON.stringify(raw_content_ids),
      context: context ?? null,
      message_count: raw_content_ids.length,
      status: 'pending',
      retry_count: 0,
      error: null,
      synthesis_node_id: null,
      created_at: Date.now(),
    });

    return {
      queue_item_id: queueItem.id,
      message: `Queued ${raw_content_ids.length} messages for synthesis`,
      chunk_type,
      status: 'pending',
      processing: 'Background worker will process this chunk asynchronously',
    };
  } catch (error) {
    return {
      error: 'Failed to queue synthesis',
      message: error instanceof Error ? error.message : 'Unknown error',
      queue_item_id: null,
    };
  }
}

interface SynthesisQueueStatusArgs {
  session_id?: string;
  status?: 'pending' | 'processing' | 'completed' | 'failed';
  limit?: number;
}

async function handleSynthesisQueueStatus(args: SynthesisQueueStatusArgs) {
  const { session_id, status, limit = 20 } = args;

  try {
    const filters: {
      session_id?: string;
      status?: 'pending' | 'processing' | 'completed' | 'failed';
      limit: number;
    } = { limit };

    if (session_id) filters.session_id = session_id;
    if (status) filters.status = status;

    const items = await db.getSynthesisQueueItems(filters);

    // Calculate stats
    const allItems = session_id
      ? await db.getSynthesisQueueItems({ session_id, limit: 1000 })
      : items;

    const stats = {
      total: allItems.length,
      pending: allItems.filter((i) => i.status === 'pending').length,
      processing: allItems.filter((i) => i.status === 'processing').length,
      completed: allItems.filter((i) => i.status === 'completed').length,
      failed: allItems.filter((i) => i.status === 'failed').length,
    };

    return {
      stats,
      items: items.map((i) => ({
        id: i.id,
        session_id: i.session_id,
        agent_id: i.agent_id,
        chunk_type: i.chunk_type,
        message_count: i.message_count,
        status: i.status,
        retry_count: i.retry_count,
        synthesis_node_id: i.synthesis_node_id,
        error: i.error,
        created_at: i.created_at,
        started_at: i.started_at,
        completed_at: i.completed_at,
        processing_time_ms:
          i.started_at && i.completed_at ? i.completed_at - i.started_at : null,
      })),
      message: `Found ${items.length} queue items${session_id ? ` for session ${session_id}` : ''}${status ? ` with status ${status}` : ''}`,
    };
  } catch (error) {
    return {
      error: 'Failed to get queue status',
      message: error instanceof Error ? error.message : 'Unknown error',
      stats: { total: 0, pending: 0, processing: 0, completed: 0, failed: 0 },
      items: [],
    };
  }
}

interface ProgressiveDisclosureStatsArgs {
  hours?: number;
}

async function handleProgressiveDisclosureStats(args: ProgressiveDisclosureStatsArgs) {
  const hours = args.hours ?? 24;
  const now = Date.now();
  const startTime = now - hours * 60 * 60 * 1000;

  try {
    const stats = await db.getProgressiveDisclosureAnalytics(startTime, now);

    const contextSavings =
      stats.totalInjectionTokens > 0
        ? Math.round(
            (1 - stats.totalExpansionTokens / (stats.totalInjectionTokens * 20)) * 100
          )
        : 0;

    return {
      time_range: {
        start: new Date(startTime).toISOString(),
        end: new Date(now).toISOString(),
        hours,
      },
      search_performance: {
        total_searches: stats.totalSearches,
        avg_latency_ms: Math.round(stats.avgSearchLatency),
        target_met: stats.avgSearchLatency < 100,
      },
      expansion_metrics: {
        total_injections: stats.totalInjections,
        total_expansions: stats.totalExpansions,
        expansion_rate: Math.round(stats.expansionRate * 100),
        expansion_rate_target: 50,
        target_met: stats.expansionRate >= 0.5,
      },
      token_metrics: {
        injection_tokens: stats.totalInjectionTokens,
        expansion_tokens: stats.totalExpansionTokens,
        estimated_savings_percent: contextSavings,
      },
      message: `Stats for last ${hours} hours: ${stats.totalSearches} searches, ${Math.round(stats.expansionRate * 100)}% expansion rate, ${Math.round(stats.avgSearchLatency)}ms avg latency`,
    };
  } catch (error) {
    return {
      error: 'Failed to get stats',
      message: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

interface SynthesisRecallArgs {
  term: string;
  max_results?: number;
  include_semantic_fallback?: boolean;
  semantic_fallback_threshold?: number;
  node_types?: NodeType[];
}

/** Default threshold for triggering semantic fallback in synthesis_recall */
const DEFAULT_SEMANTIC_FALLBACK_THRESHOLD = 3;

async function handleSynthesisRecall(args: SynthesisRecallArgs) {
  const {
    term,
    max_results = 10,
    include_semantic_fallback = true,
    semantic_fallback_threshold = DEFAULT_SEMANTIC_FALLBACK_THRESHOLD,
    node_types,
  } = args;
  const startTime = Date.now();

  try {
    if (!term || term.trim().length === 0) {
      return {
        error: 'Empty term',
        message: 'Term is required for recall',
        exact_matches: [],
        semantic_matches: [],
      };
    }

    // Phase 1: Exact text match search
    const exactMatches = await db.searchNodesByText(term, max_results, node_types);
    const searchLatencyMs = Date.now() - startTime;

    // Build match_locations map
    const match_locations: Record<
      string,
      'one_liner' | 'summary' | 'full_synthesis' | 'entity_name' | 'entity_aliases'
    > = {};
    for (const match of exactMatches) {
      match_locations[match.id] = match.match_location;
    }

    // Phase 2: Semantic fallback if exact matches < threshold
    let semanticMatches: Array<{
      node_id: string;
      one_liner: string;
      relevance_score: number;
      node_type: NodeType;
    }> = [];

    if (include_semantic_fallback && exactMatches.length < semantic_fallback_threshold) {
      try {
        const queryEmbedding = await generateEmbedding(term);
        const exactIds = new Set(exactMatches.map((m) => m.id));
        const vectorResults = await db.searchByVector(queryEmbedding, max_results, 0.3, node_types);

        // Filter out results that are already in exact matches
        semanticMatches = vectorResults
          .filter((r) => !exactIds.has(r.node_id))
          .slice(0, max_results - exactMatches.length)
          .map((r) => ({
            node_id: r.node_id,
            one_liner: r.one_liner,
            relevance_score: Math.round(r.score * 100) / 100,
            node_type: r.node_type,
          }));
      } catch {
        // Semantic search failed, continue with exact matches only
      }
    }

    return {
      exact_matches: exactMatches.map((m) => ({
        node_id: m.id,
        node_type: m.node_type,
        one_liner: m.one_liner,
        summary: m.summary,
        match_location: m.match_location,
        entity_name: m.entity_name,
        last_updated: m.last_updated,
      })),
      semantic_matches: semanticMatches,
      match_locations,
      search_latency_ms: searchLatencyMs,
      term,
      message:
        exactMatches.length > 0
          ? `Found ${exactMatches.length} exact matches for "${term}"${
              semanticMatches.length > 0
                ? ` + ${semanticMatches.length} semantic matches`
                : ''
            }`
          : semanticMatches.length > 0
            ? `No exact matches, but found ${semanticMatches.length} semantic matches for "${term}"`
            : `No matches found for "${term}"`,
      next_step:
        exactMatches.length > 0 || semanticMatches.length > 0
          ? 'Use synthesis_unfold(node_id) to get full details on any match.'
          : 'Try synthesis_search for semantic exploration, or check spelling.',
    };
  } catch (error) {
    return {
      error: 'Recall failed',
      message: error instanceof Error ? error.message : 'Unknown error',
      exact_matches: [],
      semantic_matches: [],
      search_latency_ms: Date.now() - startTime,
    };
  }
}

interface RawSearchArgs {
  query: string;
  mode?: 'text' | 'vector';
  limit?: number;
  min_score?: number;
  include_orphans?: boolean;
}

async function handleRawSearch(args: RawSearchArgs) {
  const { query, mode = 'text', limit = 20, min_score = 0.3, include_orphans = true } = args;
  const startTime = Date.now();

  try {
    if (!query || query.trim().length === 0) {
      return {
        error: 'Empty query',
        message: 'Query string is required',
        results: [],
      };
    }

    let results: Array<{
      id: string;
      session_id: string;
      content_type: string;
      content: string;
      timestamp: number;
      message_index: number | null;
      synthesis_node_id: string | null;
      score?: number;
    }>;

    if (mode === 'vector') {
      // Generate embedding for semantic search
      const queryEmbedding = await generateEmbedding(query);
      const vectorResults = await db.searchRawByVector(queryEmbedding, limit, min_score, include_orphans);
      results = vectorResults;
    } else {
      // Text-based substring search
      const textResults = await db.searchRawContentByText(query, limit, include_orphans);
      results = textResults;
    }

    const searchLatencyMs = Date.now() - startTime;

    return {
      results: results.map((rc) => ({
        id: rc.id,
        session_id: rc.session_id,
        content_type: rc.content_type,
        content: rc.content.length > 500 ? rc.content.slice(0, 500) + '...' : rc.content,
        full_content_length: rc.content.length,
        timestamp: rc.timestamp,
        message_index: rc.message_index,
        synthesis_node_id: rc.synthesis_node_id,
        is_orphan: rc.synthesis_node_id === null,
        score: 'score' in rc ? Math.round((rc.score as number) * 100) / 100 : undefined,
      })),
      total_results: results.length,
      search_latency_ms: searchLatencyMs,
      search_mode: mode,
      query,
      include_orphans,
      message:
        results.length > 0
          ? `Found ${results.length} raw content chunks (${mode} search)`
          : `No raw content found matching "${query}" (${mode} search)`,
    };
  } catch (error) {
    return {
      error: 'Raw search failed',
      message: error instanceof Error ? error.message : 'Unknown error',
      results: [],
      search_latency_ms: Date.now() - startTime,
    };
  }
}

// Start the server
async function main() {
  // Initialize database
  db = getDatabase();
  console.error('Database initialized at ~/.config/totalrecall/synthesis.sqlite');

  // Pre-load embedding model (async, don't block startup)
  initEmbeddings().catch((e) => {
    console.error('Warning: Failed to pre-load embedding model:', e);
  });

  // Initialize synthesis worker if API key is available and not in standalone mode
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const standaloneMode = process.env.SYNTHESIS_STANDALONE === 'true';

  if (apiKey && !standaloneMode) {
    const llmClient = new LLMSynthesisClient(apiKey);
    synthesisWorker = new SynthesisWorker(db, llmClient, {
      pollInterval: parseInt(process.env.SYNTHESIS_POLL_INTERVAL || '30000'),
      batchSize: parseInt(process.env.SYNTHESIS_BATCH_SIZE || '5'),
      maxRetries: parseInt(process.env.SYNTHESIS_MAX_RETRIES || '3'),
    });
    synthesisWorker.start().catch((e) => {
      console.error('Failed to start synthesis worker:', e);
    });
    console.error('Synthesis worker started (embedded mode)');
  } else if (standaloneMode) {
    console.error('Synthesis worker disabled (SYNTHESIS_STANDALONE=true)');
  } else {
    console.error('Synthesis worker disabled (no ANTHROPIC_API_KEY)');
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Total Recall MCP server started (standalone)');
}

main().catch((error) => {
  console.error('Failed to start MCP server:', error);
  process.exit(1);
});
