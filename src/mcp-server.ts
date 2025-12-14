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
import { getDatabase, SynthesisDatabase } from './db.js';
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
  const node = db.createNode({
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
    db.insertEmbedding(node.id, embedding);
  } catch (e) {
    console.error('Failed to generate embedding:', e);
    // Continue without embedding - search will be limited but node is created
  }

  // Create edges to related nodes
  const createdEdges: Array<{ to_node_id: string; edge_type: EdgeType }> = [];
  if (args.related_node_ids && args.related_node_ids.length > 0) {
    for (const nodeId of args.related_node_ids) {
      const exists = db.getNode(nodeId);
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

      db.createEdge({
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
    // Generate query embedding
    const queryEmbedding = await generateEmbedding(query);

    // Search using sqlite-vec (over-fetch to account for date filtering)
    let results = db.searchByVector(queryEmbedding, max_results * 2, min_score, node_types);

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
      db.createProgressiveDisclosureEvent({
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
      query,
      message:
        results.length > 0
          ? `Found ${results.length} relevant synthesis nodes`
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

async function handleSynthesisUnfold(args: SynthesisUnfoldArgs) {
  const { node_id, depth = 'summary' } = args;

  const node = db.getNode(node_id);
  if (!node) {
    return {
      error: 'Node not found',
      node_id,
      message: `Synthesis node ${node_id} does not exist`,
    };
  }

  // Track access
  db.updateNodeAccess(node_id);

  // Get related nodes
  const related = db.getRelatedNodes(node_id);
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
    // Full synthesis (no raw content storage in standalone)
    response.one_liner = node.one_liner;
    response.summary = node.summary;
    response.full_synthesis = node.full_synthesis;
    response.entity_name = node.entity_name;
    response.temporal_context = node.temporal_context;
    response.raw_refs = []; // Not implemented in standalone
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
      const searchResults = db.searchByVector(queryEmbedding, max_nodes, 0.3);

      // Fetch full nodes for search results
      syntheses = searchResults
        .map((r) => db.getNode(r.node_id))
        .filter((n): n is NonNullable<typeof n> => n !== undefined);
    } else {
      syntheses = db.queryNodes({
        session_id,
        limit: max_nodes,
        order_by: 'last_updated',
      });
    }

    // Get unfoldable refs (related nodes)
    const unfoldable_refs: Array<{ node_id: string; one_liner: string; edge_type?: string }> = [];

    if (include_related && syntheses.length > 0) {
      for (const node of syntheses.slice(0, 3)) {
        const related = db.getRelatedNodes(node.id);
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
      const searchResults = db.searchByVector(queryEmbedding, 10, 0.3);
      relevant_syntheses = searchResults
        .map((r) => db.getNode(r.node_id))
        .filter((n): n is NonNullable<typeof n> => n !== undefined);
    } else {
      relevant_syntheses = db.queryNodes({
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

    const queueItem = db.createSynthesisQueueItem({
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

    const items = db.getSynthesisQueueItems(filters);

    // Calculate stats
    const allItems = session_id
      ? db.getSynthesisQueueItems({ session_id, limit: 1000 })
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
    const stats = db.getProgressiveDisclosureAnalytics(startTime, now);

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
