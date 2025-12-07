/**
 * Salience Scoring Module
 *
 * Implements memory consolidation through salience scoring,
 * inspired by how the brain processes memories during sleep.
 */

export { SalienceScorer, DEFAULT_SALIENCE_CONFIG } from './scorer.js';
export { DreamingWorker } from './worker.js';
export * from './db-operations.js';
export type {
  SalienceComponents,
  SalienceConfig,
  DreamingPassType,
  DreamingPassStatus,
  DreamingPass,
  SalienceStats,
} from './types.js';
