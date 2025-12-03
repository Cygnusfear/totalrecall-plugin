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
