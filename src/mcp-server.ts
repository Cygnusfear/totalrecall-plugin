/**
 * Total Recall MCP Server
 *
 * This MCP server acts as a proxy to the coordinator's Total Recall tools.
 * It provides the same tool interface but forwards calls to the HTTP API.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { TotalRecallClient } from './client.js';

const TOTALRECALL_BASE_URL = process.env.TOTALRECALL_BASE_URL || 'http://localhost:3847';
const client = new TotalRecallClient(TOTALRECALL_BASE_URL);

const server = new Server(
  {
    name: 'totalrecall',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Tool definitions matching coordinator's totalrecall-tools.ts
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
        result = await client.create(args as unknown as Parameters<typeof client.create>[0]);
        break;

      case 'synthesis_search':
        result = await client.search(args as unknown as Parameters<typeof client.search>[0]);
        break;

      case 'synthesis_unfold':
        result = await client.unfold(args as unknown as Parameters<typeof client.unfold>[0]);
        break;

      case 'synthesis_get_context':
        result = await client.getContext(args as unknown as Parameters<typeof client.getContext>[0]);
        break;

      case 'session_graft':
        result = await client.sessionGraft(args as unknown as Parameters<typeof client.sessionGraft>[0]);
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

    // Check if coordinator is unavailable
    if (message.includes('ECONNREFUSED') || message.includes('fetch failed')) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'Coordinator unavailable',
              message: `Could not connect to Total Recall coordinator at ${TOTALRECALL_BASE_URL}`,
              hint: 'Start the coordinator with: cd ~/Node/dockram/coordinator && npm start',
            }),
          },
        ],
        isError: true,
      };
    }

    return {
      content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
      isError: true,
    };
  }
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Total Recall MCP server started');
}

main().catch((error) => {
  console.error('Failed to start MCP server:', error);
  process.exit(1);
});
