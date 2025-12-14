/**
 * Context Formatter
 *
 * Formats retrieved memories with source attribution tags for injection into
 * Claude's context. Part of the Active Retrieval pipeline (Epic 3).
 *
 * Transforms flat memory results into structured XML with:
 * - Source attribution (session, memory type)
 * - Confidence scores
 * - Age indicators
 * - Node IDs for unfold references
 */

import type { NodeType, CoreMemoryBlock } from '../schema.js';

export interface FormattedMemory {
  content: string;
  type: NodeType | 'persona' | 'human';
  source: string;
  confidence: number;
  ageMs: number;
  nodeId: string;
  oneLiner?: string;
}

/**
 * Core memory blocks for formatting - uses CoreMemoryBlock from schema
 */
export interface CoreMemoryBlocks {
  persona?: CoreMemoryBlock;
  human?: CoreMemoryBlock;
}

export interface FormatOptions {
  verbosity: 'minimal' | 'standard' | 'verbose';
  maxTokens?: number;
  includeCoreMemory?: boolean;
  includeNodeIds?: boolean;
  maxMemories?: number;
}

const DEFAULT_MAX_TOKENS = 4000;
const DEFAULT_MAX_MEMORIES = 10;
const CHARS_PER_TOKEN_ESTIMATE = 4;

export class ContextFormatter {
  /**
   * Format memories for injection into context
   */
  formatForInjection(
    memories: FormattedMemory[],
    coreMemory?: CoreMemoryBlocks,
    options: FormatOptions = { verbosity: 'standard' }
  ): string {
    const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    const maxMemories = options.maxMemories ?? DEFAULT_MAX_MEMORIES;
    const includeCoreMemory = options.includeCoreMemory ?? true;
    const includeNodeIds = options.includeNodeIds ?? true;

    const parts: string[] = [];

    // Core memory section (always first if present)
    if (includeCoreMemory && coreMemory) {
      const coreSection = this.formatCoreMemory(coreMemory, options.verbosity);
      if (coreSection) {
        parts.push(coreSection);
      }
    }

    // Retrieved memories section
    if (memories.length > 0) {
      const memoriesSection = this.formatRetrievedMemories(
        memories.slice(0, maxMemories),
        options.verbosity,
        includeNodeIds
      );

      if (memoriesSection) {
        parts.push(memoriesSection);
      }

      // Add overflow indicator
      if (memories.length > maxMemories) {
        parts.push(
          `<!-- ... and ${memories.length - maxMemories} more memories available via synthesis_search -->`
        );
      }
    }

    if (parts.length === 0) {
      return '';
    }

    let result = `<total_recall_context>\n${parts.join('\n\n')}\n</total_recall_context>`;

    // Truncate if exceeding token limit
    const estimatedTokens = this.estimateTokens(result);
    if (estimatedTokens > maxTokens) {
      result = this.truncateToTokenLimit(result, maxTokens);
    }

    return result;
  }

  /**
   * Format core memory blocks
   */
  private formatCoreMemory(
    coreMemory: CoreMemoryBlocks,
    verbosity: FormatOptions['verbosity']
  ): string | null {
    const parts: string[] = [];

    if (coreMemory.persona?.content) {
      const age = this.formatAge(Date.now() - coreMemory.persona.updated_at);
      if (verbosity === 'minimal') {
        parts.push(`<core_memory type="persona">\n${coreMemory.persona.content}\n</core_memory>`);
      } else {
        parts.push(
          `<core_memory type="persona" updated="${age}">\n${coreMemory.persona.content}\n</core_memory>`
        );
      }
    }

    if (coreMemory.human?.content) {
      const age = this.formatAge(Date.now() - coreMemory.human.updated_at);
      if (verbosity === 'minimal') {
        parts.push(`<core_memory type="human">\n${coreMemory.human.content}\n</core_memory>`);
      } else {
        parts.push(
          `<core_memory type="human" updated="${age}">\n${coreMemory.human.content}\n</core_memory>`
        );
      }
    }

    return parts.length > 0 ? parts.join('\n') : null;
  }

  /**
   * Format retrieved memories section
   */
  private formatRetrievedMemories(
    memories: FormattedMemory[],
    verbosity: FormatOptions['verbosity'],
    includeNodeIds: boolean
  ): string | null {
    if (memories.length === 0) {
      return null;
    }

    const formattedMemories = memories.map((m) =>
      this.formatSingleMemory(m, verbosity, includeNodeIds)
    );

    return `<retrieved_memories>\n${formattedMemories.join('\n')}\n</retrieved_memories>`;
  }

  /**
   * Format a single memory entry
   */
  private formatSingleMemory(
    memory: FormattedMemory,
    verbosity: FormatOptions['verbosity'],
    includeNodeIds: boolean
  ): string {
    const age = this.formatAge(memory.ageMs);
    const confidence = Math.round(memory.confidence * 100) / 100;
    const content = memory.oneLiner || memory.content;

    // Build attributes based on verbosity
    const attrs: string[] = [`type="${memory.type}"`];

    if (verbosity !== 'minimal') {
      attrs.push(`source="${memory.source}"`);
      attrs.push(`confidence="${confidence}"`);
      attrs.push(`age="${age}"`);
    }

    if (includeNodeIds) {
      attrs.push(`id="${memory.nodeId.slice(0, 8)}"`);
    }

    if (verbosity === 'verbose' && memory.oneLiner && memory.content !== memory.oneLiner) {
      // Verbose mode: include full content
      return `<memory ${attrs.join(' ')}>\n<title>${memory.oneLiner}</title>\n<details>${memory.content}</details>\n</memory>`;
    }

    return `<memory ${attrs.join(' ')}>\n${content}\n</memory>`;
  }

  /**
   * Format age in human-readable form
   */
  formatAge(ms: number): string {
    if (ms < 0) ms = 0;

    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    const weeks = Math.floor(days / 7);
    const months = Math.floor(days / 30);

    if (months > 0) {
      return `${months}mo`;
    }
    if (weeks > 0) {
      return `${weeks}w`;
    }
    if (days > 0) {
      return `${days}d`;
    }
    if (hours > 0) {
      return `${hours}h`;
    }
    if (minutes > 0) {
      return `${minutes}m`;
    }
    return 'now';
  }

  /**
   * Estimate token count from text
   */
  estimateTokens(text: string): number {
    // Rough estimate: ~4 characters per token for English
    return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
  }

  /**
   * Truncate content to fit within token limit
   */
  private truncateToTokenLimit(content: string, maxTokens: number): string {
    const targetChars = maxTokens * CHARS_PER_TOKEN_ESTIMATE;

    if (content.length <= targetChars) {
      return content;
    }

    // Find a good truncation point (after a complete memory tag)
    const truncateAt = content.lastIndexOf('</memory>', targetChars);

    if (truncateAt > 0) {
      const truncated = content.slice(0, truncateAt + '</memory>'.length);
      // Close the retrieved_memories tag if needed
      if (truncated.includes('<retrieved_memories>') && !truncated.includes('</retrieved_memories>')) {
        return truncated + '\n</retrieved_memories>\n<!-- truncated -->\n</total_recall_context>';
      }
      return truncated + '\n<!-- truncated -->\n</total_recall_context>';
    }

    // Fallback: hard truncate
    return content.slice(0, targetChars) + '\n<!-- truncated -->';
  }

  /**
   * Format a simple list for backward compatibility
   */
  formatSimpleList(
    memories: Array<{
      nodeType: string;
      oneLiner: string;
      nodeId: string;
      score: number;
    }>
  ): string {
    if (memories.length === 0) {
      return '';
    }

    const lines = memories.map((m) => {
      const pct = Math.round(m.score * 100);
      return `- [${m.nodeType}] ${m.oneLiner} (${m.nodeId.slice(0, 8)}) ${pct}%`;
    });

    return `<total_recall_relevant>
Relevant memories for your query:
${lines.join('\n')}

Use synthesis_unfold(node_id) for more detail.
</total_recall_relevant>`;
  }
}

/**
 * Create a ContextFormatter instance
 */
export function createContextFormatter(): ContextFormatter {
  return new ContextFormatter();
}
