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
  last_updated: number;
  edge_count: number;
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
