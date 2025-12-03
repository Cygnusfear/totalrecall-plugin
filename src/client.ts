/**
 * Total Recall HTTP Client
 *
 * Thin client that proxies requests to the coordinator MCP server.
 * Used by both the MCP server wrapper and CLI tools.
 */

export interface SynthesisNode {
  node_id: string;
  node_type: 'decision' | 'learning' | 'entity' | 'event' | 'task' | 'summary';
  one_liner: string;
  summary?: string;
  full_synthesis?: string;
  entity_name?: string;
  temporal_context?: string;
  last_updated?: number;
}

export interface SearchResult {
  node_id: string;
  one_liner: string;
  relevance_score: number;
  node_type: string;
  created_at?: number;
}

export interface CreateParams {
  node_type: string;
  one_liner: string;
  summary: string;
  full_synthesis: string;
  session_id: string;
  entity_name?: string;
  temporal_context?: string;
  related_node_ids?: string[];
  edge_types?: string[];
}

export interface GraftParams {
  session_id: string;
  task_context?: string;
  source_repo?: string;
  agent_id?: string;
}

export interface SearchParams {
  query: string;
  max_results?: number;
  min_score?: number;
  node_types?: string[];
}

export interface ContextParams {
  session_id?: string;
  task_context?: string;
  max_nodes?: number;
  include_related?: boolean;
}

export interface UnfoldParams {
  node_id: string;
  depth?: 'summary' | 'full' | 'raw';
}

export class TotalRecallClient {
  constructor(private baseUrl: string = 'http://localhost:3847') {}

  private async request<T>(endpoint: string, method: string = 'GET', body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    const options: RequestInit = {
      method,
      headers: {
        'Content-Type': 'application/json',
      },
    };

    if (body) {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`HTTP ${response.status}: ${error}`);
    }

    return response.json() as Promise<T>;
  }

  async healthCheck(): Promise<{ ok: boolean; version?: string }> {
    try {
      return await this.request('/api/health');
    } catch {
      return { ok: false };
    }
  }

  async create(params: CreateParams): Promise<{ node_id: string; message: string }> {
    return this.request('/api/synthesis/create', 'POST', params);
  }

  async search(params: SearchParams): Promise<{ results: SearchResult[]; message: string }> {
    return this.request('/api/synthesis/search', 'POST', params);
  }

  async getContext(params: ContextParams): Promise<{
    active_synthesis: SynthesisNode[];
    unfoldable_refs: Array<{ node_id: string; one_liner: string }>;
    context_summary: { total_nodes: number; message: string };
  }> {
    return this.request('/api/synthesis/context', 'POST', params);
  }

  async unfold(params: UnfoldParams): Promise<SynthesisNode & { related_nodes?: unknown[] }> {
    return this.request('/api/synthesis/unfold', 'POST', params);
  }

  async sessionGraft(params: GraftParams): Promise<{
    session_node_id: string;
    grafted_context: {
      relevant_syntheses: SynthesisNode[];
      unfoldable_refs: Array<{ node_id: string; one_liner: string }>;
    };
    message: string;
  }> {
    return this.request('/api/synthesis/graft', 'POST', params);
  }

  async getRecent(limit: number = 5): Promise<SynthesisNode[]> {
    const result = await this.getContext({ max_nodes: limit });
    return result.active_synthesis;
  }
}

export default TotalRecallClient;
