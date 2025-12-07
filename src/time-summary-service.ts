/**
 * Time Summary Service - Generates hourly and daily roll-up summaries
 *
 * This service automatically generates time-based summaries of synthesis nodes,
 * creating "What happened this hour/today" roll-up nodes with edges to source nodes.
 */

import type { SynthesisDatabase } from './db.js';
import type { LLMSynthesisClient } from './llm-synthesis.js';
import { generateSynthesisEmbedding } from './embeddings.js';
import type { TimeSummaryConfig, TimeSummaryPeriod, SynthesisNode } from './schema.js';

export interface TimeSummaryServiceConfig extends Partial<TimeSummaryConfig> {
  // All config options are optional with defaults
}

const DEFAULT_CONFIG: TimeSummaryConfig = {
  enableHourly: true,
  enableDaily: true,
  hourlyDelay: 5, // 5 minutes after hour ends
  dailyHour: 2, // 2 AM
  minNodesForSummary: 3,
};

export class TimeSummaryService {
  private config: TimeSummaryConfig;

  constructor(
    private db: SynthesisDatabase,
    private llmClient: LLMSynthesisClient,
    config: TimeSummaryServiceConfig = {}
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Check if any time summaries need to be generated and create them
   * Called from the SynthesisWorker poll loop
   */
  async checkAndGenerateSummaries(): Promise<void> {
    const now = Date.now();

    if (this.config.enableHourly) {
      await this.checkHourlySummary(now);
    }

    if (this.config.enableDaily) {
      await this.checkDailySummary(now);
    }

    // Process any pending summaries
    await this.processPendingSummaries();
  }

  /**
   * Check if we should generate an hourly summary
   */
  private async checkHourlySummary(now: number): Promise<void> {
    const currentDate = new Date(now);
    const currentMinute = currentDate.getMinutes();

    // Only check after the delay period following hour change
    if (currentMinute < this.config.hourlyDelay) {
      return;
    }

    // Calculate the previous hour's time range
    const hourStart = new Date(currentDate);
    hourStart.setHours(currentDate.getHours() - 1, 0, 0, 0);
    const hourEnd = new Date(hourStart);
    hourEnd.setHours(hourStart.getHours() + 1);

    await this.maybeCreateSummary('hourly', hourStart.getTime(), hourEnd.getTime());
  }

  /**
   * Check if we should generate a daily summary
   */
  private async checkDailySummary(now: number): Promise<void> {
    const currentDate = new Date(now);
    const currentHour = currentDate.getHours();
    const currentMinute = currentDate.getMinutes();

    // Only check at the configured hour (after the delay)
    if (currentHour !== this.config.dailyHour || currentMinute < this.config.hourlyDelay) {
      return;
    }

    // Calculate yesterday's time range
    const dayStart = new Date(currentDate);
    dayStart.setDate(dayStart.getDate() - 1);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart);
    dayEnd.setDate(dayStart.getDate() + 1);

    await this.maybeCreateSummary('daily', dayStart.getTime(), dayEnd.getTime());
  }

  /**
   * Create a summary if one doesn't exist for the period and there are enough nodes
   */
  private async maybeCreateSummary(
    periodType: TimeSummaryPeriod,
    periodStart: number,
    periodEnd: number
  ): Promise<void> {
    // Check if summary already exists
    if (this.db.timeSummaryExists(periodType, periodStart)) {
      return;
    }

    // Get nodes in this time range
    const nodes = this.db.getNodesInTimeRange(periodStart, periodEnd);

    // Check minimum node threshold
    if (nodes.length < this.config.minNodesForSummary) {
      console.log(
        `[TimeSummary] Skipping ${periodType} summary: only ${nodes.length} nodes (min: ${this.config.minNodesForSummary})`
      );
      return;
    }

    // Create pending summary record
    this.db.createTimeSummary({
      period_type: periodType,
      period_start: periodStart,
      period_end: periodEnd,
      synthesis_node_id: null,
      source_node_ids: JSON.stringify(nodes.map(n => n.id)),
      source_node_count: nodes.length,
      status: 'pending',
      error: null,
      created_at: Date.now(),
    });

    console.log(
      `[TimeSummary] Created pending ${periodType} summary for ${new Date(periodStart).toISOString()} (${nodes.length} nodes)`
    );
  }

  /**
   * Process pending time summaries
   */
  private async processPendingSummaries(): Promise<void> {
    const pending = this.db.getPendingTimeSummaries(5);

    for (const summary of pending) {
      try {
        await this.processSummary(summary.id);
      } catch (error) {
        console.error(`[TimeSummary] Failed to process summary ${summary.id}:`, error);
      }
    }
  }

  /**
   * Process a single time summary
   */
  private async processSummary(summaryId: number): Promise<void> {
    const summary = this.db.getTimeSummary(summaryId);
    if (!summary || summary.status !== 'pending') {
      return;
    }

    console.log(`[TimeSummary] Processing ${summary.period_type} summary ${summaryId}`);
    this.db.updateTimeSummaryStatus(summaryId, 'processing');

    try {
      const sourceNodeIds: string[] = JSON.parse(summary.source_node_ids);
      const sourceNodes: SynthesisNode[] = sourceNodeIds
        .map(id => this.db.getNode(id))
        .filter((n): n is SynthesisNode => n !== undefined);

      if (sourceNodes.length === 0) {
        throw new Error('No source nodes found for summary');
      }

      // Build synthesis prompt from source nodes
      const synthesisNode = await this.synthesizeTimeSummary(
        summary.period_type,
        summary.period_start,
        summary.period_end,
        sourceNodes
      );

      // Create edges from summary node to source nodes
      for (const sourceNode of sourceNodes) {
        this.db.createEdge({
          from_node_id: synthesisNode.id,
          to_node_id: sourceNode.id,
          edge_type: 'contains',
          weight: 1.0,
          context: `${summary.period_type} summary`,
        });
      }

      // Update summary as completed
      this.db.updateTimeSummaryStatus(summaryId, 'completed', synthesisNode.id);

      console.log(
        `[TimeSummary] Completed ${summary.period_type} summary ${summaryId} -> node ${synthesisNode.id}`
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[TimeSummary] Failed summary ${summaryId}:`, errorMessage);
      this.db.updateTimeSummaryStatus(summaryId, 'failed', null, errorMessage);
    }
  }

  /**
   * Synthesize a time summary from source nodes
   */
  private async synthesizeTimeSummary(
    periodType: TimeSummaryPeriod,
    periodStart: number,
    periodEnd: number,
    sourceNodes: SynthesisNode[]
  ): Promise<SynthesisNode> {
    const startDate = new Date(periodStart);
    const endDate = new Date(periodEnd);

    // Format time range for display
    const timeRange = periodType === 'hourly'
      ? `${startDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })} - ${endDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`
      : startDate.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

    // Build content for synthesis
    const nodesSummary = sourceNodes
      .map((n, i) => `[${i + 1}] (${n.node_type}) ${n.one_liner}\n${n.summary}`)
      .join('\n\n---\n\n');

    const prompt = this.buildSynthesisPrompt(periodType, timeRange, nodesSummary, sourceNodes.length);

    // Call LLM for synthesis
    const chunks = [{
      id: `time-summary-${periodType}-${periodStart}`,
      content: prompt,
      timestamp: Date.now(),
      agent_id: null,
    }];

    const synthesis = await this.llmClient.synthesize(chunks, {
      task_context: `${periodType} time summary for ${timeRange}`,
    });

    // Create the summary node
    const node = this.db.createNode({
      node_type: 'summary',
      one_liner: synthesis.one_liner,
      summary: synthesis.summary,
      full_synthesis: synthesis.full_synthesis,
      entity_name: null,
      entity_aliases: null,
      temporal_context: `${periodType} summary: ${timeRange}`,
      first_seen: periodStart,
      last_updated: periodEnd,
      status: null,
      assigned_agent: null,
      priority: null,
      source_session_id: `time-summary-${periodType}`,
      source_agent_id: null,
      source_repo: null,
    });

    // Generate embedding
    try {
      const embedding = await generateSynthesisEmbedding(
        node.one_liner,
        node.summary,
        'summary'
      );
      this.db.insertEmbedding(node.id, embedding);
    } catch (e) {
      console.error('[TimeSummary] Failed to generate embedding:', e);
    }

    return node;
  }

  /**
   * Build the synthesis prompt for time summary
   */
  private buildSynthesisPrompt(
    periodType: TimeSummaryPeriod,
    timeRange: string,
    nodesSummary: string,
    nodeCount: number
  ): string {
    return `You are creating a ${periodType} summary of work and insights from ${timeRange}.

This summary consolidates ${nodeCount} synthesis nodes from this time period into a cohesive overview.

SOURCE NODES:
${nodesSummary}

---

TASK: Create a ${periodType} roll-up summary that:
1. Highlights the main themes and activities from this period
2. Notes any key decisions, learnings, or milestones
3. Provides a "what happened" overview suitable for timeline scrubbing
4. Captures the essence without losing important details

The summary should be:
- Scannable and concise for the one_liner
- Comprehensive in the summary field
- Detailed with cross-references in full_synthesis

Return ONLY valid JSON with this exact structure:
{
  "node_type": "summary",
  "one_liner": "Brief ${periodType} summary (~50 tokens)",
  "summary": "Key activities and insights from ${timeRange} (~200 tokens)",
  "full_synthesis": "Complete overview with themes, decisions, and learnings (300-500 tokens)",
  "temporal_context": "${timeRange}",
  "entity_name": null
}`;
  }

  /**
   * Manually trigger summary generation for a specific period
   * Useful for backfilling or on-demand generation
   */
  async manuallyGenerateSummary(
    periodType: TimeSummaryPeriod,
    periodStart: number,
    periodEnd: number
  ): Promise<{ success: boolean; summaryId?: number; nodeId?: string; error?: string }> {
    try {
      // Check if already exists
      if (this.db.timeSummaryExists(periodType, periodStart)) {
        return { success: false, error: 'Summary already exists for this period' };
      }

      // Get nodes
      const nodes = this.db.getNodesInTimeRange(periodStart, periodEnd);
      if (nodes.length === 0) {
        return { success: false, error: 'No nodes found in this time range' };
      }

      // Create and immediately process
      const summary = this.db.createTimeSummary({
        period_type: periodType,
        period_start: periodStart,
        period_end: periodEnd,
        synthesis_node_id: null,
        source_node_ids: JSON.stringify(nodes.map(n => n.id)),
        source_node_count: nodes.length,
        status: 'pending',
        error: null,
        created_at: Date.now(),
      });

      await this.processSummary(summary.id);

      // Get updated summary
      const updated = this.db.getTimeSummary(summary.id);
      if (updated?.status === 'completed') {
        return { success: true, summaryId: summary.id, nodeId: updated.synthesis_node_id ?? undefined };
      } else {
        return { success: false, summaryId: summary.id, error: updated?.error ?? 'Unknown error' };
      }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Get summary statistics
   */
  getStats(): {
    hourlyCompleted: number;
    hourlyPending: number;
    dailyCompleted: number;
    dailyPending: number;
    lastHourlySummary: Date | null;
    lastDailySummary: Date | null;
  } {
    const hourlyCompleted = this.db.getTimeSummaries({ periodType: 'hourly', status: 'completed', limit: 1000 });
    const hourlyPending = this.db.getTimeSummaries({ periodType: 'hourly', status: 'pending' });
    const dailyCompleted = this.db.getTimeSummaries({ periodType: 'daily', status: 'completed', limit: 1000 });
    const dailyPending = this.db.getTimeSummaries({ periodType: 'daily', status: 'pending' });

    const lastHourly = this.db.getLastCompletedSummary('hourly');
    const lastDaily = this.db.getLastCompletedSummary('daily');

    return {
      hourlyCompleted: hourlyCompleted.length,
      hourlyPending: hourlyPending.length,
      dailyCompleted: dailyCompleted.length,
      dailyPending: dailyPending.length,
      lastHourlySummary: lastHourly ? new Date(lastHourly.period_start) : null,
      lastDailySummary: lastDaily ? new Date(lastDaily.period_start) : null,
    };
  }
}
