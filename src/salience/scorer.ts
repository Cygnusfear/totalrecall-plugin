/**
 * Salience Scorer - Calculates importance scores for synthesis nodes
 */

import type { SalienceConfig, SalienceComponents } from './types.js';

const EMOTIONAL_MARKERS = [
  'excited', 'breakthrough', 'finally', 'amazing', 'incredible', 'perfect',
  'thrilled', 'delighted', 'grateful', 'proud', 'relieved', 'satisfied',
  'frustrated', 'disappointed', 'confused', 'worried', 'concerned', 'blocked',
  'stuck', 'struggling', 'failed', 'broken', 'critical', 'urgent',
  'important', 'crucial', 'essential', 'key', 'significant', 'major',
  'remember', 'never forget', 'always', 'must',
  'completed', 'finished', 'solved', 'fixed', 'resolved', 'achieved',
  'discovered', 'learned', 'realized', 'understood',
  'first time', 'never before', 'brand new', 'initial',
  'decided', 'chose', 'committed', 'pivoted', 'changed direction'
];

const NODE_TYPE_WEIGHTS: Record<string, number> = {
  'decision': 1.3,
  'learning': 1.2,
  'entity': 1.0,
  'event': 0.9,
  'task': 0.8,
  'summary': 1.1,
};

export const DEFAULT_SALIENCE_CONFIG: SalienceConfig = {
  weights: {
    inverseFrequency: 0.25,
    emotional: 0.20,
    novelty: 0.15,
    consequence: 0.15,
    recency: 0.10,
    userMarked: 0.10,
    nodeType: 0.05,
  },
  similarityThreshold: 0.7,
  routineThreshold: 5,
  recencyHalfLifeDays: 30,
};

export class SalienceScorer {
  private config: SalienceConfig;

  constructor(config: Partial<SalienceConfig> = {}) {
    this.config = {
      ...DEFAULT_SALIENCE_CONFIG,
      ...config,
      weights: { ...DEFAULT_SALIENCE_CONFIG.weights, ...config.weights }
    };
  }

  detectEmotionalMarkers(text: string): { isEmotional: boolean; score: number; markers: string[] } {
    const lowerText = text.toLowerCase();
    const foundMarkers: string[] = [];

    for (const marker of EMOTIONAL_MARKERS) {
      if (lowerText.includes(marker)) {
        foundMarkers.push(marker);
      }
    }

    const score = Math.min(foundMarkers.length / 3, 1.0);
    return { isEmotional: foundMarkers.length > 0, score, markers: foundMarkers };
  }

  calculateInverseFrequency(similarCount: number): number {
    if (similarCount <= 0) return 1.0;
    return 1 / (1 + Math.log(1 + similarCount));
  }

  calculateRecencyScore(timestamp: number): number {
    const now = Date.now();
    const ageMs = now - timestamp;
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    const halfLife = this.config.recencyHalfLifeDays;
    return Math.pow(0.5, ageDays / halfLife);
  }

  calculateConnectionWeight(edgeCount: number): number {
    if (edgeCount <= 0) return 0.5;
    if (edgeCount >= 10) return 1.0;
    return 0.5 + (edgeCount / 20);
  }

  calculateSalienceScore(nodeData: {
    one_liner: string;
    summary: string;
    full_synthesis: string;
    node_type: string;
    last_updated: number;
    similar_count: number;
    is_novel: boolean;
    is_emotional: boolean;
    is_consequential: boolean;
    is_user_marked: boolean;
  }, edgeCount: number): { salience: number; components: SalienceComponents } {
    const weights = this.config.weights;

    const inverseFrequency = this.calculateInverseFrequency(nodeData.similar_count);
    const combinedText = `${nodeData.one_liner} ${nodeData.summary} ${nodeData.full_synthesis}`;
    const emotionalResult = this.detectEmotionalMarkers(combinedText);
    const emotionalWeight = nodeData.is_emotional ? 1.0 : emotionalResult.score;
    const novelty = nodeData.is_novel ? 1.5 : 1.0;
    const consequence = nodeData.is_consequential ? 1.5 : 1.0;
    const recency = this.calculateRecencyScore(nodeData.last_updated);
    const userMarked = nodeData.is_user_marked ? 2.0 : 1.0;
    const nodeTypeWeight = NODE_TYPE_WEIGHTS[nodeData.node_type] || 1.0;
    const connectionWeight = this.calculateConnectionWeight(edgeCount);

    const components: SalienceComponents = {
      inverse_frequency: inverseFrequency,
      emotional_weight: emotionalWeight,
      novelty,
      consequence,
      recency,
      user_marked: userMarked,
      node_type_weight: nodeTypeWeight,
      connection_weight: connectionWeight,
    };

    const rawScore =
      (inverseFrequency * weights.inverseFrequency) +
      (emotionalWeight * weights.emotional) +
      (novelty * weights.novelty) +
      (consequence * weights.consequence) +
      (recency * weights.recency) +
      (userMarked * weights.userMarked) +
      (nodeTypeWeight * weights.nodeType);

    const adjustedScore = rawScore * connectionWeight;
    const salience = Math.max(0.1, Math.min(2.0, adjustedScore * 2));

    return { salience, components };
  }

  isRoutineNode(salience: number): boolean {
    return salience < 0.5;
  }

  isImportantNode(salience: number): boolean {
    return salience >= 1.0;
  }

  applyRoutineDecay(currentSalience: number, isRoutine: boolean, decayFactor: number = 0.9): number {
    if (!isRoutine) return currentSalience;
    return Math.max(0.1, currentSalience * decayFactor);
  }

  boostOnAccess(currentSalience: number, accessCount: number, boostFactor: number = 0.02): number {
    const boost = boostFactor * Math.log(1 + accessCount);
    return Math.min(2.0, currentSalience + boost);
  }

  getConfig(): SalienceConfig {
    return this.config;
  }
}
