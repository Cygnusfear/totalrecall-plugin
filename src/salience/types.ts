/**
 * Salience scoring type definitions
 */

export interface SalienceComponents {
  inverse_frequency: number;
  emotional_weight: number;
  novelty: number;
  consequence: number;
  recency: number;
  user_marked: number;
  node_type_weight: number;
  connection_weight: number;
}

export interface SalienceConfig {
  weights: {
    inverseFrequency: number;
    emotional: number;
    novelty: number;
    consequence: number;
    recency: number;
    userMarked: number;
    nodeType: number;
  };
  similarityThreshold: number;
  routineThreshold: number;
  recencyHalfLifeDays: number;
}

export type DreamingPassType = 'frequency_analysis' | 'novelty_detection' | 'emotional_detection' | 'decay' | 'full';
export type DreamingPassStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface DreamingPass {
  id: number;
  pass_type: DreamingPassType;
  started_at: number;
  completed_at: number | null;
  nodes_processed: number;
  nodes_updated: number;
  status: DreamingPassStatus;
  error: string | null;
}

export interface SalienceStats {
  total_nodes: number;
  avg_salience: number;
  high_salience_count: number;
  low_salience_count: number;
  routine_count: number;
  last_dreaming_pass: DreamingPass | null;
}
