/**
 * Core Memory Service
 *
 * Manages persistent persona and human context blocks that are always-injected
 * into Claude's context. Part of Epic 4: Memory Types System.
 *
 * Core Memory differs from synthesis nodes:
 * - Always visible (injected at start of every context)
 * - Not retrieved by relevance/search
 * - Limited to 2 blocks: persona (agent behavior) and human (user facts)
 * - Token-limited to prevent context bloat
 */

import type { ISynthesisDatabase } from '../db/index.js';
import type { CoreMemoryBlock, CoreMemoryBlockType } from '../schema.js';

const DEFAULT_MAX_TOKENS_PER_BLOCK = 2000;
const CHARS_PER_TOKEN_ESTIMATE = 4;

export interface CoreMemoryBlocks {
  persona?: CoreMemoryBlock;
  human?: CoreMemoryBlock;
}

export interface SetBlockOptions {
  append?: boolean;
  maxTokens?: number;
}

export class CoreMemoryService {
  private db: ISynthesisDatabase;
  private maxTokensPerBlock: number;

  constructor(db: ISynthesisDatabase, options?: { maxTokensPerBlock?: number }) {
    this.db = db;
    this.maxTokensPerBlock = options?.maxTokensPerBlock ?? DEFAULT_MAX_TOKENS_PER_BLOCK;
  }

  /**
   * Get both core memory blocks (for injection)
   */
  async getBlocks(): Promise<CoreMemoryBlocks> {
    const blocks = await this.db.getAllCoreMemoryBlocks();

    const result: CoreMemoryBlocks = {};
    for (const block of blocks) {
      if (block.block_type === 'persona') {
        result.persona = block;
      } else if (block.block_type === 'human') {
        result.human = block;
      }
    }

    return result;
  }

  /**
   * Get a specific block by type
   */
  async getBlock(blockType: CoreMemoryBlockType): Promise<CoreMemoryBlock | null> {
    return this.db.getCoreMemoryBlock(blockType);
  }

  /**
   * Set or update a core memory block
   */
  async setBlock(
    blockType: CoreMemoryBlockType,
    content: string,
    options?: SetBlockOptions
  ): Promise<CoreMemoryBlock> {
    const maxTokens = options?.maxTokens ?? this.maxTokensPerBlock;
    let finalContent = content;

    if (options?.append) {
      const existing = await this.getBlock(blockType);
      if (existing) {
        finalContent = this.appendContent(existing.content, content);
      }
    }

    // Estimate tokens and truncate if needed
    const tokenEstimate = this.estimateTokens(finalContent);
    if (tokenEstimate > maxTokens) {
      finalContent = this.truncateToTokenLimit(finalContent, maxTokens);
      console.warn(
        `[CoreMemory] Block ${blockType} truncated from ${tokenEstimate} to ${maxTokens} tokens`
      );
    }

    const actualTokens = this.estimateTokens(finalContent);
    return this.db.setCoreMemoryBlock(blockType, finalContent, actualTokens);
  }

  /**
   * Append to a block with deduplication
   */
  async appendToBlock(
    blockType: CoreMemoryBlockType,
    content: string
  ): Promise<CoreMemoryBlock> {
    return this.setBlock(blockType, content, { append: true });
  }

  /**
   * Delete a core memory block
   */
  async deleteBlock(blockType: CoreMemoryBlockType): Promise<boolean> {
    return this.db.deleteCoreMemoryBlock(blockType);
  }

  /**
   * Format core memory blocks for injection
   */
  formatForInjection(blocks?: CoreMemoryBlocks): string {
    if (!blocks) return '';

    const parts: string[] = [];

    if (blocks.persona?.content) {
      parts.push(
        `<core_memory type="persona">\n${blocks.persona.content}\n</core_memory>`
      );
    }

    if (blocks.human?.content) {
      parts.push(
        `<core_memory type="human">\n${blocks.human.content}\n</core_memory>`
      );
    }

    if (parts.length === 0) return '';

    return parts.join('\n\n');
  }

  /**
   * Get total token count across all blocks
   */
  async getTotalTokens(): Promise<number> {
    const blocks = await this.db.getAllCoreMemoryBlocks();
    return blocks.reduce((sum, block) => sum + block.token_estimate, 0);
  }

  /**
   * Estimate token count from text
   */
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
  }

  /**
   * Append content with simple deduplication
   */
  private appendContent(existing: string, newContent: string): string {
    // Don't append if content is already present
    if (existing.includes(newContent.trim())) {
      return existing;
    }

    // Add newline separator
    return `${existing.trim()}\n\n${newContent.trim()}`;
  }

  /**
   * Truncate content to fit within token limit
   */
  private truncateToTokenLimit(content: string, maxTokens: number): string {
    const maxChars = maxTokens * CHARS_PER_TOKEN_ESTIMATE;

    if (content.length <= maxChars) {
      return content;
    }

    // Try to truncate at a sentence or paragraph boundary
    const truncated = content.slice(0, maxChars);
    const lastSentence = truncated.lastIndexOf('. ');
    const lastParagraph = truncated.lastIndexOf('\n\n');

    const cutPoint = Math.max(lastSentence, lastParagraph);

    if (cutPoint > maxChars * 0.5) {
      return truncated.slice(0, cutPoint + 1).trim() + '\n[truncated]';
    }

    return truncated.trim() + '... [truncated]';
  }
}

/**
 * Create a CoreMemoryService instance from the database
 */
export function createCoreMemoryService(
  db: ISynthesisDatabase,
  options?: { maxTokensPerBlock?: number }
): CoreMemoryService {
  return new CoreMemoryService(db, options);
}
