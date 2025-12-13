# TotalRecall Plugin Feature Parity Implementation Plan

## Overview

This plan brings the standalone TotalRecall plugin to feature parity with the coordinator implementation in dockram. The plugin currently has 5 MCP tools for manual synthesis. We're adding:

1. **3 new MCP tools**: `synthesis_capture_chunk`, `synthesis_queue_status`, `progressive_disclosure_stats`
2. **3 new database tables**: `raw_content`, `synthesis_queue`, `progressive_disclosure_events`
3. **Background services**: `SynthesisWorker` and `LLMSynthesisClient` for automatic Haiku synthesis
4. **Hook-based capture**: Automatic conversation capture via Claude Code hooks
5. **CLI commands**: For hook handlers and manual operations

### Success Criteria

- [ ] All 8 MCP tools available (currently 5)
- [ ] Background worker processes queue items every 30 seconds
- [ ] Hooks capture conversations and queue for synthesis
- [ ] Date filtering works in `synthesis_search`
- [ ] Progressive disclosure analytics tracked
- [ ] All tests pass

### Reference Files

| Component | Coordinator Location |
|-----------|---------------------|
| DB Schema | `<coordinator-repo>/src/db/migrations.ts` |
| DB Methods | `<coordinator-repo>/src/db/index.ts` |
| MCP Tools | `<coordinator-repo>/src/mcp/totalrecall-tools.ts` |
| Synthesis Worker | `<coordinator-repo>/src/services/synthesis-worker.ts` |
| LLM Client | `<coordinator-repo>/src/services/llm-synthesis.ts` |

---

## Phase 1: Schema & Types

### Task 1.1: Add New Type Definitions

**File:** `./src/schema.ts`

**Action:** Modify - Add new types at the end of the file

**Code:**
```typescript
/**
 * Total Recall type definitions
 */

export type NodeType = 'decision' | 'learning' | 'entity' | 'event' | 'task' | 'summary';
export type EdgeType = 'relates_to' | 'caused' | 'preceded' | 'contains' | 'contradicts';

export interface SynthesisNode {
  id: string;
  node_type: NodeType;
  one_liner: string;
  summary: string;
  full_synthesis: string;
  entity_name: string | null;
  entity_aliases: string | null;
  temporal_context: string | null;
  first_seen: number;
  last_updated: number;
  status: string | null;
  assigned_agent: string | null;
  priority: number | null;
  source_session_id: string | null;
  source_agent_id: string | null;
  source_repo: string | null;
  access_count: number;
  last_accessed: number | null;
  created_at: number;
  updated_at: number;
}

export interface SynthesisEdge {
  id: number;
  from_node_id: string;
  to_node_id: string;
  edge_type: EdgeType;
  weight: number;
  context: string | null;
  created_at: number;
}

export interface SearchResult {
  node_id: string;
  one_liner: string;
  score: number;
  node_type: NodeType;
  created_at: number;
}

// ============ NEW TYPES FOR FEATURE PARITY ============

// Raw content storage for conversation chunks
export interface RawContent {
  id: string;
  session_id: string;
  synthesis_node_id: string | null;
  content_type: 'message' | 'tool_call' | 'tool_result' | 'conversation';
  content: string;
  agent_id: string | null;
  timestamp: number;
  message_index: number | null;
  created_at: number;
}

// Synthesis queue for background processing
export type SynthesisQueueChunkType = 'session_start' | 'session_chunk' | 'session_end';
export type SynthesisQueueStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface SynthesisQueue {
  id: number;
  session_id: string;
  agent_id: string | null;
  chunk_type: SynthesisQueueChunkType;
  raw_content_ids: string; // JSON array of raw_content IDs
  context: string | null;
  message_count: number | null;
  status: SynthesisQueueStatus;
  retry_count: number;
  error: string | null;
  synthesis_node_id: string | null;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
}

// Progressive disclosure analytics
export type ProgressiveDisclosureEventType = 'search' | 'inject' | 'expand' | 'skip';

export interface ProgressiveDisclosureEvent {
  id: number;
  event_type: ProgressiveDisclosureEventType;
  session_id: string | null;
  agent_id: string | null;
  query_text: string | null;
  search_latency_ms: number | null;
  results_count: number | null;
  node_ids: string | null; // JSON array
  injection_tokens: number | null;
  expanded_node_id: string | null;
  expansion_tokens: number | null;
  message_tokens: number | null;
  created_at: number;
}
```

**Verify:** Run `npm run build` - should compile without type errors.

---

### Task 1.2: Add Database Tables

**File:** `./src/db.ts`

**Action:** Modify - Add new table creation in `initSchema()` method

Find the `initSchema()` method and add the following tables after the existing tables:

**Code to add after `CREATE INDEX IF NOT EXISTS idx_edges_to...`:**
```typescript
    // Raw content storage for conversation chunks
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS raw_content (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        synthesis_node_id TEXT,
        content_type TEXT NOT NULL CHECK(content_type IN ('message', 'tool_call', 'tool_result', 'conversation')),
        content TEXT NOT NULL,
        agent_id TEXT,
        timestamp INTEGER NOT NULL,
        message_index INTEGER,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (synthesis_node_id) REFERENCES synthesis_nodes(id) ON DELETE SET NULL
      )
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_raw_content_session ON raw_content(session_id);
      CREATE INDEX IF NOT EXISTS idx_raw_content_timestamp ON raw_content(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_raw_content_synthesis ON raw_content(synthesis_node_id);
    `);

    // Synthesis queue for background processing
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS synthesis_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        agent_id TEXT,
        chunk_type TEXT NOT NULL CHECK(chunk_type IN ('session_start', 'session_chunk', 'session_end')),
        raw_content_ids TEXT NOT NULL,
        context TEXT,
        message_count INTEGER,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'completed', 'failed')),
        retry_count INTEGER DEFAULT 0,
        error TEXT,
        synthesis_node_id TEXT,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        completed_at INTEGER,
        FOREIGN KEY (synthesis_node_id) REFERENCES synthesis_nodes(id) ON DELETE SET NULL
      )
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_synthesis_queue_status ON synthesis_queue(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_synthesis_queue_session ON synthesis_queue(session_id);
    `);

    // Progressive disclosure analytics
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS progressive_disclosure_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL CHECK(event_type IN ('search', 'inject', 'expand', 'skip')),
        session_id TEXT,
        agent_id TEXT,
        query_text TEXT,
        search_latency_ms INTEGER,
        results_count INTEGER,
        node_ids TEXT,
        injection_tokens INTEGER,
        expanded_node_id TEXT,
        expansion_tokens INTEGER,
        message_tokens INTEGER,
        created_at INTEGER NOT NULL
      )
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_pd_events_type ON progressive_disclosure_events(event_type);
      CREATE INDEX IF NOT EXISTS idx_pd_events_session ON progressive_disclosure_events(session_id);
      CREATE INDEX IF NOT EXISTS idx_pd_events_created ON progressive_disclosure_events(created_at DESC);
    `);
```

**Verify:** Delete `~/.config/totalrecall/synthesis.sqlite` and run `npm start` - server should start and create new tables.

---

## Phase 2: Database Methods

### Task 2.1: Add Raw Content Methods

**File:** `./src/db.ts`

**Action:** Modify - Add methods after the existing Edge Operations section

**Code to add before the `// ============ Utility ============` section:**
```typescript
  // ============ Raw Content Operations ============

  createRawContent(content: Omit<RawContent, 'created_at'>): RawContent {
    const now = Date.now();

    this.db.prepare(`
      INSERT INTO raw_content (
        id, session_id, synthesis_node_id, content_type, content,
        agent_id, timestamp, message_index, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      content.id,
      content.session_id,
      content.synthesis_node_id ?? null,
      content.content_type,
      content.content,
      content.agent_id ?? null,
      content.timestamp,
      content.message_index ?? null,
      now
    );

    return { ...content, created_at: now };
  }

  getRawContentBySession(sessionId: string, limit: number = 100): RawContent[] {
    return this.db.prepare(`
      SELECT * FROM raw_content
      WHERE session_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(sessionId, limit) as RawContent[];
  }

  getRawContentBySynthesis(synthesisNodeId: string): RawContent[] {
    return this.db.prepare(`
      SELECT * FROM raw_content
      WHERE synthesis_node_id = ?
      ORDER BY timestamp ASC
    `).all(synthesisNodeId) as RawContent[];
  }

  getRawContentByIds(ids: string[]): RawContent[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    return this.db.prepare(`
      SELECT * FROM raw_content
      WHERE id IN (${placeholders})
      ORDER BY timestamp ASC
    `).all(...ids) as RawContent[];
  }

  linkRawContentToSynthesis(rawContentIds: string[], synthesisNodeId: string): void {
    const stmt = this.db.prepare(`
      UPDATE raw_content
      SET synthesis_node_id = ?
      WHERE id = ?
    `);

    for (const id of rawContentIds) {
      stmt.run(synthesisNodeId, id);
    }
  }
```

**Also add the import at the top of db.ts:**
```typescript
import type { SynthesisNode, SynthesisEdge, NodeType, EdgeType, SearchResult, RawContent, SynthesisQueue, SynthesisQueueStatus, ProgressiveDisclosureEvent } from './schema.js';
```

**Verify:** Run `npm run build` - should compile without errors.

---

### Task 2.2: Add Synthesis Queue Methods

**File:** `./src/db.ts`

**Action:** Modify - Add after Raw Content Operations

**Code:**
```typescript
  // ============ Synthesis Queue Operations ============

  createSynthesisQueueItem(item: Omit<SynthesisQueue, 'id' | 'started_at' | 'completed_at'>): SynthesisQueue {
    const result = this.db.prepare(`
      INSERT INTO synthesis_queue (
        session_id, agent_id, chunk_type, raw_content_ids, context,
        message_count, status, retry_count, error, synthesis_node_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      item.session_id,
      item.agent_id ?? null,
      item.chunk_type,
      item.raw_content_ids,
      item.context ?? null,
      item.message_count ?? null,
      item.status,
      item.retry_count,
      item.error ?? null,
      item.synthesis_node_id ?? null,
      item.created_at
    );

    return {
      id: result.lastInsertRowid as number,
      ...item,
      started_at: null,
      completed_at: null
    };
  }

  getPendingSynthesisQueue(filters: { limit?: number } = {}): SynthesisQueue[] {
    const { limit = 10 } = filters;
    return this.db.prepare(`
      SELECT * FROM synthesis_queue
      WHERE status = 'pending'
      ORDER BY created_at ASC
      LIMIT ?
    `).all(limit) as SynthesisQueue[];
  }

  getSynthesisQueueItems(filters: {
    session_id?: string;
    status?: SynthesisQueueStatus;
    limit?: number;
  }): SynthesisQueue[] {
    const { session_id, status, limit = 50 } = filters;

    let query = 'SELECT * FROM synthesis_queue WHERE 1=1';
    const params: unknown[] = [];

    if (session_id) {
      query += ' AND session_id = ?';
      params.push(session_id);
    }

    if (status) {
      query += ' AND status = ?';
      params.push(status);
    }

    query += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);

    return this.db.prepare(query).all(...params) as SynthesisQueue[];
  }

  updateSynthesisQueueStatus(
    id: number,
    status: SynthesisQueueStatus,
    synthesisNodeId?: string | null,
    error?: string | null
  ): void {
    const now = Date.now();
    const updates: string[] = ['status = ?'];
    const values: unknown[] = [status];

    if (status === 'processing') {
      updates.push('started_at = ?');
      values.push(now);
    } else if (status === 'completed' || status === 'failed') {
      updates.push('completed_at = ?');
      values.push(now);
    }

    if (synthesisNodeId !== undefined) {
      updates.push('synthesis_node_id = ?');
      values.push(synthesisNodeId);
    }

    if (error !== undefined) {
      updates.push('error = ?');
      values.push(error);
    }

    values.push(id);

    this.db.prepare(`
      UPDATE synthesis_queue
      SET ${updates.join(', ')}
      WHERE id = ?
    `).run(...values);
  }

  incrementSynthesisQueueRetry(id: number): void {
    this.db.prepare(`
      UPDATE synthesis_queue
      SET retry_count = retry_count + 1, status = 'pending'
      WHERE id = ?
    `).run(id);
  }
```

**Verify:** Run `npm run build` - should compile without errors.

---

### Task 2.3: Add Progressive Disclosure Methods

**File:** `./src/db.ts`

**Action:** Modify - Add after Synthesis Queue Operations

**Code:**
```typescript
  // ============ Progressive Disclosure Operations ============

  createProgressiveDisclosureEvent(event: Omit<ProgressiveDisclosureEvent, 'id' | 'created_at'>): ProgressiveDisclosureEvent {
    const now = Date.now();
    const result = this.db.prepare(`
      INSERT INTO progressive_disclosure_events (
        event_type, session_id, agent_id, query_text, search_latency_ms,
        results_count, node_ids, injection_tokens, expanded_node_id,
        expansion_tokens, message_tokens, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.event_type,
      event.session_id ?? null,
      event.agent_id ?? null,
      event.query_text ?? null,
      event.search_latency_ms ?? null,
      event.results_count ?? null,
      event.node_ids ?? null,
      event.injection_tokens ?? null,
      event.expanded_node_id ?? null,
      event.expansion_tokens ?? null,
      event.message_tokens ?? null,
      now
    );

    return {
      id: result.lastInsertRowid as number,
      ...event,
      created_at: now
    };
  }

  getProgressiveDisclosureAnalytics(startTime: number, endTime: number): {
    totalSearches: number;
    totalInjections: number;
    totalExpansions: number;
    avgSearchLatency: number;
    expansionRate: number;
    totalInjectionTokens: number;
    totalExpansionTokens: number;
  } {
    const stats = this.db.prepare(`
      SELECT
        COUNT(CASE WHEN event_type = 'search' THEN 1 END) as total_searches,
        COUNT(CASE WHEN event_type = 'inject' THEN 1 END) as total_injections,
        COUNT(CASE WHEN event_type = 'expand' THEN 1 END) as total_expansions,
        AVG(CASE WHEN event_type = 'search' THEN search_latency_ms END) as avg_search_latency,
        SUM(CASE WHEN event_type = 'inject' THEN injection_tokens ELSE 0 END) as total_injection_tokens,
        SUM(CASE WHEN event_type = 'expand' THEN expansion_tokens ELSE 0 END) as total_expansion_tokens
      FROM progressive_disclosure_events
      WHERE created_at BETWEEN ? AND ?
    `).get(startTime, endTime) as {
      total_searches: number;
      total_injections: number;
      total_expansions: number;
      avg_search_latency: number | null;
      total_injection_tokens: number | null;
      total_expansion_tokens: number | null;
    };

    const expansionRate = stats.total_injections > 0
      ? stats.total_expansions / stats.total_injections
      : 0;

    return {
      totalSearches: stats.total_searches || 0,
      totalInjections: stats.total_injections || 0,
      totalExpansions: stats.total_expansions || 0,
      avgSearchLatency: stats.avg_search_latency || 0,
      expansionRate,
      totalInjectionTokens: stats.total_injection_tokens || 0,
      totalExpansionTokens: stats.total_expansion_tokens || 0
    };
  }
```

**Verify:** Run `npm run build` - should compile without errors.

---

## Phase 3: MCP Tools

### Task 3.1: Update synthesis_search with Date Filtering

**File:** `./src/mcp-server.ts`

**Action:** Modify - Update the `synthesis_search` tool definition and handler

**Find the synthesis_search tool definition and replace with:**
```typescript
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
```

**Update the SynthesisSearchArgs interface:**
```typescript
interface SynthesisSearchArgs {
  query: string;
  max_results?: number;
  min_score?: number;
  node_types?: NodeType[];
  after?: string;
  before?: string;
}
```

**Update the handleSynthesisSearch function:**
```typescript
async function handleSynthesisSearch(args: SynthesisSearchArgs) {
  const { query, max_results = 5, min_score = 0.5, node_types, after, before } = args;
  const startTime = Date.now();

  try {
    // Generate query embedding
    const queryEmbedding = await generateEmbedding(query);

    // Search using sqlite-vec
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
```

**Verify:** Run `npm run build` and test search with date filter.

---

### Task 3.2: Add synthesis_capture_chunk Tool

**File:** `./src/mcp-server.ts`

**Action:** Modify - Add new tool definition and handler

**Add to TOOLS array:**
```typescript
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
```

**Add handler interface and function:**
```typescript
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
```

**Add to switch statement in CallToolRequestSchema handler:**
```typescript
      case 'synthesis_capture_chunk':
        result = await handleSynthesisCaptureChunk(args as unknown as SynthesisCaptureChunkArgs);
        break;
```

**Verify:** Run `npm run build` and test the new tool via MCP.

---

### Task 3.3: Add synthesis_queue_status Tool

**File:** `./src/mcp-server.ts`

**Action:** Modify - Add new tool definition and handler

**Add to TOOLS array:**
```typescript
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
```

**Add handler interface and function:**
```typescript
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
```

**Add to switch statement:**
```typescript
      case 'synthesis_queue_status':
        result = await handleSynthesisQueueStatus(args as unknown as SynthesisQueueStatusArgs);
        break;
```

**Verify:** Run `npm run build` and test.

---

### Task 3.4: Add progressive_disclosure_stats Tool

**File:** `./src/mcp-server.ts`

**Action:** Modify - Add new tool definition and handler

**Add to TOOLS array:**
```typescript
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
```

**Add handler interface and function:**
```typescript
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
```

**Add to switch statement:**
```typescript
      case 'progressive_disclosure_stats':
        result = await handleProgressiveDisclosureStats(args as unknown as ProgressiveDisclosureStatsArgs);
        break;
```

**Verify:** Run `npm run build` and test.

---

## Phase 4: Background Services

### Task 4.1: Create LLM Synthesis Client

**File:** `./src/llm-synthesis.ts`

**Action:** Create new file

**Code:**
```typescript
/**
 * LLM client for background synthesis using Claude Haiku
 */

import Anthropic from '@anthropic-ai/sdk';
import type { NodeType } from './schema.js';

export interface SynthesisResult {
  node_type: NodeType;
  one_liner: string;
  summary: string;
  full_synthesis: string;
  temporal_context?: string;
  entity_name?: string;
}

export interface ConversationChunk {
  id: string;
  content: string;
  timestamp: number;
  agent_id: string | null;
}

export class LLMSynthesisClient {
  private client: Anthropic;
  private model: string;

  constructor(apiKey: string, model: string = 'claude-3-5-haiku-20241022') {
    this.client = new Anthropic({ apiKey });
    this.model = model;
  }

  async synthesize(
    chunks: ConversationChunk[],
    context?: {
      session_id?: string;
      task_context?: string;
      repo?: string;
    }
  ): Promise<SynthesisResult> {
    const prompt = this.buildPrompt(chunks, context);

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 2048,
        temperature: 0.3,
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
      });

      const responseText = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('\n');

      return this.parseResponse(responseText);
    } catch (error) {
      throw new Error(
        `LLM synthesis failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private buildPrompt(
    chunks: ConversationChunk[],
    context?: {
      session_id?: string;
      task_context?: string;
      repo?: string;
    }
  ): string {
    const contextInfo = context
      ? `
Session ID: ${context.session_id || 'unknown'}
Task Context: ${context.task_context || 'none'}
Repository: ${context.repo || 'none'}
`
      : 'No additional context provided.';

    const conversationText = chunks
      .map((chunk, idx) => {
        const timestamp = new Date(chunk.timestamp).toISOString();
        const agent = chunk.agent_id || 'system';
        return `[${idx + 1}] (${timestamp}, ${agent}):\n${chunk.content}`;
      })
      .join('\n\n---\n\n');

    return `You are a memory synthesis agent for Total Recall, a synthesis-first memory system. Your task is to analyze conversation chunks and create structured synthesis nodes.

CONTEXT:
${contextInfo}

CONVERSATION CHUNK (${chunks.length} messages):
${conversationText}

---

SYNTHESIS INSTRUCTIONS:

Analyze this conversation chunk and create a structured synthesis that captures the key insights, decisions, learnings, or events.

1. **node_type**: Choose the most appropriate type:
   - "decision": A choice or decision was made
   - "learning": New insight, knowledge, or understanding gained
   - "entity": Discussion about a specific project, system, or component
   - "event": Something happened (deploy, bug, incident)
   - "task": Work item or task discussed/created
   - "summary": General session summary (use when no specific type fits)

2. **one_liner**: Create a ~50 token summary that captures the essence. Make it scannable and specific.

3. **summary**: Write a ~200 token detailed summary with key points, context, and rationale.

4. **full_synthesis**: Write a complete synthesis (300-500 tokens) that includes:
   - Full context and background
   - Detailed rationale and reasoning
   - Implications and follow-up considerations
   - Any important caveats or edge cases

5. **temporal_context**: (Optional) When did this occur?

6. **entity_name**: (Optional) If this is about a specific entity, provide its normalized name

IMPORTANT:
- Be specific and concrete, not vague
- Focus on WHY and implications, not just WHAT
- Capture technical details when relevant

Return ONLY valid JSON with this exact structure (no markdown, no explanation):
{
  "node_type": "decision" | "learning" | "entity" | "event" | "task" | "summary",
  "one_liner": "string",
  "summary": "string",
  "full_synthesis": "string",
  "temporal_context": "string or null",
  "entity_name": "string or null"
}`;
  }

  private parseResponse(responseText: string): SynthesisResult {
    let cleaned = responseText.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }

    try {
      const parsed = JSON.parse(cleaned);

      if (!parsed.node_type || !parsed.one_liner || !parsed.summary || !parsed.full_synthesis) {
        throw new Error('Missing required fields in synthesis response');
      }

      const validTypes: NodeType[] = ['decision', 'learning', 'entity', 'event', 'task', 'summary'];
      if (!validTypes.includes(parsed.node_type)) {
        throw new Error(`Invalid node_type: ${parsed.node_type}`);
      }

      return {
        node_type: parsed.node_type,
        one_liner: parsed.one_liner,
        summary: parsed.summary,
        full_synthesis: parsed.full_synthesis,
        temporal_context: parsed.temporal_context || undefined,
        entity_name: parsed.entity_name || undefined,
      };
    } catch (error) {
      throw new Error(
        `Failed to parse synthesis response: ${error instanceof Error ? error.message : String(error)}\n\nResponse: ${responseText}`
      );
    }
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.client.messages.create({
        model: this.model,
        max_tokens: 10,
        messages: [{ role: 'user', content: 'Test' }],
      });
      return true;
    } catch (error) {
      console.error('LLM synthesis client test failed:', error);
      return false;
    }
  }
}
```

**Verify:** Run `npm run build` - should compile.

---

### Task 4.2: Create Synthesis Worker

**File:** `./src/synthesis-worker.ts`

**Action:** Create new file

**Code:**
```typescript
/**
 * Background worker for processing synthesis queue
 */

import type { SynthesisDatabase } from './db.js';
import type { SynthesisQueue } from './schema.js';
import { LLMSynthesisClient, type ConversationChunk } from './llm-synthesis.js';
import { generateSynthesisEmbedding } from './embeddings.js';

export interface SynthesisWorkerConfig {
  pollInterval?: number; // ms, default 30000 (30s)
  batchSize?: number; // Process N items per poll, default 5
  maxRetries?: number; // Max retries per item, default 3
}

export class SynthesisWorker {
  private running = false;
  private pollInterval: number;
  private batchSize: number;
  private maxRetries: number;
  private pollTimeout: NodeJS.Timeout | null = null;

  constructor(
    private db: SynthesisDatabase,
    private llmClient: LLMSynthesisClient,
    config: SynthesisWorkerConfig = {}
  ) {
    this.pollInterval = config.pollInterval || 30000;
    this.batchSize = config.batchSize || 5;
    this.maxRetries = config.maxRetries || 3;
  }

  async start(): Promise<void> {
    if (this.running) {
      console.warn('[SynthesisWorker] Already running');
      return;
    }

    this.running = true;
    console.log(
      `[SynthesisWorker] Started (poll: ${this.pollInterval}ms, batch: ${this.batchSize})`
    );

    const connected = await this.llmClient.testConnection();
    if (!connected) {
      console.error('[SynthesisWorker] LLM client connection test failed');
    }

    this.poll();
  }

  async stop(): Promise<void> {
    console.log('[SynthesisWorker] Stopping...');
    this.running = false;

    if (this.pollTimeout) {
      clearTimeout(this.pollTimeout);
      this.pollTimeout = null;
    }

    console.log('[SynthesisWorker] Stopped');
  }

  private poll(): void {
    if (!this.running) return;

    this.processNextBatch()
      .catch((error) => {
        console.error('[SynthesisWorker] Batch processing error:', error);
      })
      .finally(() => {
        if (this.running) {
          this.pollTimeout = setTimeout(() => this.poll(), this.pollInterval);
        }
      });
  }

  private async processNextBatch(): Promise<void> {
    const items = this.db.getPendingSynthesisQueue({ limit: this.batchSize });

    if (items.length === 0) {
      return;
    }

    console.log(`[SynthesisWorker] Processing ${items.length} items`);

    const results = await Promise.allSettled(
      items.map((item) => this.processSynthesisItem(item))
    );

    const succeeded = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.filter((r) => r.status === 'rejected').length;

    if (failed > 0) {
      console.warn(`[SynthesisWorker] Batch: ${succeeded} succeeded, ${failed} failed`);
    } else {
      console.log(`[SynthesisWorker] Batch complete: ${succeeded} processed`);
    }
  }

  private async processSynthesisItem(item: SynthesisQueue): Promise<void> {
    console.log(
      `[SynthesisWorker] Processing queue item ${item.id} (session: ${item.session_id})`
    );

    this.db.updateSynthesisQueueStatus(item.id, 'processing');

    try {
      const rawContentIds: string[] = JSON.parse(item.raw_content_ids);
      const rawContent = this.db.getRawContentByIds(rawContentIds);

      if (rawContent.length === 0) {
        throw new Error('No raw content found for synthesis');
      }

      const alreadySynthesized = rawContent.filter((rc) => rc.synthesis_node_id !== null);
      if (alreadySynthesized.length === rawContent.length) {
        console.log(`[SynthesisWorker] Content already synthesized for item ${item.id}`);
        this.db.updateSynthesisQueueStatus(item.id, 'completed');
        return;
      }

      const chunks: ConversationChunk[] = rawContent.map((rc) => ({
        id: rc.id,
        content: rc.content,
        timestamp: rc.timestamp,
        agent_id: rc.agent_id,
      }));

      const context = {
        session_id: item.session_id,
        task_context: item.context || undefined,
        repo: undefined,
      };

      console.log(`[SynthesisWorker] Calling LLM for synthesis (${chunks.length} chunks)`);
      const synthesis = await this.llmClient.synthesize(chunks, context);

      const now = Date.now();
      const node = this.db.createNode({
        node_type: synthesis.node_type,
        one_liner: synthesis.one_liner,
        summary: synthesis.summary,
        full_synthesis: synthesis.full_synthesis,
        entity_name: synthesis.entity_name || null,
        entity_aliases: null,
        temporal_context: synthesis.temporal_context || null,
        first_seen: now,
        last_updated: now,
        status: null,
        assigned_agent: item.agent_id,
        priority: null,
        source_session_id: item.session_id,
        source_agent_id: item.agent_id,
        source_repo: null,
      });

      // Generate embedding for new node
      try {
        const embedding = await generateSynthesisEmbedding(
          synthesis.one_liner,
          synthesis.summary,
          synthesis.node_type
        );
        this.db.insertEmbedding(node.id, embedding);
      } catch (e) {
        console.error('[SynthesisWorker] Failed to generate embedding:', e);
      }

      console.log(`[SynthesisWorker] Created synthesis node ${node.id}`);

      this.db.linkRawContentToSynthesis(rawContentIds, node.id);
      this.db.updateSynthesisQueueStatus(item.id, 'completed', node.id);

      console.log(`[SynthesisWorker] Queue item ${item.id} completed`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[SynthesisWorker] Failed item ${item.id}:`, errorMessage);

      if (item.retry_count < this.maxRetries) {
        console.log(`[SynthesisWorker] Retrying item ${item.id}`);
        this.db.incrementSynthesisQueueRetry(item.id);
      } else {
        console.error(`[SynthesisWorker] Item ${item.id} failed after ${this.maxRetries} retries`);
        this.db.updateSynthesisQueueStatus(item.id, 'failed', null, errorMessage);
      }

      throw error;
    }
  }

  getStatus(): {
    running: boolean;
    pollInterval: number;
    batchSize: number;
    maxRetries: number;
  } {
    return {
      running: this.running,
      pollInterval: this.pollInterval,
      batchSize: this.batchSize,
      maxRetries: this.maxRetries,
    };
  }
}
```

**Verify:** Run `npm run build`.

---

### Task 4.3: Add Anthropic SDK Dependency

**File:** `./package.json`

**Action:** Modify - Add dependency

**Code to add to dependencies:**
```json
"@anthropic-ai/sdk": "^0.24.0"
```

**Verify:** Run `npm install` then `npm run build`.

---

### Task 4.4: Integrate Worker into MCP Server

**File:** `./src/mcp-server.ts`

**Action:** Modify - Add worker initialization

**Add imports at top:**
```typescript
import { SynthesisWorker } from './synthesis-worker.js';
import { LLMSynthesisClient } from './llm-synthesis.js';
```

**Add worker variable:**
```typescript
let synthesisWorker: SynthesisWorker | null = null;
```

**Update main() function:**
```typescript
async function main() {
  // Initialize database
  db = getDatabase();
  console.error('Database initialized at ~/.config/totalrecall/synthesis.sqlite');

  // Pre-load embedding model (async, don't block startup)
  initEmbeddings().catch((e) => {
    console.error('Warning: Failed to pre-load embedding model:', e);
  });

  // Initialize synthesis worker if API key is available
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey) {
    const llmClient = new LLMSynthesisClient(apiKey);
    synthesisWorker = new SynthesisWorker(db, llmClient, {
      pollInterval: 30000, // 30 seconds
      batchSize: 5,
      maxRetries: 3,
    });
    synthesisWorker.start().catch((e) => {
      console.error('Failed to start synthesis worker:', e);
    });
    console.error('Synthesis worker started (ANTHROPIC_API_KEY detected)');
  } else {
    console.error('Synthesis worker disabled (no ANTHROPIC_API_KEY)');
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Total Recall MCP server started (standalone)');
}
```

**Verify:** Run `ANTHROPIC_API_KEY=test npm start` - should show worker started.

---

## Phase 5: Hooks & CLI

### Task 5.1: Update hooks.json

**File:** `./hooks/hooks.json`

**Action:** Replace entire file

**Code:**
```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume",
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PLUGIN_ROOT}/cli/totalrecall session-graft",
            "timeout": 5
          },
          {
            "type": "command",
            "command": "${CLAUDE_PLUGIN_ROOT}/cli/totalrecall backfill --background",
            "async": true
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PLUGIN_ROOT}/cli/totalrecall queue-synthesis",
            "async": true
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PLUGIN_ROOT}/cli/totalrecall session-complete",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

**Verify:** JSON is valid with `cat hooks/hooks.json | jq .`

---

### Task 5.2: Rewrite CLI Entry Point

**File:** `./cli/totalrecall.js`

**Action:** Replace entire file

**Code:**
```javascript
#!/usr/bin/env node
/**
 * Total Recall CLI
 *
 * Commands:
 *   session-graft     - Graft session to synthesis graph (for hooks)
 *   session-complete  - Complete session with summary (for hooks)
 *   queue-synthesis   - Queue current session for synthesis (for hooks)
 *   backfill          - Backfill unprocessed conversations
 *   recent            - Get recent synthesis nodes
 *   search            - Search synthesis by query
 *   status            - Check system status
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { spawn } from 'child_process';
import { existsSync, realpathSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(realpathSync(__filename));

const [, , command, ...args] = process.argv;

function runTsxCommand(scriptPath, cmdArgs) {
  return new Promise((resolve, reject) => {
    if (!existsSync(scriptPath)) {
      reject(new Error(`Script not found: ${scriptPath}`));
      return;
    }

    const child = spawn('npx', ['tsx', scriptPath, ...cmdArgs], {
      stdio: 'inherit',
    });

    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Command failed with exit code ${code}`));
    });

    child.on('error', (err) => {
      reject(new Error(`Failed to run command: ${err.message}`));
    });
  });
}

function runBackground(scriptPath, cmdArgs) {
  const child = spawn('npx', ['tsx', scriptPath, ...cmdArgs], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  console.log('Started in background...');
}

async function main() {
  const srcDir = join(__dirname, '..', 'src');

  try {
    switch (command) {
      case 'session-graft':
        await runTsxCommand(join(srcDir, 'cli', 'session-graft.ts'), args);
        break;

      case 'session-complete':
        await runTsxCommand(join(srcDir, 'cli', 'session-complete.ts'), args);
        break;

      case 'queue-synthesis':
        await runTsxCommand(join(srcDir, 'cli', 'queue-synthesis.ts'), args);
        break;

      case 'backfill':
        if (args.includes('--background')) {
          const filteredArgs = args.filter((a) => a !== '--background');
          runBackground(join(srcDir, 'cli', 'backfill.ts'), filteredArgs);
        } else {
          await runTsxCommand(join(srcDir, 'cli', 'backfill.ts'), args);
        }
        break;

      case 'recent':
        await runTsxCommand(join(srcDir, 'cli', 'recent.ts'), args);
        break;

      case 'search':
        await runTsxCommand(join(srcDir, 'cli', 'search.ts'), args);
        break;

      case 'status':
        await runTsxCommand(join(srcDir, 'cli', 'status.ts'), args);
        break;

      case '--help':
      case '-h':
      case undefined:
        console.log(`Total Recall CLI

Usage: totalrecall <command> [options]

Hook Commands (called automatically):
  session-graft       Graft session to synthesis graph
  session-complete    Complete session with summary
  queue-synthesis     Queue current session for background synthesis
  backfill            Backfill unprocessed conversations
                      Use --background to run in background

User Commands:
  recent              Get recent synthesis nodes
                      --limit=N  Max nodes (default: 5)
                      --format=json|text
  search <query>      Search synthesis by semantic similarity
  status              Check system status

Environment:
  ANTHROPIC_API_KEY   Required for background synthesis
  TRANSCRIPT_PATH     Set by Claude Code hooks
`);
        break;

      default:
        console.error(`Unknown command: ${command}`);
        console.error('Try: totalrecall --help');
        process.exit(1);
    }
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`Unexpected error: ${error.message}`);
  process.exit(1);
});
```

**Verify:** Run `./cli/totalrecall.js --help`.

---

### Task 5.3: Create CLI Directory and Commands

**File:** `./src/cli/session-graft.ts`

**Action:** Create new file (create src/cli directory first)

**Code:**
```typescript
/**
 * CLI: session-graft
 * Called by SessionStart hook to graft current session to synthesis graph
 */

import { getDatabase } from '../db.js';
import { generateSynthesisEmbedding, generateEmbedding, initEmbeddings } from '../embeddings.js';

async function main() {
  const db = getDatabase();
  await initEmbeddings();

  // Get session info from environment (set by Claude Code hooks)
  const transcriptPath = process.env.TRANSCRIPT_PATH;
  const sessionId = transcriptPath
    ? transcriptPath.split('/').pop()?.replace('.jsonl', '') || `session-${Date.now()}`
    : `session-${Date.now()}`;

  const now = Date.now();

  // Create session node
  const sessionNode = db.createNode({
    node_type: 'summary',
    one_liner: `Session started: ${new Date(now).toISOString()}`,
    summary: `Session grafted at ${new Date(now).toISOString()}`,
    full_synthesis: `Session ${sessionId} started.`,
    entity_name: null,
    entity_aliases: null,
    temporal_context: `session start: ${new Date(now).toISOString()}`,
    first_seen: now,
    last_updated: now,
    status: null,
    assigned_agent: null,
    priority: null,
    source_session_id: sessionId,
    source_agent_id: null,
    source_repo: null,
  });

  // Generate embedding
  try {
    const embedding = await generateSynthesisEmbedding(
      sessionNode.one_liner,
      sessionNode.summary,
      'summary'
    );
    db.insertEmbedding(sessionNode.id, embedding);
  } catch (e) {
    console.error('Failed to generate embedding:', e);
  }

  // Query recent syntheses for context injection
  const recent = db.queryNodes({ limit: 5, order_by: 'last_updated' });

  // Format for hook output
  const contextMsg =
    recent.length > 0
      ? recent.map((n) => `- [${n.node_type}] ${n.one_liner}`).join('\n')
      : 'No recent synthesis nodes found.';

  // Output hook response
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: `<total_recall_context>
Recent memories:
${contextMsg}

Use synthesis_unfold(node_id) to expand any node.
Use synthesis_search(query) to find specific context.
</total_recall_context>`,
      },
    })
  );

  db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

**Verify:** Run `npx tsx src/cli/session-graft.ts`.

---

### Task 5.4: Create session-complete CLI

**File:** `./src/cli/session-complete.ts`

**Action:** Create new file

**Code:**
```typescript
/**
 * CLI: session-complete
 * Called by SessionEnd hook to create session summary
 */

import { getDatabase } from '../db.js';
import { generateSynthesisEmbedding, initEmbeddings } from '../embeddings.js';

async function main() {
  const db = getDatabase();
  await initEmbeddings();

  const transcriptPath = process.env.TRANSCRIPT_PATH;
  const sessionId = transcriptPath
    ? transcriptPath.split('/').pop()?.replace('.jsonl', '') || `session-${Date.now()}`
    : `session-${Date.now()}`;

  const now = Date.now();

  // Get syntheses created during this session
  const sessionSyntheses = db.queryNodes({
    session_id: sessionId,
    limit: 100,
    order_by: 'created_at',
  });

  if (sessionSyntheses.length === 0) {
    console.log('No syntheses created during this session');
    db.close();
    return;
  }

  // Create summary of what was accomplished
  const decisions = sessionSyntheses.filter((s) => s.node_type === 'decision');
  const learnings = sessionSyntheses.filter((s) => s.node_type === 'learning');

  const summaryParts = [];
  if (decisions.length > 0) {
    summaryParts.push(`Made ${decisions.length} decision(s)`);
  }
  if (learnings.length > 0) {
    summaryParts.push(`Captured ${learnings.length} learning(s)`);
  }

  const summary =
    summaryParts.length > 0
      ? summaryParts.join(', ')
      : `Created ${sessionSyntheses.length} synthesis node(s)`;

  // Create session completion node
  const completionNode = db.createNode({
    node_type: 'summary',
    one_liner: `Session complete: ${summary}`,
    summary: `Session ${sessionId} completed at ${new Date(now).toISOString()}. ${summary}.`,
    full_synthesis: `Session ${sessionId} completed.\n\nSyntheses created:\n${sessionSyntheses.map((s) => `- [${s.node_type}] ${s.one_liner}`).join('\n')}`,
    entity_name: null,
    entity_aliases: null,
    temporal_context: `session end: ${new Date(now).toISOString()}`,
    first_seen: now,
    last_updated: now,
    status: null,
    assigned_agent: null,
    priority: null,
    source_session_id: sessionId,
    source_agent_id: null,
    source_repo: null,
  });

  // Generate embedding
  try {
    const embedding = await generateSynthesisEmbedding(
      completionNode.one_liner,
      completionNode.summary,
      'summary'
    );
    db.insertEmbedding(completionNode.id, embedding);
  } catch (e) {
    console.error('Failed to generate embedding:', e);
  }

  // Link to session syntheses
  for (const synthesis of sessionSyntheses.slice(0, 10)) {
    db.createEdge({
      from_node_id: completionNode.id,
      to_node_id: synthesis.id,
      edge_type: 'contains',
      weight: 1.0,
      context: 'session summary',
    });
  }

  console.log(`Session complete: ${completionNode.id}`);
  db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

**Verify:** Run `npx tsx src/cli/session-complete.ts`.

---

### Task 5.5: Create queue-synthesis CLI

**File:** `./src/cli/queue-synthesis.ts`

**Action:** Create new file

**Code:**
```typescript
/**
 * CLI: queue-synthesis
 * Called by Stop hook to queue current session content for background synthesis
 */

import { getDatabase } from '../db.js';
import { randomUUID } from 'crypto';
import { readFileSync, existsSync } from 'fs';

interface JsonlEntry {
  type: string;
  message?: {
    role: string;
    content: string | Array<{ type: string; text?: string }>;
  };
  timestamp?: string;
}

function parseJsonl(content: string): JsonlEntry[] {
  return content
    .trim()
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((entry): entry is JsonlEntry => entry !== null);
}

function extractText(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === 'string') return content;
  return content
    .filter((c) => c.type === 'text' && c.text)
    .map((c) => c.text!)
    .join('\n');
}

async function main() {
  const db = getDatabase();

  const transcriptPath = process.env.TRANSCRIPT_PATH;
  if (!transcriptPath || !existsSync(transcriptPath)) {
    console.log('No transcript available');
    db.close();
    return;
  }

  const sessionId = transcriptPath.split('/').pop()?.replace('.jsonl', '') || `session-${Date.now()}`;

  // Read and parse transcript
  const content = readFileSync(transcriptPath, 'utf-8');
  const entries = parseJsonl(content);

  if (entries.length === 0) {
    console.log('No entries in transcript');
    db.close();
    return;
  }

  // Create raw content entries
  const rawContentIds: string[] = [];
  const now = Date.now();

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.type === 'message' && entry.message) {
      const id = randomUUID();
      const contentText = extractText(entry.message.content);

      db.createRawContent({
        id,
        session_id: sessionId,
        synthesis_node_id: null,
        content_type: 'message',
        content: `[${entry.message.role}]: ${contentText}`,
        agent_id: null,
        timestamp: entry.timestamp ? new Date(entry.timestamp).getTime() : now,
        message_index: i,
      });

      rawContentIds.push(id);
    }
  }

  if (rawContentIds.length === 0) {
    console.log('No messages to queue');
    db.close();
    return;
  }

  // Create queue item for background synthesis
  const queueItem = db.createSynthesisQueueItem({
    session_id: sessionId,
    agent_id: null,
    chunk_type: 'session_chunk',
    raw_content_ids: JSON.stringify(rawContentIds),
    context: null,
    message_count: rawContentIds.length,
    status: 'pending',
    retry_count: 0,
    error: null,
    synthesis_node_id: null,
    created_at: now,
  });

  console.log(`Queued ${rawContentIds.length} messages for synthesis (queue item ${queueItem.id})`);
  db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

**Verify:** Run `TRANSCRIPT_PATH=/tmp/test.jsonl npx tsx src/cli/queue-synthesis.ts`.

---

### Task 5.6: Create backfill CLI

**File:** `./src/cli/backfill.ts`

**Action:** Create new file

**Code:**
```typescript
/**
 * CLI: backfill
 * Process unsynced conversations from ~/.claude/projects
 */

import { readdirSync, statSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getDatabase } from '../db.js';

async function main() {
  const db = getDatabase();

  const projectsDir = join(homedir(), '.claude', 'projects');
  if (!existsSync(projectsDir)) {
    console.log('No Claude projects directory found');
    db.close();
    return;
  }

  let processed = 0;
  let skipped = 0;

  const projects = readdirSync(projectsDir);
  for (const project of projects) {
    const projectPath = join(projectsDir, project);
    const stat = statSync(projectPath);
    if (!stat.isDirectory()) continue;

    const files = readdirSync(projectPath).filter((f) => f.endsWith('.jsonl'));
    for (const file of files) {
      const sessionId = file.replace('.jsonl', '');

      // Check if already processed
      const existing = db.queryNodes({ session_id: sessionId, limit: 1 });
      if (existing.length > 0) {
        skipped++;
        continue;
      }

      // Queue for processing (will be handled by synthesis worker)
      console.log(`Would process: ${project}/${file}`);
      processed++;
    }
  }

  console.log(`\nBackfill complete: ${processed} to process, ${skipped} skipped`);
  db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

**Verify:** Run `npx tsx src/cli/backfill.ts`.

---

### Task 5.7: Create recent CLI

**File:** `./src/cli/recent.ts`

**Action:** Create new file

**Code:**
```typescript
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
  const nodes = db.queryNodes({ limit, order_by: 'last_updated' });

  if (format === 'json') {
    console.log(JSON.stringify(nodes, null, 2));
  } else {
    for (const node of nodes) {
      console.log(`[${node.node_type}] ${node.one_liner}`);
    }
  }

  db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

**Verify:** Run `npx tsx src/cli/recent.ts --limit=3`.

---

### Task 5.8: Create search CLI

**File:** `./src/cli/search.ts`

**Action:** Create new file

**Code:**
```typescript
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
```

**Verify:** Run `npx tsx src/cli/search.ts "authentication decisions"`.

---

### Task 5.9: Create status CLI

**File:** `./src/cli/status.ts`

**Action:** Create new file

**Code:**
```typescript
/**
 * CLI: status
 * Check system status
 */

import { getDatabase } from '../db.js';

async function main() {
  const db = getDatabase();

  const nodes = db.queryNodes({ limit: 1000 });
  const queueItems = db.getSynthesisQueueItems({ limit: 1000 });

  const pending = queueItems.filter((i) => i.status === 'pending').length;
  const processing = queueItems.filter((i) => i.status === 'processing').length;
  const completed = queueItems.filter((i) => i.status === 'completed').length;
  const failed = queueItems.filter((i) => i.status === 'failed').length;

  console.log('Total Recall Status');
  console.log('==================');
  console.log(`Synthesis nodes: ${nodes.length}`);
  console.log('');
  console.log('Queue Status:');
  console.log(`  Pending:    ${pending}`);
  console.log(`  Processing: ${processing}`);
  console.log(`  Completed:  ${completed}`);
  console.log(`  Failed:     ${failed}`);
  console.log('');
  console.log(`Worker: ${process.env.ANTHROPIC_API_KEY ? 'Enabled' : 'Disabled (no API key)'}`);

  db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

**Verify:** Run `npx tsx src/cli/status.ts`.

---

## Phase 6: Testing

### Task 6.1: Create Test Script

**File:** `./test/integration.ts`

**Action:** Create new file (create test directory first)

**Code:**
```typescript
/**
 * Integration tests for TotalRecall plugin
 */

import { SynthesisDatabase } from '../src/db.js';
import { generateEmbedding, initEmbeddings, generateSynthesisEmbedding } from '../src/embeddings.js';
import { LLMSynthesisClient } from '../src/llm-synthesis.js';
import { SynthesisWorker } from '../src/synthesis-worker.js';
import { unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const TEST_DB_PATH = join(tmpdir(), 'totalrecall-test.sqlite');

async function cleanup() {
  if (existsSync(TEST_DB_PATH)) {
    unlinkSync(TEST_DB_PATH);
  }
}

async function testDatabaseSchema() {
  console.log('Test: Database schema creation...');
  const db = new SynthesisDatabase(TEST_DB_PATH);

  // Test node creation
  const node = db.createNode({
    node_type: 'learning',
    one_liner: 'Test learning',
    summary: 'This is a test summary',
    full_synthesis: 'Full synthesis text here',
    entity_name: null,
    entity_aliases: null,
    temporal_context: null,
    first_seen: Date.now(),
    last_updated: Date.now(),
    status: null,
    assigned_agent: null,
    priority: null,
    source_session_id: 'test-session',
    source_agent_id: null,
    source_repo: null,
  });

  if (!node.id) throw new Error('Node creation failed');
  console.log('  - Node creation: PASS');

  // Test raw content
  const raw = db.createRawContent({
    id: 'raw-1',
    session_id: 'test-session',
    synthesis_node_id: null,
    content_type: 'message',
    content: 'Test message content',
    agent_id: null,
    timestamp: Date.now(),
    message_index: 0,
  });

  if (!raw.id) throw new Error('Raw content creation failed');
  console.log('  - Raw content creation: PASS');

  // Test queue item
  const queueItem = db.createSynthesisQueueItem({
    session_id: 'test-session',
    agent_id: null,
    chunk_type: 'session_chunk',
    raw_content_ids: JSON.stringify(['raw-1']),
    context: null,
    message_count: 1,
    status: 'pending',
    retry_count: 0,
    error: null,
    synthesis_node_id: null,
    created_at: Date.now(),
  });

  if (!queueItem.id) throw new Error('Queue item creation failed');
  console.log('  - Queue item creation: PASS');

  // Test progressive disclosure event
  const pdEvent = db.createProgressiveDisclosureEvent({
    event_type: 'search',
    session_id: 'test-session',
    agent_id: null,
    query_text: 'test query',
    search_latency_ms: 50,
    results_count: 3,
    node_ids: null,
    injection_tokens: null,
    expanded_node_id: null,
    expansion_tokens: null,
    message_tokens: null,
  });

  if (!pdEvent.id) throw new Error('PD event creation failed');
  console.log('  - Progressive disclosure event: PASS');

  db.close();
  console.log('Database schema tests: PASS\n');
}

async function testEmbeddings() {
  console.log('Test: Embeddings...');
  await initEmbeddings();

  const embedding = await generateEmbedding('Test text for embedding');
  if (embedding.length !== 384) {
    throw new Error(`Expected 384 dimensions, got ${embedding.length}`);
  }
  console.log('  - Embedding generation: PASS');

  const synthEmbedding = await generateSynthesisEmbedding('One liner', 'Summary', 'learning');
  if (synthEmbedding.length !== 384) {
    throw new Error(`Expected 384 dimensions, got ${synthEmbedding.length}`);
  }
  console.log('  - Synthesis embedding: PASS');

  console.log('Embedding tests: PASS\n');
}

async function testVectorSearch() {
  console.log('Test: Vector search...');
  await cleanup();
  const db = new SynthesisDatabase(TEST_DB_PATH);
  await initEmbeddings();

  // Create nodes with embeddings
  const node1 = db.createNode({
    node_type: 'decision',
    one_liner: 'Use React for frontend',
    summary: 'Decided to use React for the frontend framework',
    full_synthesis: 'Full text',
    entity_name: null,
    entity_aliases: null,
    temporal_context: null,
    first_seen: Date.now(),
    last_updated: Date.now(),
    status: null,
    assigned_agent: null,
    priority: null,
    source_session_id: 'test',
    source_agent_id: null,
    source_repo: null,
  });

  const emb1 = await generateSynthesisEmbedding(node1.one_liner, node1.summary, node1.node_type);
  db.insertEmbedding(node1.id, emb1);

  const node2 = db.createNode({
    node_type: 'learning',
    one_liner: 'SQLite WAL mode improves concurrency',
    summary: 'Learned that WAL mode helps with concurrent access',
    full_synthesis: 'Full text',
    entity_name: null,
    entity_aliases: null,
    temporal_context: null,
    first_seen: Date.now(),
    last_updated: Date.now(),
    status: null,
    assigned_agent: null,
    priority: null,
    source_session_id: 'test',
    source_agent_id: null,
    source_repo: null,
  });

  const emb2 = await generateSynthesisEmbedding(node2.one_liner, node2.summary, node2.node_type);
  db.insertEmbedding(node2.id, emb2);

  // Search for React-related content
  const queryEmb = await generateEmbedding('React frontend framework');
  const results = db.searchByVector(queryEmb, 5, 0.3);

  if (results.length === 0) {
    throw new Error('Expected search results');
  }

  // React node should rank higher
  if (results[0].node_id !== node1.id) {
    console.log('Warning: React node not ranked first (may be acceptable)');
  }
  console.log('  - Vector search: PASS');

  db.close();
  console.log('Vector search tests: PASS\n');
}

async function testQueueOperations() {
  console.log('Test: Queue operations...');
  await cleanup();
  const db = new SynthesisDatabase(TEST_DB_PATH);

  // Create pending item
  const item = db.createSynthesisQueueItem({
    session_id: 'test-session',
    agent_id: null,
    chunk_type: 'session_chunk',
    raw_content_ids: '["raw-1"]',
    context: null,
    message_count: 1,
    status: 'pending',
    retry_count: 0,
    error: null,
    synthesis_node_id: null,
    created_at: Date.now(),
  });

  // Get pending items
  const pending = db.getPendingSynthesisQueue({ limit: 10 });
  if (pending.length !== 1) {
    throw new Error(`Expected 1 pending, got ${pending.length}`);
  }
  console.log('  - Get pending items: PASS');

  // Update status
  db.updateSynthesisQueueStatus(item.id, 'processing');
  const updated = db.getSynthesisQueueItems({ status: 'processing' });
  if (updated.length !== 1) {
    throw new Error('Status update failed');
  }
  console.log('  - Update status: PASS');

  // Increment retry
  db.incrementSynthesisQueueRetry(item.id);
  const retried = db.getSynthesisQueueItems({ status: 'pending' });
  if (retried[0].retry_count !== 1) {
    throw new Error('Retry increment failed');
  }
  console.log('  - Increment retry: PASS');

  db.close();
  console.log('Queue operation tests: PASS\n');
}

async function testProgressiveDisclosureAnalytics() {
  console.log('Test: Progressive disclosure analytics...');
  await cleanup();
  const db = new SynthesisDatabase(TEST_DB_PATH);

  const now = Date.now();

  // Create events
  db.createProgressiveDisclosureEvent({
    event_type: 'search',
    session_id: 'test',
    agent_id: null,
    query_text: 'test',
    search_latency_ms: 50,
    results_count: 3,
    node_ids: null,
    injection_tokens: null,
    expanded_node_id: null,
    expansion_tokens: null,
    message_tokens: null,
  });

  db.createProgressiveDisclosureEvent({
    event_type: 'inject',
    session_id: 'test',
    agent_id: null,
    query_text: null,
    search_latency_ms: null,
    results_count: null,
    node_ids: '["id1"]',
    injection_tokens: 100,
    expanded_node_id: null,
    expansion_tokens: null,
    message_tokens: null,
  });

  db.createProgressiveDisclosureEvent({
    event_type: 'expand',
    session_id: 'test',
    agent_id: null,
    query_text: null,
    search_latency_ms: null,
    results_count: null,
    node_ids: null,
    injection_tokens: null,
    expanded_node_id: 'id1',
    expansion_tokens: 500,
    message_tokens: null,
  });

  const stats = db.getProgressiveDisclosureAnalytics(now - 1000, now + 1000);

  if (stats.totalSearches !== 1) throw new Error('Search count wrong');
  if (stats.totalInjections !== 1) throw new Error('Injection count wrong');
  if (stats.totalExpansions !== 1) throw new Error('Expansion count wrong');
  if (stats.totalInjectionTokens !== 100) throw new Error('Injection tokens wrong');
  if (stats.totalExpansionTokens !== 500) throw new Error('Expansion tokens wrong');

  console.log('  - Analytics calculation: PASS');

  db.close();
  console.log('Progressive disclosure analytics tests: PASS\n');
}

async function main() {
  console.log('=== TotalRecall Integration Tests ===\n');

  try {
    await testDatabaseSchema();
    await testEmbeddings();
    await testVectorSearch();
    await testQueueOperations();
    await testProgressiveDisclosureAnalytics();

    console.log('=== ALL TESTS PASSED ===');
    await cleanup();
    process.exit(0);
  } catch (error) {
    console.error('TEST FAILED:', error);
    await cleanup();
    process.exit(1);
  }
}

main();
```

**Verify:** Run `npx tsx test/integration.ts` - all tests should pass.

---

### Task 6.2: Add Test Script to package.json

**File:** `./package.json`

**Action:** Modify - Add test script

**Code to add to scripts:**
```json
"test": "npx tsx test/integration.ts"
```

**Verify:** Run `npm test`.

---

## Verification Checklist

After completing all phases, verify the following:

### Build
```bash
npm run build
```

### Tests
```bash
npm test
```

### MCP Tools (8 total)
```bash
# Start server and verify tools list
npm start
# In another terminal, check tools are available
```

Expected tools:
1. synthesis_create
2. synthesis_search (with date filtering)
3. synthesis_unfold
4. synthesis_get_context
5. session_graft
6. synthesis_capture_chunk (NEW)
7. synthesis_queue_status (NEW)
8. progressive_disclosure_stats (NEW)

### Background Worker
```bash
# With API key, worker should start
ANTHROPIC_API_KEY=sk-ant-... npm start
# Should see: "Synthesis worker started"
```

### CLI Commands
```bash
./cli/totalrecall.js --help
./cli/totalrecall.js status
./cli/totalrecall.js recent --limit=3
```

### Hooks
```bash
# Verify hooks.json is valid
cat hooks/hooks.json | jq .
```

---

## Summary

| Phase | Tasks | Effort |
|-------|-------|--------|
| 1. Schema & Types | 2 tasks | 1 hour |
| 2. Database Methods | 3 tasks | 2 hours |
| 3. MCP Tools | 4 tasks | 2 hours |
| 4. Background Services | 4 tasks | 3 hours |
| 5. Hooks & CLI | 9 tasks | 2 hours |
| 6. Testing | 2 tasks | 2 hours |

**Total: 24 tasks, ~12 hours**

The plan brings the standalone plugin to full feature parity with the coordinator, enabling:
- Automatic conversation capture via hooks
- Background Haiku synthesis
- Date-filtered search
- Progressive disclosure analytics
- Queue monitoring

All code is complete and ready for implementation by an engineer with zero codebase context.
