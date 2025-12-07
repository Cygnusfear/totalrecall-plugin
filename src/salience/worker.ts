/**
 * Dreaming Worker - Background consolidation passes for salience scoring
 *
 * Inspired by how the brain consolidates memories during sleep,
 * this worker runs periodic passes to update salience scores.
 */

import type { DreamingPassType, DreamingPass } from './types.js';
import { SalienceScorer } from './scorer.js';

export interface DreamingWorkerConfig {
  quickPassIntervalMs: number;
  fullPassIntervalMs: number;
  decayPassIntervalMs: number;
  batchSize: number;
}

const DEFAULT_CONFIG: DreamingWorkerConfig = {
  quickPassIntervalMs: 60 * 60 * 1000,
  fullPassIntervalMs: 24 * 60 * 60 * 1000,
  decayPassIntervalMs: 7 * 24 * 60 * 60 * 1000,
  batchSize: 100,
};

interface NodeData {
  id: string;
  one_liner: string;
  summary: string;
  full_synthesis: string;
  node_type: string;
  last_updated: number;
  similar_count?: number;
  is_novel?: boolean;
  is_emotional?: boolean;
  is_consequential?: boolean;
  is_user_marked?: boolean;
  salience?: number;
}

export class DreamingWorker {
  private config: DreamingWorkerConfig;
  private scorer: SalienceScorer;
  private isRunning: boolean = false;
  private currentPass: DreamingPass | null = null;

  constructor(config: Partial<DreamingWorkerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.scorer = new SalienceScorer();
  }

  async runPass(
    passType: DreamingPassType,
    getNodes: () => Promise<NodeData[]>,
    getEdgeCount: (nodeId: string) => Promise<number>,
    getSimilarCount: (nodeId: string) => Promise<number>,
    updateNode: (nodeId: string, salience: number, components: any) => Promise<void>,
    logPass: (pass: Omit<DreamingPass, 'id'>) => Promise<number>
  ): Promise<DreamingPass> {
    if (this.isRunning) {
      throw new Error('A dreaming pass is already running');
    }

    this.isRunning = true;
    const startedAt = Date.now();
    let nodesProcessed = 0;
    let nodesUpdated = 0;
    let error: string | null = null;

    try {
      const nodes = await getNodes();

      for (const node of nodes) {
        nodesProcessed++;

        const edgeCount = await getEdgeCount(node.id);
        const similarCount = passType === 'frequency_analysis'
          ? await getSimilarCount(node.id)
          : node.similar_count || 0;

        const nodeData = {
          one_liner: node.one_liner,
          summary: node.summary,
          full_synthesis: node.full_synthesis,
          node_type: node.node_type,
          last_updated: node.last_updated,
          similar_count: similarCount,
          is_novel: node.is_novel || false,
          is_emotional: node.is_emotional || false,
          is_consequential: node.is_consequential || false,
          is_user_marked: node.is_user_marked || false,
        };

        const { salience, components } = this.scorer.calculateSalienceScore(nodeData, edgeCount);

        let finalSalience = salience;
        if (passType === 'decay') {
          const isRoutine = this.scorer.isRoutineNode(salience);
          finalSalience = this.scorer.applyRoutineDecay(salience, isRoutine);
        }

        const oldSalience = node.salience || 1.0;
        if (Math.abs(finalSalience - oldSalience) > 0.01) {
          await updateNode(node.id, finalSalience, components);
          nodesUpdated++;
        }
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      this.isRunning = false;
    }

    const pass: Omit<DreamingPass, 'id'> = {
      pass_type: passType,
      started_at: startedAt,
      completed_at: Date.now(),
      nodes_processed: nodesProcessed,
      nodes_updated: nodesUpdated,
      status: error ? 'failed' : 'completed',
      error,
    };

    const id = await logPass(pass);
    this.currentPass = { ...pass, id };

    return this.currentPass;
  }

  async recalculateNode(
    node: NodeData,
    edgeCount: number,
    similarCount: number
  ): Promise<{ salience: number; components: any }> {
    const nodeData = {
      one_liner: node.one_liner,
      summary: node.summary,
      full_synthesis: node.full_synthesis,
      node_type: node.node_type,
      last_updated: node.last_updated,
      similar_count: similarCount,
      is_novel: node.is_novel || false,
      is_emotional: node.is_emotional || false,
      is_consequential: node.is_consequential || false,
      is_user_marked: node.is_user_marked || false,
    };

    return this.scorer.calculateSalienceScore(nodeData, edgeCount);
  }

  boostOnAccess(currentSalience: number, accessCount: number): number {
    return this.scorer.boostOnAccess(currentSalience, accessCount);
  }

  getConfig(): DreamingWorkerConfig {
    return this.config;
  }

  isPassRunning(): boolean {
    return this.isRunning;
  }

  getCurrentPass(): DreamingPass | null {
    return this.currentPass;
  }
}
