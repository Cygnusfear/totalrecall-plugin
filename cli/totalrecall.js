#!/usr/bin/env node
/**
 * Total Recall CLI
 *
 * Commands:
 *   recent    - Get recent synthesis nodes (for hooks)
 *   search    - Search synthesis by query
 *   graft     - Graft a session to the synthesis graph
 *   create    - Create a synthesis node
 *   status    - Check coordinator status
 */

import { TotalRecallClient } from '../dist/client.js';

const client = new TotalRecallClient(process.env.TOTALRECALL_BASE_URL || 'http://localhost:3847');

async function main() {
  const [, , command, ...args] = process.argv;

  try {
    switch (command) {
      case 'recent': {
        const limit = parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1] || '5');
        const format = args.find(a => a.startsWith('--format='))?.split('=')[1] || 'text';

        const result = await client.getContext({ max_nodes: limit });

        if (format === 'json') {
          console.log(JSON.stringify(result.active_synthesis || []));
        } else {
          for (const node of result.active_synthesis || []) {
            console.log(`[${node.node_type}] ${node.one_liner}`);
          }
        }
        break;
      }

      case 'search': {
        const query = args.filter(a => !a.startsWith('--')).join(' ');
        if (!query) {
          console.error('Usage: totalrecall search <query>');
          process.exit(1);
        }

        const result = await client.search({ query, max_results: 5 });

        for (const node of result.results || []) {
          console.log(`[${node.node_type}] ${Math.round(node.relevance_score * 100)}% - ${node.one_liner}`);
        }
        break;
      }

      case 'graft': {
        const sessionId = args.find(a => a.startsWith('--session='))?.split('=')[1];
        const taskContext = args.filter(a => !a.startsWith('--')).join(' ');

        const result = await client.sessionGraft({
          session_id: sessionId || `cli-${Date.now()}`,
          task_context: taskContext || undefined
        });

        console.log(`Grafted session: ${result.session_node_id}`);
        console.log(`Loaded ${result.grafted_context?.relevant_syntheses?.length || 0} synthesis nodes`);
        break;
      }

      case 'create': {
        const nodeType = args.find(a => a.startsWith('--type='))?.split('=')[1] || 'learning';
        const oneLiner = args.filter(a => !a.startsWith('--')).join(' ');

        if (!oneLiner) {
          console.error('Usage: totalrecall create --type=decision "One liner description"');
          process.exit(1);
        }

        const result = await client.create({
          node_type: nodeType,
          one_liner: oneLiner,
          summary: oneLiner,
          full_synthesis: oneLiner,
          session_id: `cli-${Date.now()}`
        });

        console.log(`Created: ${result.node_id}`);
        break;
      }

      case 'status': {
        const health = await client.healthCheck();
        console.log(`Coordinator: ${health.ok ? 'online' : 'offline'}`);
        if (health.version) console.log(`Version: ${health.version}`);
        break;
      }

      default:
        console.log(`Total Recall CLI

Usage: totalrecall <command> [options]

Commands:
  recent [--limit=N] [--format=json|text]  Get recent synthesis nodes
  search <query>                           Search synthesis by semantic similarity
  graft [--session=ID] [task context]      Graft session to synthesis graph
  create --type=TYPE "one liner"           Create a synthesis node
  status                                   Check coordinator status

Environment:
  TOTALRECALL_BASE_URL  Coordinator URL (default: http://localhost:3847)
`);
        break;
    }
  } catch (error) {
    if (error.code === 'ECONNREFUSED') {
      console.error('ERROR: Coordinator not available at', process.env.TOTALRECALL_BASE_URL || 'http://localhost:3847');
      console.error('Start the coordinator with: cd ~/Node/dockram/coordinator && npm start');
    } else {
      console.error('ERROR:', error.message);
    }
    process.exit(1);
  }
}

main();
